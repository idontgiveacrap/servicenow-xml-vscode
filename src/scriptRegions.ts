import { EmbeddedFieldHit, ParsedDocument, RecordRow } from './kinds/types';
import {
  decodeXmlEntities,
  extractRowElement,
  isPrimaryAction,
  offsetToPosition,
  parseSnXml
} from './parseSnXml';
import { buildDecodedToRawMap } from './jsonStringEditor/escape';
import { CLIENT_SCRIPT_FIELD_PAIRS } from './kinds/scriptFields.generated';
import { JavaScriptSupport } from './javascriptSupport';

export interface ScriptRegion extends EmbeddedFieldHit {
  tableName: string;
  action: string;
  /** server vs client profile for ESLint globals */
  profile: 'server' | 'client';
  /** ServiceNow JavaScript mode used to select parser and platform rules. */
  javascriptSupport: JavaScriptSupport;
}

export interface JsonRegion extends EmbeddedFieldHit {
  tableName: string;
  action: string;
}

const CLIENT_TABLES = new Set([
  'sys_ux_client_script',
  'sys_ux_client_script_include',
  'sys_ui_script',
  'sys_client_script',
  'sys_ui_policy'
]);

const CLIENT_FIELDS = new Set([
  'client_script',
  'client_script_v2',
  'script_true',
  'script_false'
]);

/**
 * Collect lintable script regions from a parsed document.
 * Skips DELETE primary rows by default.
 * For customer-update files, also walks each <sys_update_xml><payload> one at a time.
 */
export function extractScriptRegions(
  doc: ParsedDocument,
  options?: {
    includeDelete?: boolean;
    javascriptSupport?: JavaScriptSupport;
  }
): ScriptRegion[] {
  const includeDelete = options?.includeDelete === true;
  const javascriptSupport = options?.javascriptSupport ?? 'ES5';
  const regions: ScriptRegion[] = [];

  for (const row of doc.rows) {
    if (!isPrimaryAction(row.action)) {
      continue;
    }
    if (row.action === 'DELETE' && !includeDelete) {
      continue;
    }
    for (const field of row.embeddedFields) {
      if (field.language !== 'javascript') {
        continue;
      }
      if (!field.content.trim()) {
        continue;
      }
      regions.push({
        ...field,
        tableName: row.tableName,
        action: row.action,
        profile: resolveScriptProfile(row.tableName, field.fieldName),
        javascriptSupport
      });
    }
  }

  // Customer updates keep nested record_update XML inside payload CDATA, which
  // the outer scanner skips. Parse each payload separately and shift positions.
  for (const row of doc.rows) {
    if (row.tableName !== 'sys_update_xml') {
      continue;
    }
    if (row.action === 'DELETE' && !includeDelete) {
      continue;
    }
    regions.push(
      ...extractPayloadScriptRegions(doc, row, includeDelete, javascriptSupport)
    );
  }

  return regions;
}

/**
 * Collect JSON regions for well-formedness checks.
 */
export function extractJsonRegions(
  doc: ParsedDocument,
  options?: { includeDelete?: boolean }
): JsonRegion[] {
  const includeDelete = options?.includeDelete === true;
  const regions: JsonRegion[] = [];

  for (const row of doc.rows) {
    if (!isPrimaryAction(row.action) && !row.sysId) {
      continue;
    }
    if (row.action === 'DELETE' && !includeDelete) {
      continue;
    }
    for (const field of row.embeddedFields) {
      if (field.language !== 'json') {
        continue;
      }
      const trimmed = field.decodedContent.trim();
      if (!trimmed || trimmed === '{}' || trimmed === '[]') {
        continue;
      }
      if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) {
        continue;
      }
      regions.push({
        ...field,
        tableName: row.tableName,
        action: row.action
      });
    }
  }

  return regions;
}

/**
 * Pick the ESLint global set for a script body. Field name wins over table
 * because a single table can hold both sides: sys_ui_page carries browser code
 * in client_script and server code in processing_script.
 */
export function resolveScriptProfile(
  tableName: string,
  fieldName: string
): 'server' | 'client' {
  if (CLIENT_SCRIPT_FIELD_PAIRS.has(`${tableName}.${fieldName}`)) {
    return 'client';
  }
  if (CLIENT_FIELDS.has(fieldName)) {
    return 'client';
  }
  if (CLIENT_TABLES.has(tableName)) {
    return 'client';
  }
  return 'server';
}

/**
 * Parse one customer-update payload and return script regions in outer-document coordinates.
 */
function extractPayloadScriptRegions(
  doc: ParsedDocument,
  row: RecordRow,
  includeDelete: boolean,
  javascriptSupport: JavaScriptSupport
): ScriptRegion[] {
  const rowXml = doc.text.slice(row.startOffset, row.endOffset);
  const payloadEl = extractRowElement(rowXml, 'payload');
  if (!payloadEl) {
    return [];
  }
  const payload = payloadEl.isCdata
    ? payloadEl.content
    : decodeXmlEntities(payloadEl.content);
  if (!payload.trim()) {
    return [];
  }

  const cdataToken = '<![CDATA[';
  const payloadTag = rowXml.indexOf('<payload');
  let bodyAbs = row.startOffset;
  if (payloadEl.isCdata) {
    const cdataAt = rowXml.indexOf(cdataToken, payloadTag >= 0 ? payloadTag : 0);
    if (cdataAt >= 0) {
      bodyAbs = row.startOffset + cdataAt + cdataToken.length;
    }
  } else if (payloadTag >= 0) {
    const openEnd = rowXml.indexOf('>', payloadTag);
    if (openEnd >= 0) {
      bodyAbs = row.startOffset + openEnd + 1;
    }
  }

  // Offsets from the inner parse are in decoded space. For an entity-encoded
  // payload the raw text is longer (&lt; is 4 characters, < is 1), so they must
  // be mapped before being added to a raw-document base or every region lands
  // hundreds of characters early.
  let toRawInPayload = (offset: number): number => offset;
  if (!payloadEl.isCdata) {
    const decodedToRaw = buildDecodedToRawMap(payloadEl.content, decodeXmlEntities);
    if (!decodedToRaw) {
      return [];
    }
    const rawLength = payloadEl.content.length;
    toRawInPayload = (offset) =>
      offset < decodedToRaw.length ? decodedToRaw[offset] : rawLength;
  }

  const inner = parseSnXml(payload);
  if (!inner.wellFormed) {
    return [];
  }

  const regions: ScriptRegion[] = [];
  for (const innerRow of inner.rows) {
    if (!isPrimaryAction(innerRow.action)) {
      continue;
    }
    if (innerRow.action === 'DELETE' && !includeDelete) {
      continue;
    }
    for (const field of innerRow.embeddedFields) {
      if (field.language !== 'javascript' || !field.content.trim()) {
        continue;
      }
      const absStart = bodyAbs + toRawInPayload(field.bodyStartOffset);
      const absEnd = bodyAbs + toRawInPayload(field.bodyEndOffset);
      const pos = offsetToPosition(doc.text, absStart);
      regions.push({
        ...field,
        bodyStartOffset: absStart,
        bodyEndOffset: absEnd,
        bodyStartLine: pos.line,
        bodyStartCharacter: pos.character,
        tableName: innerRow.tableName,
        action: innerRow.action,
        profile: resolveScriptProfile(innerRow.tableName, field.fieldName),
        javascriptSupport
      });
    }
  }
  return regions;
}

/**
 * Map a position inside an embedded body back to the host XML document.
 */
export function mapScriptOffsetToXml(
  region: EmbeddedFieldHit,
  lineInScript: number,
  columnInScript: number
): { line: number; character: number } {
  const script = region.content;
  let offsetInScript = 0;
  let line = 0;
  while (line < lineInScript && offsetInScript < script.length) {
    const nl = script.indexOf('\n', offsetInScript);
    if (nl === -1) {
      offsetInScript = script.length;
      break;
    }
    offsetInScript = nl + 1;
    line++;
  }
  offsetInScript += columnInScript;

  let xmlLine = region.bodyStartLine;
  let xmlChar = region.bodyStartCharacter;
  for (let i = 0; i < offsetInScript && i < script.length; i++) {
    if (script.charCodeAt(i) === 10) {
      xmlLine++;
      xmlChar = 0;
    } else {
      xmlChar++;
    }
  }
  return { line: xmlLine, character: xmlChar };
}
