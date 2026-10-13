/**
 * Call and table-parent edges for MCP queries.
 * These stay off the sys_id reference list.
 */

import type { CachedDependency, CachedReference, CachedSchemaField } from './cache';

/** Hard cap so one workspace cannot write an unbounded dependency list. */
export const MAX_DEPENDENCY_EDGES = 8000;

/** Identifier seen as a call or member target inside one export row. */
export interface CallCandidate {
  fromSysId?: string;
  fromTable: string;
  toName: string;
  uri: string;
  relativePath: string;
}

const SKIP_NAMES = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'function',
  'return',
  'new',
  'typeof',
  'void',
  'delete',
  'in',
  'instanceof',
  'await',
  'async',
  'case',
  'do',
  'else',
  'try',
  'with',
  'throw',
  'var',
  'let',
  'const',
  'class',
  'yield',
  'import',
  'export',
  'debugger',
  'super',
  'this'
]);

const SCRIPT_BODY =
  /<(?:script|client_script|client_script_v2|script_true|script_false)\b[^>]*>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/(?:script|client_script|client_script_v2|script_true|script_false)>/gi;

const CALLEE = /\b(?:new\s+)?([A-Za-z_$][\w$]*)\s*(?:\(|\.)/g;

/**
 * Identifiers used as calls or member targets in script bodies of `text`.
 * One candidate per row and name. Filtering to known declarations happens later.
 */
export function extractCallCandidates(
  text: string,
  records: Array<{
    table: string;
    sysId?: string;
    startOffset: number;
    action?: string;
  }>,
  location: { uri: string; relativePath: string }
): CallCandidate[] {
  const ordered = [...records]
    .filter((record) => record.action !== 'DELETE')
    .sort((a, b) => a.startOffset - b.startOffset);
  const out: CallCandidate[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < ordered.length; index++) {
    const record = ordered[index];
    const slice = text.slice(
      record.startOffset,
      ordered[index + 1]?.startOffset ?? text.length
    );
    for (const name of calleeNames(slice)) {
      const key = `${record.sysId ?? record.startOffset}|${name}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push({
        fromSysId: record.sysId,
        fromTable: record.table,
        toName: name,
        uri: location.uri,
        relativePath: location.relativePath
      });
    }
  }
  return out;
}

/**
 * Extends edges from table-definition rows, plus calls whose target is a declaration name.
 */
export function buildCachedDependencies(input: {
  schemaFields: Array<
    Pick<CachedSchemaField, 'table' | 'element' | 'extends' | 'uri' | 'relativePath'>
  >;
  calls: CallCandidate[];
  declarationNames: ReadonlySet<string>;
}): CachedDependency[] {
  const edges: CachedDependency[] = [];
  const seen = new Set<string>();
  const push = (edge: CachedDependency): void => {
    if (edges.length >= MAX_DEPENDENCY_EDGES) {
      return;
    }
    const key = `${edge.kind}|${edge.from}|${edge.to}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    edges.push(edge);
  };
  for (const field of input.schemaFields) {
    if (field.element || !field.extends) {
      continue;
    }
    push({
      kind: 'extends',
      from: field.table,
      to: field.extends,
      uri: field.uri,
      relativePath: field.relativePath
    });
  }
  for (const call of input.calls) {
    if (!call.fromSysId || !input.declarationNames.has(call.toName)) {
      continue;
    }
    push({
      kind: 'calls',
      from: call.fromSysId,
      to: call.toName,
      fromTable: call.fromTable,
      uri: call.uri,
      relativePath: call.relativePath
    });
  }
  return edges;
}

/**
 * Schema `extends` wins over stored extends edges. Stored call edges are kept.
 * Lets an older cache still answer parent-table queries after reload.
 */
export function mergeDependencyEdges(
  stored: CachedDependency[] | undefined,
  schemaFields: CachedSchemaField[]
): CachedDependency[] {
  const calls = (stored ?? []).filter((edge) => edge.kind === 'calls');
  return buildCachedDependencies({
    schemaFields,
    calls: calls.map((edge) => ({
      fromSysId: edge.from,
      fromTable: edge.fromTable ?? '',
      toName: edge.to,
      uri: edge.uri ?? '',
      relativePath: edge.relativePath ?? ''
    })),
    declarationNames: new Set(calls.map((edge) => edge.to))
  });
}

/**
 * Filtered dependency rows for one query.
 * `sys_id_ref` reads the reference list; other kinds read the dependency list.
 */
export function queryDependencies(input: {
  kind?: string;
  from?: string;
  to?: string;
  limit: number;
  references: CachedReference[];
  dependencies: CachedDependency[];
}): { dependencies: Array<Record<string, unknown>>; total: number } {
  const kind = input.kind?.trim();
  const from = input.from?.trim().toLowerCase();
  const to = input.to?.trim().toLowerCase();
  const rows: Array<Record<string, unknown>> = [];
  if (!kind || kind === 'sys_id_ref') {
    for (const edge of input.references) {
      rows.push({
        kind: 'sys_id_ref',
        from: edge.fromSysId,
        to: edge.toSysId,
        fromTable: edge.fromTable,
        element: edge.element,
        uri: edge.uri,
        relativePath: edge.relativePath
      });
    }
  }
  if (!kind || kind === 'calls' || kind === 'extends') {
    for (const edge of input.dependencies) {
      if (kind && edge.kind !== kind) {
        continue;
      }
      rows.push({
        kind: edge.kind,
        from: edge.from,
        to: edge.to,
        ...(edge.fromTable ? { fromTable: edge.fromTable } : {}),
        ...(edge.uri ? { uri: edge.uri } : {}),
        ...(edge.relativePath ? { relativePath: edge.relativePath } : {})
      });
    }
  }
  const matched = rows.filter((row) => {
    if (from && String(row.from ?? '').toLowerCase() !== from) {
      return false;
    }
    if (to && String(row.to ?? '').toLowerCase() !== to) {
      return false;
    }
    return true;
  });
  return {
    dependencies: matched.slice(0, input.limit),
    total: matched.length
  };
}

/**
 * Drop edges whose file is in `changedUris`, then append `next`.
 * `uriKey` lets the caller compare Windows URIs case-insensitively.
 */
export function replaceDependenciesForUris(
  existing: CachedDependency[],
  changedUris: Set<string>,
  next: CachedDependency[],
  uriKey: (uri: string) => string = (uri) => uri
): CachedDependency[] {
  const kept = existing.filter((edge) => {
    if (!edge.uri) {
      return true;
    }
    let key = edge.uri;
    try {
      key = uriKey(edge.uri);
    } catch {
      key = edge.uri;
    }
    return !changedUris.has(key);
  });
  return [...kept, ...next].slice(0, MAX_DEPENDENCY_EDGES);
}

function calleeNames(rowXml: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  SCRIPT_BODY.lastIndex = 0;
  let body: RegExpExecArray | null;
  while ((body = SCRIPT_BODY.exec(rowXml))) {
    const script = body[1] ?? body[2] ?? '';
    CALLEE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CALLEE.exec(script))) {
      const name = match[1];
      if (!name || SKIP_NAMES.has(name) || seen.has(name)) {
        continue;
      }
      const before = script.slice(Math.max(0, match.index - 16), match.index);
      if (/\bfunction\s*$/.test(before) || /\bcatch\s*$/.test(before)) {
        continue;
      }
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}
