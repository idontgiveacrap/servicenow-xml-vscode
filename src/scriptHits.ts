/**
 * Shared script discovery and encode-back.
 *
 * Lint and Format Document use listScriptFields (script-typed XML elements,
 * including those nested in a customer-update payload). The temp editor uses
 * scriptAt, which also returns JSON-string / javascript() hits.
 */

import type { EncodingLayer } from './embedded/layers';
import {
  detectEmbeddedScriptAtOffset,
  encodeThroughLayers
} from './embedded/layers';
import { detectJsonStringAtOffset } from './jsonStringEditor/detect';
import { buildDecodedToRawMap } from './jsonStringEditor/escape';
import type { EmbeddedFieldHit, ParsedDocument, RecordRow } from './kinds/types';
import { detectSysAppMetadata, JavaScriptSupport } from './javascriptSupport';
import {
  decodeXmlEntities,
  isPrimaryAction,
  isScriptTypedField,
  offsetToPosition,
  parseSnXml,
  scanDirectChildElements
} from './parseSnXml';
import {
  resolveRowTechnicalScope,
  rowDeclarationName
} from './scriptDeclarations';
import { resolveScriptProfile } from './scriptProfile';

export type ScriptHitRole = 'scriptField' | 'jsonString';

export interface ScriptHit {
  code: string;
  hostStart: number;
  hostEnd: number;
  layers: EncodingLayer[];
  indent: string;
  role: ScriptHitRole;
  tableName: string;
  fieldName: string;
  action: string;
  profile: 'server' | 'client';
  javascriptSupport: JavaScriptSupport;
  callerScope?: string;
  /** Global this record itself declares, when it is a declaration table row. */
  ownDeclarationName?: string;
  /** Dotted JSON path when the script is a JSON string value. */
  keyPath?: string;
}

export interface ScriptHitOptions {
  includeDelete?: boolean;
  javascriptSupport?: JavaScriptSupport;
  workspaceAppSysId?: string;
  workspaceAppScope?: string;
}

/**
 * Script-typed XML elements on host rows and inside sys_update_xml payloads.
 */
export function listScriptFields(
  doc: ParsedDocument,
  options?: ScriptHitOptions
): ScriptHit[] {
  return collectScriptFieldHits(doc, options);
}

/**
 * All script-typed fields plus, when offset-based, JSON-string hits via scriptAt.
 */
export function listHits(
  doc: ParsedDocument,
  options?: ScriptHitOptions
): ScriptHit[] {
  return collectScriptFieldHits(doc, options);
}

/**
 * Innermost hit covering `absoluteOffset`. Script-typed fields win by range
 * (field identity). Otherwise the layer walk / JSON-string eligibility rules.
 */
export function scriptAt(
  text: string,
  absoluteOffset: number,
  options?: ScriptHitOptions & {
    hostPath?: string;
    hostVersion?: number;
    stableHostId?: string;
  }
): ScriptHit | null {
  const doc = parseSnXml(text, options?.hostPath);
  const javascriptSupport = options?.javascriptSupport ?? 'ES5';
  const fields = collectScriptFieldHits(doc, options);
  const covering = fields.filter(
    (h) => absoluteOffset >= h.hostStart && absoluteOffset < h.hostEnd
  );
  if (covering.length > 0) {
    return covering.reduce((best, hit) =>
      hit.hostEnd - hit.hostStart < best.hostEnd - best.hostStart ? hit : best
    );
  }

  const layered = detectEmbeddedScriptAtOffset(text, absoluteOffset);
  if (layered) {
    const role: ScriptHitRole = isScriptTypedField(
      layered.tableName,
      layered.fieldName
    )
      ? 'scriptField'
      : 'jsonString';
    return {
      code: layered.code,
      hostStart: layered.absoluteStart,
      hostEnd: layered.absoluteEnd,
      layers: layered.layers,
      indent: detectCommonIndent(layered.code),
      role,
      tableName: layered.tableName,
      fieldName: layered.fieldName,
      action: '',
      profile: layered.profile,
      javascriptSupport,
      keyPath: layered.keyPath
    };
  }

  const json = detectJsonStringAtOffset(
    text,
    absoluteOffset,
    options?.hostPath ?? '',
    options?.hostVersion ?? 0,
    options?.stableHostId
  );
  if (!json) {
    return null;
  }
  const layers = json.layers ?? layersForJsonField(json.field, json.hadJavascriptWrapper);
  return {
    code: json.editorCode,
    hostStart: json.absoluteStart,
    hostEnd: json.absoluteEnd,
    layers,
    indent: detectCommonIndent(json.editorCode),
    role: 'jsonString',
    tableName: json.tableName,
    fieldName: json.fieldName,
    action: '',
    profile: 'server',
    javascriptSupport,
    keyPath: json.keyPath
  };
}

/**
 * Re-apply the hit's encoding stack to replacement source.
 */
export function encodeHit(
  hit: ScriptHit,
  newCode: string
): { ok: true; text: string } | { ok: false; error: string } {
  return encodeThroughLayers(newCode, hit.layers);
}

/**
 * Convert a script-typed hit into the lint region shape.
 */
export function scriptHitToRegion(
  doc: ParsedDocument,
  hit: ScriptHit
): {
  fieldName: string;
  language: 'javascript';
  isCdata: boolean;
  bodyStartOffset: number;
  bodyEndOffset: number;
  bodyStartLine: number;
  bodyStartCharacter: number;
  content: string;
  decodedContent: string;
  tableName: string;
  action: string;
  profile: 'server' | 'client';
  javascriptSupport: JavaScriptSupport;
  callerScope?: string;
  ownDeclarationName?: string;
} {
  const pos = offsetToPosition(doc.text, hit.hostStart);
  const innermost = [...hit.layers]
    .reverse()
    .find((l) => l.kind === 'cdata' || l.kind === 'xmlText');
  return {
    fieldName: hit.fieldName,
    language: 'javascript',
    isCdata: innermost?.kind === 'cdata',
    bodyStartOffset: hit.hostStart,
    bodyEndOffset: hit.hostEnd,
    bodyStartLine: pos.line,
    bodyStartCharacter: pos.character,
    content: doc.text.slice(hit.hostStart, hit.hostEnd),
    decodedContent: hit.code,
    tableName: hit.tableName,
    action: hit.action,
    profile: hit.profile,
    javascriptSupport: hit.javascriptSupport,
    callerScope: hit.callerScope,
    ownDeclarationName: hit.ownDeclarationName
  };
}

/** Shared indent of non-empty lines (spaces or tabs). */
export function detectCommonIndent(code: string): string {
  let indent: string | undefined;
  for (const line of code.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const ws = /^[ \t]*/.exec(line)?.[0] ?? '';
    if (indent === undefined || ws.length < indent.length) {
      indent = ws;
    }
    if (indent.length === 0) {
      return '';
    }
  }
  return indent ?? '';
}

/** Remove a common indent prefix from each line that has it. */
export function stripIndent(code: string, indent: string): string {
  if (!indent) {
    return code;
  }
  return code
    .split('\n')
    .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
    .join('\n');
}

/** Prefix each non-empty line with `indent`. */
export function restoreIndent(code: string, indent: string): string {
  if (!indent) {
    return code;
  }
  return code
    .split('\n')
    .map((line) => (line.length === 0 ? line : indent + line))
    .join('\n');
}

function collectScriptFieldHits(
  doc: ParsedDocument,
  options?: ScriptHitOptions
): ScriptHit[] {
  const includeDelete = options?.includeDelete === true;
  const javascriptSupport = options?.javascriptSupport ?? 'ES5';
  const documentApp = detectSysAppMetadata(doc.text);
  const scopeApps = {
    workspaceAppSysId: options?.workspaceAppSysId,
    workspaceAppScope: options?.workspaceAppScope,
    documentAppSysId: documentApp?.sysId,
    documentAppScope: documentApp?.scope
  };
  const hits: ScriptHit[] = [];

  for (const row of doc.rows) {
    if (!isPrimaryAction(row.action)) {
      continue;
    }
    if (row.action === 'DELETE' && !includeDelete) {
      continue;
    }
    const rowXml = doc.text.slice(row.startOffset, row.endOffset);
    const callerScope = resolveRowTechnicalScope(
      rowXml,
      row.sysScopeValue,
      scopeApps
    );
    const ownDeclarationName = rowDeclarationName(
      row.tableName.toLowerCase(),
      rowXml
    );
    for (const field of row.embeddedFields) {
      if (field.language !== 'javascript' || !field.decodedContent.trim()) {
        continue;
      }
      hits.push(
        fieldToHit(
          field,
          row.tableName,
          row.action,
          javascriptSupport,
          callerScope,
          ownDeclarationName,
          [
            {
              kind: field.isCdata ? 'cdata' : 'xmlText',
              fieldName: field.fieldName
            }
          ]
        )
      );
    }
  }

  for (const row of doc.rows) {
    if (row.tableName !== 'sys_update_xml') {
      continue;
    }
    if (row.action === 'DELETE' && !includeDelete) {
      continue;
    }
    hits.push(
      ...payloadScriptFieldHits(doc, row, includeDelete, javascriptSupport, scopeApps)
    );
  }

  return hits;
}

function fieldToHit(
  field: EmbeddedFieldHit,
  tableName: string,
  action: string,
  javascriptSupport: JavaScriptSupport,
  callerScope: string | undefined,
  ownDeclarationName: string | undefined,
  layers: EncodingLayer[],
  hostStart = field.bodyStartOffset,
  hostEnd = field.bodyEndOffset,
  code = field.decodedContent
): ScriptHit {
  return {
    code,
    hostStart,
    hostEnd,
    layers,
    indent: detectCommonIndent(code),
    role: 'scriptField',
    tableName,
    fieldName: field.fieldName,
    action,
    profile: resolveScriptProfile(tableName, field.fieldName),
    javascriptSupport,
    callerScope,
    ownDeclarationName
  };
}

function payloadScriptFieldHits(
  doc: ParsedDocument,
  row: RecordRow,
  includeDelete: boolean,
  javascriptSupport: JavaScriptSupport,
  scopeApps: {
    workspaceAppSysId?: string;
    workspaceAppScope?: string;
    documentAppSysId?: string;
    documentAppScope?: string;
  }
): ScriptHit[] {
  const rowXml = doc.text.slice(row.startOffset, row.endOffset);
  const payload = locatePayloadBody(rowXml, row.startOffset);
  if (!payload) {
    return [];
  }

  let toRawInPayload = (offset: number): number => offset;
  if (!payload.isCdata) {
    const decodedToRaw = buildDecodedToRawMap(
      payload.rawBody,
      decodeXmlEntities
    );
    if (!decodedToRaw) {
      return [];
    }
    const rawLength = payload.rawBody.length;
    toRawInPayload = (offset) =>
      offset < decodedToRaw.length ? decodedToRaw[offset] : rawLength;
  }

  const inner = parseSnXml(payload.decoded);
  if (!inner.wellFormed) {
    return [];
  }

  const payloadLayer: EncodingLayer = {
    kind: payload.isCdata ? 'cdata' : 'xmlText',
    fieldName: 'payload'
  };
  const hits: ScriptHit[] = [];
  for (const innerRow of inner.rows) {
    if (!isPrimaryAction(innerRow.action)) {
      continue;
    }
    if (innerRow.action === 'DELETE' && !includeDelete) {
      continue;
    }
    const innerXml = inner.text.slice(innerRow.startOffset, innerRow.endOffset);
    const callerScope = resolveRowTechnicalScope(
      innerXml,
      innerRow.sysScopeValue,
      scopeApps
    );
    const ownDeclarationName = rowDeclarationName(
      innerRow.tableName.toLowerCase(),
      innerXml
    );
    for (const field of innerRow.embeddedFields) {
      if (field.language !== 'javascript' || !field.decodedContent.trim()) {
        continue;
      }
      const absStart = payload.bodyAbs + toRawInPayload(field.bodyStartOffset);
      const absEnd = payload.bodyAbs + toRawInPayload(field.bodyEndOffset);
      hits.push(
        fieldToHit(
          field,
          innerRow.tableName,
          innerRow.action,
          javascriptSupport,
          callerScope,
          ownDeclarationName,
          [
            payloadLayer,
            { kind: 'xmlDocument' },
            {
              kind: field.isCdata ? 'cdata' : 'xmlText',
              fieldName: field.fieldName
            }
          ],
          absStart,
          absEnd
        )
      );
    }
  }
  return hits;
}

function locatePayloadBody(
  rowXml: string,
  rowStart: number
): { decoded: string; rawBody: string; bodyAbs: number; isCdata: boolean } | null {
  for (const child of scanDirectChildElements(rowXml)) {
    if (child.name.toLowerCase() !== 'payload') {
      continue;
    }
    const bodyRaw = rowXml.slice(child.bodyStart, child.bodyEnd);
    const cdataMatch = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(bodyRaw);
    if (cdataMatch) {
      const innerStart = bodyRaw.indexOf('<![CDATA[') + '<![CDATA['.length;
      return {
        decoded: cdataMatch[1],
        rawBody: cdataMatch[1],
        bodyAbs: rowStart + child.bodyStart + innerStart,
        isCdata: true
      };
    }
    if (!bodyRaw.trim()) {
      return null;
    }
    return {
      decoded: decodeXmlEntities(bodyRaw),
      rawBody: bodyRaw,
      bodyAbs: rowStart + child.bodyStart,
      isCdata: false
    };
  }
  return null;
}

function layersForJsonField(
  field: EmbeddedFieldHit | undefined,
  hadWrapper: boolean
): EncodingLayer[] {
  const layers: EncodingLayer[] = [];
  if (field) {
    layers.push({
      kind: field.isCdata ? 'cdata' : 'xmlText',
      fieldName: field.fieldName
    });
  }
  layers.push({ kind: 'jsonString' });
  if (hadWrapper) {
    layers.push({ kind: 'jsWrapper' });
  }
  return layers;
}
