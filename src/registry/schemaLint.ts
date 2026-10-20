/**
 * Schema-aware diagnostics for GlideRecord / GlideAggregate / … table arguments.
 * Walks an espree AST and checks names against Registry table and field symbols.
 */

import type { Linter as LinterType } from 'eslint';
import { parseEmbeddedScript } from './lazyParse';
import { Registry } from './Registry';
import type { DictionaryFieldIndex } from './schemaLoader';

const TABLE_CONSTRUCTORS = new Set([
  'GlideRecord',
  'GlideRecordSecure',
  'GlideAggregate',
  'GlideQuery',
  'TableUtils'
]);

export interface SchemaLintMessage {
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  severity: 1 | 2;
}

interface AstNode {
  type: string;
  loc?: { start: { line: number; column: number } };
  name?: string;
  value?: unknown;
  computed?: boolean;
  callee?: AstNode;
  arguments?: AstNode[];
  object?: AstNode;
  property?: AstNode;
  left?: AstNode;
  right?: AstNode;
  id?: AstNode;
  init?: AstNode | null;
}

/**
 * Run schema checks on a script string.
 * Unparseable scripts produce no schema messages; ESLint reports the syntax error.
 */
export function lintSchemaTableArgs(
  code: string,
  registry: Registry,
  fieldIndex?: DictionaryFieldIndex
): SchemaLintMessage[] {
  const program = parseEmbeddedScript(code);
  if (!program) {
    return [];
  }
  const messages: SchemaLintMessage[] = [];
  const bindings = new Map<string, string>();
  walkAst(program, (node) => rememberGlideBinding(node, bindings));
  walkAst(program, (node) => {
    checkTableConstructor(node, registry, fieldIndex, messages);
    checkTableCall(node, registry, fieldIndex, bindings, messages);
  });
  return messages;
}

function rememberGlideBinding(node: AstNode, bindings: Map<string, string>): void {
  let id: AstNode | undefined;
  let init: AstNode | null | undefined;
  if (node.type === 'VariableDeclarator') {
    id = node.id;
    init = node.init;
  } else if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier') {
    id = node.left;
    init = node.right;
  } else {
    return;
  }
  if (!id || id.type !== 'Identifier' || !id.name || !init || init.type !== 'NewExpression') {
    return;
  }
  const ctor = identifierName(init.callee);
  if (ctor !== 'GlideRecord' && ctor !== 'GlideRecordSecure') {
    return;
  }
  const table = stringArg(init.arguments?.[0]);
  if (table) {
    bindings.set(id.name, table);
  }
}

function checkTableConstructor(
  node: AstNode,
  registry: Registry,
  fieldIndex: DictionaryFieldIndex | undefined,
  messages: SchemaLintMessage[]
): void {
  if (node.type !== 'NewExpression') {
    return;
  }
  const ctor = identifierName(node.callee);
  if (!ctor || !TABLE_CONSTRUCTORS.has(ctor)) {
    return;
  }
  const arg = node.arguments?.[0];
  const table = stringArg(arg);
  if (!table || isKnownTable(registry, fieldIndex, table)) {
    return;
  }
  messages.push({
    ...lineCol(arg ?? node),
    message: `Unknown table '${table}' for ${ctor}.`,
    severity: 1
  });
}

function checkTableCall(
  node: AstNode,
  registry: Registry,
  fieldIndex: DictionaryFieldIndex | undefined,
  bindings: Map<string, string>,
  messages: SchemaLintMessage[]
): void {
  if (node.type !== 'CallExpression' || node.callee?.type !== 'MemberExpression') {
    return;
  }
  const callee = node.callee;
  if (callee.computed) {
    return;
  }
  const objectName = identifierName(callee.object);
  const property = identifierName(callee.property);
  if (objectName === 'TableUtils' && property === 'tableExists') {
    const arg = node.arguments?.[0];
    const table = stringArg(arg);
    if (table && !isKnownTable(registry, fieldIndex, table)) {
      messages.push({
        ...lineCol(arg ?? node),
        message: `Unknown table '${table}' for TableUtils.tableExists.`,
        severity: 1
      });
    }
    return;
  }
  if (
    objectName === 'gs' &&
    (property === 'eventQueue' || property === 'eventQueueScheduled')
  ) {
    const arg = node.arguments?.[1];
    const table = stringArg(arg);
    if (table && !isKnownTable(registry, fieldIndex, table)) {
      messages.push({
        ...lineCol(arg ?? node),
        message: `Unknown table '${table}' for gs.eventQueue.`,
        severity: 1
      });
    }
    return;
  }
  if (property !== 'addQuery' || !fieldIndex || callee.object?.type !== 'Identifier') {
    return;
  }
  const binding = callee.object.name;
  if (!binding) {
    return;
  }
  const table = bindings.get(binding);
  if (!table || !isKnownTable(registry, fieldIndex, table)) {
    return;
  }
  fieldIndex.ensureTableFields(table);
  const arg = node.arguments?.[0];
  const field = stringArg(arg);
  if (!field || registry.getField(table, field)) {
    return;
  }
  messages.push({
    ...lineCol(arg ?? node),
    message: `Unknown field '${field}' on table '${table}'.`,
    severity: 1
  });
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

function identifierName(node: AstNode | undefined): string | undefined {
  if (!node) {
    return undefined;
  }
  if (node.type === 'Identifier' && node.name) {
    return node.name;
  }
  return undefined;
}

function stringArg(node: AstNode | undefined): string | undefined {
  if (!node || node.type !== 'Literal' || typeof node.value !== 'string') {
    return undefined;
  }
  return node.value;
}

function lineCol(node: AstNode): { line: number; column: number } {
  const start = node.loc?.start;
  return {
    line: start?.line ?? 1,
    column: (start?.column ?? 0) + 1
  };
}

/**
 * Visit `node` then its child nodes. Espree nodes have no parent links.
 */
function walkAst(node: AstNode, visit: (node: AstNode) => void): void {
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isAstNode(item)) {
          walkAst(item, visit);
        }
      }
    } else if (isAstNode(value)) {
      walkAst(value, visit);
    }
  }
}

function isAstNode(value: unknown): value is AstNode {
  return !!value && typeof value === 'object' && typeof (value as AstNode).type === 'string';
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
