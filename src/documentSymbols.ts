/**
 * ServiceNow export document outline (vscode-free). Used by DocumentSymbolProvider
 * and available to a future language server.
 */

import type { ParsedDocument, RecordRow } from './kinds/types';
import { parseEmbeddedScript } from './registry/lazyParse';
import {
  decodeXmlEntities,
  offsetToPosition,
  parseSnXml,
  scanDirectChildElements
} from './parseSnXml';
import { isJsonFieldName } from './registry/fieldKinds';
import { listJsonFields, listScriptFields } from './scriptHits';

export type OutlineSymbolKind =
  | 'record'
  | 'field'
  | 'function'
  | 'class'
  | 'method'
  | 'jsonProperty';

/** One node in the export outline tree. Offsets are UTF-16 in the host XML file. */
export interface DocumentOutlineSymbol {
  name: string;
  detail?: string;
  kind: OutlineSymbolKind;
  rangeStart: number;
  rangeEnd: number;
  selectionStart: number;
  selectionEnd: number;
  children: DocumentOutlineSymbol[];
}

/**
 * Build an outline tree for a ServiceNow XML export, or undefined for non-export XML.
 */
export function buildDocumentOutline(
  text: string,
  filePath?: string
): DocumentOutlineSymbol[] | undefined {
  const doc = parseSnXml(text, filePath);
  if (doc.rows.length === 0) {
    return undefined;
  }
  const scriptHits = listScriptFields(doc);
  const jsonHits = listJsonFields(doc);
  return doc.rows.map((row) =>
    outlineRecordRow(text, doc, row, scriptHits, jsonHits)
  );
}

function outlineRecordRow(
  text: string,
  doc: ParsedDocument,
  row: RecordRow,
  scriptHits: ReturnType<typeof listScriptFields>,
  jsonHits: ReturnType<typeof listJsonFields>
): DocumentOutlineSymbol {
  const rowXml = text.slice(row.startOffset, row.endOffset);
  const display =
    row.tableName +
    (row.action ? ` (${row.action})` : '') +
    (row.sysId ? ` · ${row.sysId.slice(0, 8)}…` : '');
  const record: DocumentOutlineSymbol = {
    name: row.tableName,
    detail: display,
    kind: 'record',
    rangeStart: row.startOffset,
    rangeEnd: row.endOffset,
    selectionStart: row.startOffset,
    selectionEnd: row.startOffset + row.tableName.length + 1,
    children: []
  };

  for (const child of scanDirectChildElements(rowXml)) {
    const fieldStart = row.startOffset + child.start;
    const fieldEnd = elementEndOffset(rowXml, child);
    const absoluteEnd = row.startOffset + fieldEnd;
    const fieldName = child.name;
    const fieldNode: DocumentOutlineSymbol = {
      name: fieldName,
      kind: 'field',
      rangeStart: fieldStart,
      rangeEnd: absoluteEnd,
      selectionStart: fieldStart,
      selectionEnd: fieldStart + fieldName.length + 2,
      children: []
    };

    if (fieldName.toLowerCase() === 'payload') {
      fieldNode.children.push(
        ...outlinePayloadChildren(text, row.startOffset, child)
      );
    }

    const scriptHit = scriptHits.find(
      (hit) =>
        hit.hostStart >= row.startOffset &&
        hit.hostEnd <= row.endOffset &&
        hit.fieldName.toLowerCase() === fieldName.toLowerCase()
    );
    if (scriptHit) {
      fieldNode.children.push(...outlineJavaScript(scriptHit.code, text, scriptHit));
    }

    const jsonHit = jsonHits.find(
      (hit) =>
        hit.hostStart >= row.startOffset &&
        hit.hostEnd <= row.endOffset &&
        hit.fieldName.toLowerCase() === fieldName.toLowerCase()
    );
    if (jsonHit) {
      fieldNode.children.push(
        ...outlineJsonProperties(jsonHit.code, jsonHit.hostStart, text, jsonHit)
      );
    } else if (
      isJsonFieldName(fieldName) ||
      looksLikeJson(fieldNode, rowXml, child)
    ) {
      const body = decodeFieldBody(rowXml, child);
      fieldNode.children.push(
        ...outlineJsonProperties(body, fieldStart + child.bodyStart, text, {
          hostStart: fieldStart,
          hostEnd: absoluteEnd,
          code: body
        })
      );
    }

    record.children.push(fieldNode);
  }

  return record;
}

function outlinePayloadChildren(
  text: string,
  rowStart: number,
  payload: { bodyStart: number; bodyEnd: number }
): DocumentOutlineSymbol[] {
  const rowXml = text.slice(rowStart);
  const body = rowXml.slice(payload.bodyStart, payload.bodyEnd);
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/s.exec(body.trim());
  const inner = (cdata ? cdata[1] : decodeXmlEntities(body)).trim();
  if (!inner.includes('<')) {
    return [];
  }
  const innerOutline = buildDocumentOutline(inner);
  if (!innerOutline) {
    return [];
  }
  let base = rowStart + payload.bodyStart;
  if (cdata) {
    const open = body.indexOf('<![CDATA[');
    if (open >= 0) {
      base = rowStart + payload.bodyStart + open + '<![CDATA['.length;
    }
  }
  for (const node of innerOutline) {
    shiftOutline(node, base);
  }
  return innerOutline;
}

function shiftOutline(node: DocumentOutlineSymbol, delta: number): void {
  node.rangeStart += delta;
  node.rangeEnd += delta;
  node.selectionStart += delta;
  node.selectionEnd += delta;
  for (const child of node.children) {
    shiftOutline(child, delta);
  }
}

function elementEndOffset(
  rowXml: string,
  child: { name: string; bodyEnd: number }
): number {
  const tail = rowXml.slice(child.bodyEnd);
  const close = new RegExp(`</${escapeRegExp(child.name)}\\s*>`, 'i').exec(tail);
  if (!close) {
    return child.bodyEnd;
  }
  return child.bodyEnd + close.index + close[0].length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeFieldBody(
  rowXml: string,
  child: { bodyStart: number; bodyEnd: number }
): string {
  const body = rowXml.slice(child.bodyStart, child.bodyEnd);
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/s.exec(body.trim());
  return cdata ? cdata[1] : decodeXmlEntities(body);
}

function looksLikeJson(
  _fieldNode: DocumentOutlineSymbol,
  rowXml: string,
  child: { bodyStart: number; bodyEnd: number }
): boolean {
  const body = decodeFieldBody(rowXml, child).trim();
  return body.startsWith('{') || body.startsWith('[');
}

function outlineJavaScript(
  code: string,
  hostText: string,
  hit: { hostStart: number; hostEnd: number; code: string }
): DocumentOutlineSymbol[] {
  const program = parseEmbeddedScript(code) as AstNode | undefined;
  if (!program) {
    return [];
  }
  const out: DocumentOutlineSymbol[] = [];
  walkScript(program, (node) => {
    const id = node.id as AstNode | undefined;
    if (node.type === 'FunctionDeclaration' && id?.type === 'Identifier' && id.name) {
      pushScriptSymbol(out, id.name, node, code, hit, hostText, 'function');
    }
    if (node.type === 'ClassDeclaration' && id?.type === 'Identifier' && id.name) {
      pushScriptSymbol(out, id.name, node, code, hit, hostText, 'class');
    }
    const key = node.key as AstNode | undefined;
    if (
      (node.type === 'Property' || node.type === 'MethodDefinition') &&
      key?.type === 'Identifier' &&
      key.name &&
      key.name !== 'type'
    ) {
      pushScriptSymbol(out, key.name, node, code, hit, hostText, 'method');
    }
  });
  return out;
}

interface AstNode {
  type?: string;
  name?: string;
  id?: AstNode;
  key?: AstNode;
  range?: [number, number];
  [key: string]: unknown;
}

function pushScriptSymbol(
  out: DocumentOutlineSymbol[],
  name: string,
  node: AstNode,
  code: string,
  hit: { hostStart: number; hostEnd: number; code: string },
  hostText: string,
  kind: OutlineSymbolKind
): void {
  const range = node.range;
  if (!range) {
    return;
  }
  const start = mapCodeOffsetToHost(hostText, hit, range[0]);
  const end = mapCodeOffsetToHost(hostText, hit, range[1]);
  if (start === undefined || end === undefined) {
    return;
  }
  const nameOffset = code.indexOf(name, range[0]);
  const selStart =
    nameOffset >= 0
      ? mapCodeOffsetToHost(hostText, hit, nameOffset) ?? start
      : start;
  out.push({
    name,
    kind,
    rangeStart: start,
    rangeEnd: end,
    selectionStart: selStart,
    selectionEnd: selStart + name.length,
    children: []
  });
}

function walkScript(node: AstNode, visit: (node: AstNode) => void): void {
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range') {
      continue;
    }
    const value = node[key];
    if (!value) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object' && 'type' in item) {
          walkScript(item as AstNode, visit);
        }
      }
    } else if (typeof value === 'object' && value !== null && 'type' in value) {
      walkScript(value as AstNode, visit);
    }
  }
}

function outlineJsonProperties(
  jsonText: string,
  _baseOffset: number,
  hostText: string,
  hit: { hostStart: number; hostEnd: number; code: string }
): DocumentOutlineSymbol[] {
  const trimmed = jsonText.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return [];
  }
  try {
    JSON.parse(trimmed);
  } catch {
    return [];
  }
  const out: DocumentOutlineSymbol[] = [];
  const keyRe = /"((?:\\.|[^"\\])*)"\s*:/g;
  let match: RegExpExecArray | null;
  while ((match = keyRe.exec(trimmed))) {
    const rawName = match[1].replace(/\\"/g, '"');
    const keyStartInTrimmed = match.index + 1;
    const start = mapCodeOffsetToHost(hostText, hit, keyStartInTrimmed);
    const end = mapCodeOffsetToHost(
      hostText,
      hit,
      keyStartInTrimmed + rawName.length
    );
    if (start === undefined || end === undefined) {
      continue;
    }
    out.push({
      name: rawName,
      kind: 'jsonProperty',
      rangeStart: start,
      rangeEnd: end,
      selectionStart: start,
      selectionEnd: end,
      children: []
    });
  }
  return out;
}

function mapCodeOffsetToHost(
  text: string,
  hit: { hostStart: number; hostEnd: number; code: string },
  codeOffset: number
): number | undefined {
  const clamped = Math.min(Math.max(codeOffset, 0), hit.code.length);
  const hostSlice = text.slice(hit.hostStart, hit.hostEnd);
  if (hostSlice === hit.code) {
    return hit.hostStart + clamped;
  }
  let hostIndex = 0;
  let codeIndex = 0;
  while (hostIndex < hostSlice.length && codeIndex < clamped) {
    if (hostSlice[hostIndex] === hit.code[codeIndex]) {
      hostIndex++;
      codeIndex++;
      continue;
    }
    if (hostSlice.startsWith('&lt;', hostIndex)) {
      hostIndex += 4;
      if (hit.code[codeIndex] === '<') {
        codeIndex++;
      }
      continue;
    }
    if (hostSlice.startsWith('&gt;', hostIndex)) {
      hostIndex += 4;
      if (hit.code[codeIndex] === '>') {
        codeIndex++;
      }
      continue;
    }
    if (hostSlice.startsWith('&amp;', hostIndex)) {
      hostIndex += 5;
      if (hit.code[codeIndex] === '&') {
        codeIndex++;
      }
      continue;
    }
    hostIndex++;
  }
  return hit.hostStart + hostIndex;
}

/** Convert outline offsets to 0-based line/character (for tests). */
export function outlinePosition(
  text: string,
  offset: number
): { line: number; character: number } {
  const pos = offsetToPosition(text, offset);
  return { line: pos.line, character: pos.character };
}
