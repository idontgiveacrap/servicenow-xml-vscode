/**
 * Lazy parse cache for open/active documents (Phase D).
 * XML via parseSnXml. Script bodies are parsed with espree and cached per URI.
 */

import { parseSnXml } from '../parseSnXml';
import type { ParsedDocument } from '../kinds/types';
import { Registry } from './Registry';
import type { MethodSymbol } from './types';

export interface LazyParseResult {
  version: number;
  xml?: ParsedDocument;
  /** Method names extracted from Script Include-style Class.create bodies. */
  methods?: MethodSymbol[];
}

/**
 * Parse XML for a document version, caching on the Registry.
 */
export function getOrParseXml(
  registry: Registry,
  uri: string,
  version: number,
  text: string,
  filePath?: string
): ParsedDocument {
  const entry = registry.getOrCreateParseEntry(uri, version);
  if (entry.xmlParsed && entry.version === version) {
    return entry.xmlParsed as ParsedDocument;
  }
  const parsed = parseSnXml(text, filePath);
  entry.xmlParsed = parsed;
  entry.version = version;
  return parsed;
}

interface ScriptAstNode {
  type: string;
  name?: string;
  computed?: boolean;
  key?: ScriptAstNode;
  value?: ScriptAstNode;
  left?: ScriptAstNode;
  right?: ScriptAstNode;
  object?: ScriptAstNode;
  property?: ScriptAstNode;
  body?: ScriptAstNode | ScriptAstNode[];
  params?: ScriptAstNode[];
  argument?: ScriptAstNode;
  loc?: { start: { line: number; column: number } };
  range?: [number, number];
}

/**
 * Parse a script body with espree. Returns undefined when the text is not a script.
 * The AST is the Phase D parse; callers cache it on the Registry parse entry.
 */
export function parseEmbeddedScript(code: string): ScriptAstNode | undefined {
  try {
    const espree = require('espree') as {
      parse: (source: string, options: object) => ScriptAstNode;
    };
    return espree.parse(code, {
      ecmaVersion: 2022,
      sourceType: 'script',
      loc: true,
      range: true
    });
  } catch {
    return undefined;
  }
}

/**
 * Extract method names from a Script Include script body and merge Method symbols.
 * Object-literal methods (`foo: function`) and `prototype.foo = function` assignments.
 */
export function extractAndMergeMethods(
  registry: Registry,
  options: {
    ownerName: string;
    ownerUri?: string;
    scope?: string;
    script: string;
  }
): MethodSymbol[] {
  const program = parseEmbeddedScript(options.script);
  if (options.ownerUri) {
    const entry =
      registry.getParseEntry(options.ownerUri) ??
      registry.getOrCreateParseEntry(options.ownerUri, 0);
    entry.jsAstByRegion?.set(options.ownerName, program);
  }
  if (!program) {
    return [];
  }
  const methods: MethodSymbol[] = [];
  const seen = new Set<string>();
  for (const found of listScriptMethods(program)) {
    if (seen.has(found.name)) {
      continue;
    }
    seen.add(found.name);
    const symbol: MethodSymbol = {
      kind: 'Method',
      name: found.name,
      ownerName: options.ownerName,
      ownerUri: options.ownerUri,
      scope: options.scope,
      uri: options.ownerUri,
      params: found.params,
      line: found.line
    };
    registry.upsert(symbol);
    methods.push(symbol);
  }
  return methods;
}

/** Method name, parameter names, and 1-based line. `type` is skipped. */
export interface ScriptMethodOutline {
  name: string;
  params: string[];
  line?: number;
  start: number;
  end: number;
}

/**
 * Methods in a Script Include body. Empty when the text does not parse.
 */
export function outlineScriptMethods(script: string): ScriptMethodOutline[] {
  const program = parseEmbeddedScript(script);
  if (!program) {
    return [];
  }
  return listScriptMethods(program);
}

/** Hard caps for a single method excerpt returned to an agent. */
export const METHOD_EXCERPT_LINES = 80;
export const METHOD_EXCERPT_CHARS = 2000;

/**
 * Source of one method, cut to 80 lines or 2000 characters.
 * Undefined when the name is not a method in `script`.
 */
export function methodSourceExcerpt(
  script: string,
  methodName: string
): { excerpt: string; truncated: boolean; line?: number } | undefined {
  const found = outlineScriptMethods(script).find((method) => method.name === methodName);
  if (!found) {
    return undefined;
  }
  const slice = script.slice(found.start, found.end);
  const lines = slice.split(/\r?\n/);
  let excerpt = slice;
  let truncated = false;
  if (lines.length > METHOD_EXCERPT_LINES) {
    excerpt = lines.slice(0, METHOD_EXCERPT_LINES).join('\n');
    truncated = true;
  }
  if (excerpt.length > METHOD_EXCERPT_CHARS) {
    excerpt = excerpt.slice(0, METHOD_EXCERPT_CHARS);
    truncated = true;
  }
  return { excerpt, truncated, line: found.line };
}

/**
 * Resolve a bare identifier that may be a Script Include, then lazily extract methods.
 */
export function resolveScriptIncludeReference(
  registry: Registry,
  name: string,
  readFile: (uri: string) => string | undefined
): MethodSymbol[] {
  const matches = registry.lookup(name).filter(
    (s) =>
      (s.kind === 'ScriptInclude' && s.table !== 'sys_script') ||
      s.kind === 'UiScript'
  );
  const methods: MethodSymbol[] = [];
  for (const match of matches) {
    if (!match.uri) {
      continue;
    }
    const existing = registry
      .listByKind('Method')
      .filter((m) => m.kind === 'Method' && m.ownerName === name);
    if (existing.length > 0) {
      methods.push(...(existing as MethodSymbol[]));
      continue;
    }
    const text = readFile(match.uri);
    if (!text) {
      continue;
    }
    // Pull script field body roughly from CDATA / text.
    const scriptMatch =
      /<(?:script|client_script)[^>]*>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/(?:script|client_script)>/i.exec(
        text
      );
    const script = scriptMatch?.[1] ?? scriptMatch?.[2] ?? '';
    if (!script.trim()) {
      continue;
    }
    methods.push(
      ...extractAndMergeMethods(registry, {
        ownerName: name,
        ownerUri: match.uri,
        scope: match.scope,
        script
      })
    );
  }
  return methods;
}

/**
 * Object-literal methods and `prototype.foo = function` assignments.
 * `type` is the Script Include class marker, not a callable method.
 */
function listScriptMethods(program: ScriptAstNode): ScriptMethodOutline[] {
  const methods: ScriptMethodOutline[] = [];
  const seen = new Set<string>();
  const add = (
    name: string | undefined,
    fn: ScriptAstNode | undefined,
    owner: ScriptAstNode
  ): void => {
    if (!name || seen.has(name) || name === 'type' || !fn) {
      return;
    }
    const range = owner.range ?? fn.range;
    if (!range) {
      return;
    }
    seen.add(name);
    methods.push({
      name,
      params: paramNames(fn),
      line: owner.loc?.start?.line ?? fn.loc?.start?.line,
      start: range[0],
      end: range[1]
    });
  };
  walkScript(program, (node) => {
    if (
      (node.type === 'Property' || node.type === 'MethodDefinition') &&
      node.key?.type === 'Identifier' &&
      !node.computed &&
      isFunctionNode(node.value ?? node)
    ) {
      add(node.key.name, node.value ?? node, node);
      return;
    }
    if (
      node.type === 'AssignmentExpression' &&
      node.left?.type === 'MemberExpression' &&
      !node.left.computed &&
      node.left.property?.type === 'Identifier' &&
      isFunctionNode(node.right) &&
      isPrototypeObject(node.left.object)
    ) {
      add(node.left.property.name, node.right, node);
    }
  });
  return methods;
}

function paramNames(fn: ScriptAstNode): string[] {
  const names: string[] = [];
  for (const param of fn.params ?? []) {
    if (param.type === 'Identifier' && param.name) {
      names.push(param.name);
    } else if (
      param.type === 'AssignmentPattern' &&
      param.left?.type === 'Identifier' &&
      param.left.name
    ) {
      names.push(param.left.name);
    } else if (
      param.type === 'RestElement' &&
      param.argument?.type === 'Identifier' &&
      param.argument.name
    ) {
      names.push(param.argument.name);
    }
  }
  return names;
}

function isFunctionNode(node: ScriptAstNode | undefined): boolean {
  return (
    node?.type === 'FunctionExpression' ||
    node?.type === 'FunctionDeclaration' ||
    node?.type === 'ArrowFunctionExpression'
  );
}

function isPrototypeObject(node: ScriptAstNode | undefined): boolean {
  return (
    node?.type === 'MemberExpression' &&
    !node.computed &&
    node.property?.type === 'Identifier' &&
    node.property.name === 'prototype'
  );
}

function walkScript(node: ScriptAstNode, visit: (node: ScriptAstNode) => void): void {
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isScriptNode(item)) {
          walkScript(item, visit);
        }
      }
    } else if (isScriptNode(value)) {
      walkScript(value, visit);
    }
  }
}

function isScriptNode(value: unknown): value is ScriptAstNode {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as ScriptAstNode).type === 'string'
  );
}
