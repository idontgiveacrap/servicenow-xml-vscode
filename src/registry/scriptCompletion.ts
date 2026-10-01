/**
 * Completion candidates for an embedded ServiceNow script body.
 * Callers must already know the cursor is inside a JavaScript region.
 */

import { Registry } from './Registry';
import { resolveScriptIncludeReference } from './lazyParse';
import type { FieldSymbol, ScriptProfile } from './types';

const MAX_ITEMS = 50;

export type CompletionKind =
  | 'class'
  | 'function'
  | 'field'
  | 'method'
  | 'constructor'
  | 'table';

export interface CompletionCandidate {
  label: string;
  kind: CompletionKind;
  detail?: string;
  documentation?: string;
}

interface Binding {
  kind: 'glide' | 'include';
  tableOrClass: string;
}

/**
 * Suggestions for the cursor inside `code` (a decoded script body).
 */
export function scriptCompletions(options: {
  code: string;
  cursor: number;
  profile: ScriptProfile;
  registry: Registry;
  ensureTableFields?: (table: string) => void;
  readFile?: (uri: string) => string | undefined;
}): CompletionCandidate[] {
  const prefix = linePrefix(options.code, options.cursor);
  const getValue = /([A-Za-z_$][\w$]*)\.(?:getValue|setValue)\s*\(\s*['"]([^'"]*)$/.exec(
    prefix
  );
  if (getValue) {
    const binding = bindingsBefore(options.code, options.cursor).get(getValue[1]);
    if (binding?.kind === 'glide') {
      return fieldCandidates(
        options,
        binding.tableOrClass,
        getValue[2]
      );
    }
    return [];
  }

  const glideCtor = /new\s+GlideRecord(?:Secure)?\s*\(\s*['"]([^'"]*)$/.exec(
    prefix
  );
  if (glideCtor) {
    return tableCandidates(options.registry, glideCtor[1]);
  }

  const member = /([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)?$/.exec(prefix);
  if (member) {
    const binding = bindingsBefore(options.code, options.cursor).get(member[1]);
    if (!binding) {
      return [];
    }
    const partial = member[2] ?? '';
    if (binding.kind === 'glide') {
      return fieldCandidates(options, binding.tableOrClass, partial);
    }
    return methodCandidates(options, binding.tableOrClass, partial);
  }

  const newer = /new\s+([A-Za-z_$][\w$]*)$/.exec(prefix);
  if (newer) {
    return constructorCandidates(options, newer[1]);
  }

  const bare = /(?:^|[^.\w$])([A-Za-z_$][\w$]*)$/.exec(prefix);
  if (bare && bare[1].length > 0) {
    return bareCandidates(options, bare[1]);
  }
  return [];
}

/**
 * Last `name = new GlideRecord('table')` or `name = new SomeInclude(` before the cursor.
 */
function bindingsBefore(code: string, cursor: number): Map<string, Binding> {
  const slice = code.slice(0, cursor);
  const out = new Map<string, Binding>();
  const glide =
    /(?:^|[^\w$])([A-Za-z_$][\w$]*)\s*=\s*new\s+GlideRecord(?:Secure)?\s*\(\s*['"]([A-Za-z0-9_]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = glide.exec(slice)) !== null) {
    out.set(match[1], { kind: 'glide', tableOrClass: match[2] });
  }
  const include =
    /(?:^|[^\w$])([A-Za-z_$][\w$]*)\s*=\s*new\s+([A-Za-z_$][\w$]*)\s*\(/g;
  while ((match = include.exec(slice)) !== null) {
    if (match[2] === 'GlideRecord' || match[2] === 'GlideRecordSecure') {
      continue;
    }
    out.set(match[1], { kind: 'include', tableOrClass: match[2] });
  }
  return out;
}

function fieldCandidates(
  options: {
    registry: Registry;
    ensureTableFields?: (table: string) => void;
  },
  table: string,
  partial: string
): CompletionCandidate[] {
  options.ensureTableFields?.(table);
  const want = partial.toLowerCase();
  const items: CompletionCandidate[] = [];
  for (const field of options.registry.listFieldsForTable(table)) {
    if (field.kind !== 'Field' || !field.element) {
      continue;
    }
    if (want && !field.element.toLowerCase().startsWith(want)) {
      continue;
    }
    items.push(fieldItem(field));
    if (items.length >= MAX_ITEMS) {
      break;
    }
  }
  return items;
}

function fieldItem(field: FieldSymbol): CompletionCandidate {
  return {
    label: field.element,
    kind: 'field',
    detail:
      [field.label, field.internalType || field.reference].filter(Boolean).join(' ') ||
      'field'
  };
}

function tableCandidates(registry: Registry, partial: string): CompletionCandidate[] {
  const want = partial.toLowerCase();
  const items: CompletionCandidate[] = [];
  for (const table of registry.listTables()) {
    if (want && !table.name.toLowerCase().startsWith(want)) {
      continue;
    }
    items.push({
      label: table.name,
      kind: 'table',
      detail: table.label ?? 'table'
    });
    if (items.length >= MAX_ITEMS) {
      break;
    }
  }
  return items;
}

function methodCandidates(
  options: {
    registry: Registry;
    readFile?: (uri: string) => string | undefined;
  },
  className: string,
  partial: string
): CompletionCandidate[] {
  if (!options.readFile) {
    return [];
  }
  const want = partial.toLowerCase();
  const methods = resolveScriptIncludeReference(
    options.registry,
    className,
    options.readFile
  );
  const items: CompletionCandidate[] = [];
  for (const method of methods) {
    if (method.ownerName !== className) {
      continue;
    }
    if (want && !method.name.toLowerCase().startsWith(want)) {
      continue;
    }
    items.push({
      label: method.name,
      kind: 'method',
      detail: className
    });
    if (items.length >= MAX_ITEMS) {
      break;
    }
  }
  return items;
}

function constructorCandidates(
  options: { registry: Registry; profile: ScriptProfile },
  partial: string
): CompletionCandidate[] {
  const want = partial.toLowerCase();
  const items: CompletionCandidate[] = [];
  for (const symbol of options.registry.listPlatformGlobals(options.profile)) {
    if (want && !symbol.name.toLowerCase().startsWith(want)) {
      continue;
    }
    items.push({
      label: symbol.name,
      kind: 'constructor',
      detail: symbol.kind,
      documentation: symbol.documentation
    });
    if (items.length >= MAX_ITEMS) {
      return items;
    }
  }
  for (const symbol of options.registry.listWorkspaceDeclarations()) {
    if (symbol.profile !== options.profile) {
      continue;
    }
    if (symbol.kind === 'ScriptInclude' && symbol.table === 'sys_script') {
      continue;
    }
    if (want && !symbol.name.toLowerCase().startsWith(want)) {
      continue;
    }
    items.push({
      label: symbol.name,
      kind: 'class',
      detail: symbol.kind,
      documentation: symbol.documentation
    });
    if (items.length >= MAX_ITEMS) {
      break;
    }
  }
  return items;
}

function bareCandidates(
  options: { registry: Registry; profile: ScriptProfile },
  partial: string
): CompletionCandidate[] {
  const want = partial.toLowerCase();
  const items: CompletionCandidate[] = [];
  for (const symbol of [
    ...options.registry.listWorkspaceDeclarations(),
    ...options.registry.listPlatformGlobals(options.profile)
  ]) {
    if (
      (symbol.kind === 'ScriptInclude' || symbol.kind === 'UiScript') &&
      symbol.profile !== options.profile
    ) {
      continue;
    }
    if (want && !symbol.name.toLowerCase().startsWith(want)) {
      continue;
    }
    const kind: CompletionKind =
      symbol.kind === 'ScriptInclude' && symbol.table === 'sys_script'
        ? 'function'
        : symbol.kind === 'ScriptInclude'
          ? 'class'
          : symbol.kind === 'UiScript'
            ? 'function'
            : 'constructor';
    items.push({
      label: symbol.name,
      kind,
      detail: symbol.kind === 'ScriptInclude' && symbol.table === 'sys_script'
        ? 'business rule'
        : symbol.kind,
      documentation: symbol.documentation
    });
    if (items.length >= MAX_ITEMS) {
      break;
    }
  }
  return items;
}

function linePrefix(code: string, cursor: number): string {
  const end = Math.max(0, Math.min(cursor, code.length));
  const start = code.lastIndexOf('\n', end - 1) + 1;
  return code.slice(start, end);
}
