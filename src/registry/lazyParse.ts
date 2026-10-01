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
  const add = (name: string | undefined): void => {
    if (!name || seen.has(name) || name === 'type') {
      return;
    }
    seen.add(name);
    const symbol: MethodSymbol = {
      kind: 'Method',
      name,
      ownerName: options.ownerName,
      ownerUri: options.ownerUri,
      scope: options.scope,
      uri: options.ownerUri
    };
    registry.upsert(symbol);
    methods.push(symbol);
  };
  walkScript(program, (node) => {
    if (
      (node.type === 'Property' || node.type === 'MethodDefinition') &&
      node.key?.type === 'Identifier' &&
      !node.computed &&
      isFunctionNode(node.value ?? node)
    ) {
      add(node.key.name);
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
      add(node.left.property.name);
    }
  });
  return methods;
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
