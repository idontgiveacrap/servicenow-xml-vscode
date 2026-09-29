/**
 * Lazy parse cache for open/active documents (Phase D).
 * XML via parseSnXml; JS regions via espree when needed.
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

/**
 * Extract simple method names from a Script Include script body and merge
 * Method symbols into the Registry. Uses lightweight regex (no full type graph).
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
  const methods: MethodSymbol[] = [];
  // initialize: function() { … }  /  foo: function(a, b) {
  const re = /(?:^|[,{\s])(\w+)\s*:\s*function\s*\(/g;
  let match: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((match = re.exec(options.script)) !== null) {
    const name = match[1];
    if (seen.has(name) || name === 'type') {
      continue;
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
    registry.addEdge({
      fromId: `ScriptInclude:${options.scope ?? ''}:${options.ownerName}:${options.ownerUri ?? ''}`,
      toId: `Method:${options.ownerName}.${name}:${options.ownerUri ?? ''}`,
      kind: 'calls'
    });
  }
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
  const matches = registry
    .lookup(name)
    .filter((s) => s.kind === 'ScriptInclude' || s.kind === 'UiScript');
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
