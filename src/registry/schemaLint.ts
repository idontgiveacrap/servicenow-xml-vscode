/**
 * Schema-aware diagnostics for GlideRecord / GlideAggregate / … table arguments.
 * Uses Registry table symbols (and lazy field index when checking addQuery).
 */

import type { Linter as LinterType } from 'eslint';
import { Registry } from './Registry';
import type { DictionaryFieldIndex } from './schemaLoader';

export interface SchemaLintMessage {
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  severity: 1 | 2;
}

/**
 * Run schema checks on a script string (regex-based; no retained AST).
 */
export function lintSchemaTableArgs(
  code: string,
  registry: Registry,
  fieldIndex?: DictionaryFieldIndex
): SchemaLintMessage[] {
  const messages: SchemaLintMessage[] = [];
  const ctorRe =
    /\bnew\s+(GlideRecordSecure|GlideRecord|GlideAggregate|GlideQuery)\s*\(\s*(['"])([^'"]+)\2/g;
  let match: RegExpExecArray | null;
  while ((match = ctorRe.exec(code)) !== null) {
    const table = match[3];
    if (!isKnownTable(registry, fieldIndex, table)) {
      const lineCol = offsetToLineCol(code, match.index + match[0].indexOf(table));
      messages.push({
        ...lineCol,
        message: `Unknown table '${table}' for ${match[1]}.`,
        severity: 1
      });
    }
  }

  const tableExistsRe = /\bTableUtils\.tableExists\s*\(\s*(['"])([^'"]+)\1/g;
  while ((match = tableExistsRe.exec(code)) !== null) {
    const table = match[2];
    if (!isKnownTable(registry, fieldIndex, table)) {
      const lineCol = offsetToLineCol(code, match.index);
      messages.push({
        ...lineCol,
        message: `Unknown table '${table}' for TableUtils.tableExists.`,
        severity: 1
      });
    }
  }

  const eventQueueRe =
    /\bgs\.eventQueue(?:Scheduled)?\s*\(\s*(['"])[^'"]+\1\s*,\s*(['"])([^'"]+)\2/g;
  while ((match = eventQueueRe.exec(code)) !== null) {
    const table = match[3];
    if (!isKnownTable(registry, fieldIndex, table)) {
      const lineCol = offsetToLineCol(code, match.index);
      messages.push({
        ...lineCol,
        message: `Unknown table '${table}' for gs.eventQueue.`,
        severity: 1
      });
    }
  }

  const grAssignRe =
    /\b(?:var|let|const)?\s*(\w+)\s*=\s*new\s+GlideRecord(?:Secure)?\s*\(\s*(['"])([^'"]+)\2\s*\)/g;
  const bindings = new Map<string, string>();
  while ((match = grAssignRe.exec(code)) !== null) {
    bindings.set(match[1], match[3]);
  }
  if (fieldIndex && bindings.size > 0) {
    const addQueryRe = /\b(\w+)\.addQuery\s*\(\s*(['"])([^'"]+)\2/g;
    while ((match = addQueryRe.exec(code)) !== null) {
      const table = bindings.get(match[1]);
      if (!table || !isKnownTable(registry, fieldIndex, table)) {
        continue;
      }
      fieldIndex.ensureTableFields(table);
      const field = match[3];
      if (!registry.getField(table, field)) {
        const lineCol = offsetToLineCol(code, match.index);
        messages.push({
          ...lineCol,
          message: `Unknown field '${field}' on table '${table}'.`,
          severity: 1
        });
      }
    }
  }

  return messages;
}

function isKnownTable(
  registry: Registry,
  fieldIndex: DictionaryFieldIndex | undefined,
  table: string
): boolean {
  if (registry.getTable(table)) {
    return true;
  }
  if (fieldIndex?.hasTable(table)) {
    return true;
  }
  return false;
}

function offsetToLineCol(
  code: string,
  offset: number
): { line: number; column: number } {
  let line = 1;
  let column = 0;
  for (let i = 0; i < offset && i < code.length; i++) {
    if (code[i] === '\n') {
      line++;
      column = 0;
    } else {
      column++;
    }
  }
  return { line, column: column + 1 };
}

/**
 * Map schema messages into ESLint-like shapes for jsLint remapping.
 */
export function schemaMessagesToEslint(
  messages: SchemaLintMessage[]
): LinterType.LintMessage[] {
  return messages.map((m) => ({
    ruleId: 'servicenow/unknown-table-or-field',
    severity: m.severity,
    message: m.message,
    line: m.line,
    column: m.column,
    endLine: m.endLine,
    endColumn: m.endColumn
  }));
}
