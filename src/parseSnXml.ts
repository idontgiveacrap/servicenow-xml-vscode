import { XMLValidator } from 'fast-xml-parser';
import {
  CLEANUP_ACTIONS,
  CSS_FIELD_NAMES,
  CUSTOMER_UPDATE_TABLES,
  EmbeddedFieldHit,
  EmbeddedLanguage,
  JSON_FIELD_NAMES,
  ParsedDocument,
  PRIMARY_ACTIONS,
  RecordRow,
  SCRIPT_FIELD_NAMES,
  SnDiagnostic,
  SYS_ID_RE
} from './kinds/types';
import { SCRIPT_FIELD_PAIRS } from './kinds/scriptFields.generated';

/**
 * Convert a 0-based absolute offset into line/character using the source text.
 */
export function offsetToPosition(
  text: string,
  offset: number
): { line: number; character: number } {
  let line = 0;
  let lastNl = -1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lastNl = i;
    }
  }
  return { line, character: offset - lastNl - 1 };
}

/**
 * Decode common XML character entities used in ServiceNow field text.
 */
export function decodeXmlEntities(raw: string): string {
  return raw.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|amp|lt|gt|quot|apos);/gi,
    (entity, decimal: string | undefined, hex: string | undefined) => {
      if (decimal || hex) {
        const codePoint = Number.parseInt(decimal ?? hex ?? '', decimal ? 10 : 16);
        return codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : entity;
      }
      switch (entity.toLowerCase()) {
        case '&amp;':
          return '&';
        case '&lt;':
          return '<';
        case '&gt;':
          return '>';
        case '&quot;':
          return '"';
        case '&apos;':
          return "'";
        default:
          return entity;
      }
    }
  );
}

/**
 * Encode characters that must be escaped in non-CDATA XML text nodes.
 * Non-ASCII is left as-is (ServiceNow exports often keep them; CDATA is preferred for scripts).
 */
export function encodeXmlEntities(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Find [start, end) ranges of CDATA sections so scanners can ignore nested markup.
 */
export function findCdataRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    ranges.push({ start: m.index, end: m.index + m[0].length });
  }
  return ranges;
}

function isInsideRanges(
  offset: number,
  ranges: Array<{ start: number; end: number }>
): boolean {
  // findCdataRanges emits ascending, non-overlapping ranges, so the containing
  // range can be bisected. A linear scan here made row scanning quadratic in
  // record count, since exports carry roughly one CDATA per record.
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const range = ranges[mid];
    if (offset < range.start) {
      high = mid - 1;
    } else if (offset >= range.end) {
      low = mid + 1;
    } else {
      return true;
    }
  }
  return false;
}

/**
 * Parse ServiceNow-oriented XML into a lightweight document model with positions.
 * Uses XMLValidator for well-formedness and regex scanning for SN-specific structure
 * so CDATA script offsets stay accurate for lint remapping.
 */
export function parseSnXml(text: string, filePath?: string): ParsedDocument {
  const validation = XMLValidator.validate(text, {
    allowBooleanAttributes: true
  });

  if (validation !== true) {
    const err = validation as { err: { msg: string; line: number; col: number } };
    const line = Math.max(0, (err.err?.line ?? 1) - 1);
    const character = Math.max(0, (err.err?.col ?? 1) - 1);
    const parseError: SnDiagnostic = {
      message: `Invalid XML: ${err.err?.msg ?? 'parse error'}`,
      severity: 'error',
      line,
      character,
      code: 'xml-not-well-formed'
    };
    return {
      text,
      filePath,
      wellFormed: false,
      parseError,
      rows: [],
      hasUnloadRoot: false,
      hasUpdateSetMarkers: false
    };
  }

  const rootMatch = text.match(/<\s*([A-Za-z_][\w.-]*)\b/);
  const rootName = rootMatch?.[1];

  const hasUnloadRoot = rootName === 'unload' || /<\s*unload\b/i.test(text);
  const rows = scanRecordRows(text);
  const hasUpdateSetMarkers =
    rows.some((r) => CUSTOMER_UPDATE_TABLES.has(r.tableName)) ||
    /<\s*sys_remote_update_set\b/i.test(text);

  return {
    text,
    filePath,
    wellFormed: true,
    rootName,
    rows,
    hasUnloadRoot,
    hasUpdateSetMarkers
  };
}

/** Bounds of one action=… row in a ServiceNow export. */
export interface ActionRowBounds {
  tableName: string;
  /** Raw action attribute value (caller normalizes). */
  rawAction: string;
  startOffset: number;
  endOffset: number;
  rowText: string;
}

/**
 * Open/close tag scanners keyed by element name. Reused across rows because a
 * multi-row export re-scans the same element name once per row, and compiling
 * the pattern each time dominated the scan for large unloads. Safe to share:
 * `lastIndex` is assigned before every use and scanning is synchronous.
 */
const balancedTagScanners = new Map<string, RegExp>();

/**
 * Find the end offset of a balanced element named `tableName` starting after its open tag.
 * Handles nested same-name children (e.g. a field element named like the table).
 * Skips content inside CDATA. Close/open matching is case-insensitive.
 */
function findBalancedElementEnd(
  text: string,
  tableName: string,
  afterOpenOffset: number,
  cdataRanges: Array<{ start: number; end: number }>
): number {
  let tagRe = balancedTagScanners.get(tableName);
  if (!tagRe) {
    tagRe = new RegExp(
      `<\\s*(\\/)?\\s*${escapeRegExp(tableName)}\\b[^>]*>`,
      'gi'
    );
    balancedTagScanners.set(tableName, tagRe);
  }
  tagRe.lastIndex = afterOpenOffset;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(text)) !== null) {
    if (isInsideRanges(match.index, cdataRanges)) {
      continue;
    }
    const isClose = Boolean(match[1]);
    const selfClosing = !isClose && /\/\s*>$/.test(match[0]);
    if (isClose) {
      depth -= 1;
      if (depth === 0) {
        return match.index + match[0].length;
      }
    } else if (!selfClosing) {
      depth += 1;
    }
  }
  return text.length;
}

/**
 * Find action= rows outside CDATA and isolate each row from its siblings.
 * Advances the scanner past each row end so nested/sibling opens are not double-scanned.
 * Nested same-name field elements (no action=) are included via depth-balanced close matching.
 */
export function scanActionRowBounds(text: string): ActionRowBounds[] {
  const rows: ActionRowBounds[] = [];
  const cdataRanges = findCdataRanges(text);
  const openTagRe =
    /<\s*([A-Za-z_][\w.-]*)\b([^>]*?)\baction\s*=\s*["']([^"']+)["']([^>]*)>/g;

  let match: RegExpExecArray | null;
  while ((match = openTagRe.exec(text)) !== null) {
    if (isInsideRanges(match.index, cdataRanges)) {
      continue;
    }
    const tableName = match[1];
    if (
      tableName === 'record_update' ||
      tableName === 'unload' ||
      tableName.toLowerCase() === 'xml'
    ) {
      continue;
    }
    const startOffset = match.index;
    let endOffset: number;
    if (/\/\s*>$/.test(match[0])) {
      endOffset = startOffset + match[0].length;
    } else {
      endOffset = findBalancedElementEnd(
        text,
        tableName,
        startOffset + match[0].length,
        cdataRanges
      );
    }
    rows.push({
      tableName,
      rawAction: match[3],
      startOffset,
      endOffset,
      rowText: text.slice(startOffset, endOffset)
    });
    openTagRe.lastIndex = endOffset;
  }
  return rows;
}

/**
 * Scan for table-named elements that carry an action attribute (SN record rows).
 * Skips matches inside CDATA (e.g. nested record_update inside sys_update_xml payload).
 */
function scanRecordRows(text: string): RecordRow[] {
  const rows: RecordRow[] = [];
  for (const bounds of scanActionRowBounds(text)) {
    const upperAction = bounds.rawAction.toUpperCase();
    const lowerAction = bounds.rawAction.toLowerCase();
    const action = PRIMARY_ACTIONS.has(upperAction)
      ? upperAction
      : CLEANUP_ACTIONS.has(lowerAction)
        ? lowerAction
        : bounds.rawAction;
    const pos = offsetToPosition(text, bounds.startOffset);
    const rowXml = bounds.rowText;
    const sysIdInfo = extractSysId(rowXml, bounds.startOffset, text);
    const embeddedFields = extractEmbeddedFields(
      rowXml,
      bounds.startOffset,
      text,
      bounds.tableName
    );
    const sysScopeValue = extractReferenceFieldValue(rowXml, 'sys_scope');
    const sysPackageValue = extractReferenceFieldValue(rowXml, 'sys_package');

    rows.push({
      tableName: bounds.tableName,
      action,
      startOffset: bounds.startOffset,
      endOffset: bounds.endOffset,
      line: pos.line,
      character: pos.character,
      sysId: sysIdInfo?.sysId,
      sysIdLine: sysIdInfo?.line,
      sysIdCharacter: sysIdInfo?.character,
      hasSysScope: /<\s*sys_scope\b/i.test(rowXml),
      hasSysUpdateName: /<\s*sys_update_name\b/i.test(rowXml),
      hasSysPackage: /<\s*sys_package\b/i.test(rowXml),
      sysScopeValue,
      sysPackageValue,
      embeddedFields,
      scriptFields: embeddedFields.filter((f) => f.language === 'javascript')
    });
  }

  return rows;
}

/**
 * Read the body text of a reference-like field (`sys_scope`, `sys_package`, …).
 */
function extractReferenceFieldValue(
  rowXml: string,
  fieldName: string
): string | undefined {
  const el = extractRowElement(rowXml, fieldName);
  if (!el) {
    return undefined;
  }
  const value = (el.isCdata ? el.content : decodeXmlEntities(el.content)).trim();
  return value.length > 0 ? value : undefined;
}

function extractSysId(
  rowXml: string,
  rowStart: number,
  fullText: string
): { sysId: string; line: number; character: number } | undefined {
  const m = rowXml.match(
    /<\s*sys_id\b[^>]*>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))\s*<\/\s*sys_id\s*>/i
  );
  if (!m) {
    return undefined;
  }
  const rawValue = m[1] ?? m[2] ?? '';
  const trimmedValue = rawValue.trim();
  const sysId = m[1] != null ? trimmedValue : decodeXmlEntities(trimmedValue);
  const localOffset =
    rowXml.indexOf(m[0]) +
    m[0].indexOf(rawValue) +
    rawValue.indexOf(trimmedValue);
  const abs = rowStart + localOffset;
  const pos = offsetToPosition(fullText, abs);
  return { sysId, line: pos.line, character: pos.character };
}

/**
 * Extract known script / JSON / CSS fields, plus heuristic JSON-looking element bodies.
 */
function extractEmbeddedFields(
  rowXml: string,
  rowStart: number,
  fullText: string,
  tableName?: string
): EmbeddedFieldHit[] {
  const hits: EmbeddedFieldHit[] = [];
  const seen = new Set<string>();

  for (const fieldName of scriptFieldNamesFor(rowXml, tableName)) {
    for (const hit of extractNamedField(rowXml, rowStart, fullText, fieldName, 'javascript')) {
      const key = `${hit.fieldName}:${hit.bodyStartOffset}`;
      if (!seen.has(key)) {
        seen.add(key);
        hits.push(hit);
      }
    }
  }
  for (const fieldName of JSON_FIELD_NAMES) {
    for (const hit of extractNamedField(rowXml, rowStart, fullText, fieldName, 'json')) {
      const key = `${hit.fieldName}:${hit.bodyStartOffset}`;
      if (!seen.has(key)) {
        seen.add(key);
        hits.push(hit);
      }
    }
  }
  for (const fieldName of CSS_FIELD_NAMES) {
    for (const hit of extractNamedField(rowXml, rowStart, fullText, fieldName, 'css')) {
      const key = `${hit.fieldName}:${hit.bodyStartOffset}`;
      if (!seen.has(key)) {
        seen.add(key);
        hits.push(hit);
      }
    }
  }

  // Heuristic: leaf fields (no nested tags) whose body looks like JSON.
  // Do not use [\s\S]*? here — that matches the outer row element and consumes the whole slice.
  const heuristicRe =
    /<\s*([A-Za-z_][\w.-]*)\b[^>]*>([^<]*)<\/\s*\1\s*>/gi;
  let hm: RegExpExecArray | null;
  while ((hm = heuristicRe.exec(rowXml)) !== null) {
    const fieldName = hm[1];
    if (
      (SCRIPT_FIELD_NAMES as readonly string[]).includes(fieldName) ||
      (JSON_FIELD_NAMES as readonly string[]).includes(fieldName) ||
      (CSS_FIELD_NAMES as readonly string[]).includes(fieldName) ||
      (tableName && SCRIPT_FIELD_PAIRS.has(`${tableName}.${fieldName}`)) ||
      fieldName === 'sys_id' ||
      fieldName.startsWith('sys_') ||
      fieldName === 'payload'
    ) {
      continue;
    }
    const content = hm[2];
    const decoded = decodeXmlEntities(content).trim();
    if (!(decoded.startsWith('{') || decoded.startsWith('[')) || decoded.length < 2) {
      continue;
    }
    const openEnd = hm[0].indexOf('>') + 1;
    const bodyStartOffset = rowStart + hm.index + openEnd;
    const bodyEndOffset = bodyStartOffset + content.length;
    const pos = offsetToPosition(fullText, bodyStartOffset);
    const key = `${fieldName}:${bodyStartOffset}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    hits.push({
      fieldName,
      language: 'json',
      isCdata: false,
      bodyStartOffset,
      bodyEndOffset,
      bodyStartLine: pos.line,
      bodyStartCharacter: pos.character,
      content,
      decodedContent: decodeXmlEntities(content)
    });
  }

  return hits;
}

/**
 * Script field names to look for in one row: the always-on base names plus any
 * dictionary-typed script field for this table.
 *
 * Only names that actually appear in the row are returned, so cost tracks the
 * size of the record rather than the size of the dictionary table.
 */
function scriptFieldNamesFor(
  rowXml: string,
  tableName: string | undefined
): string[] {
  const names = new Set<string>(SCRIPT_FIELD_NAMES);
  if (!tableName) {
    return [...names];
  }
  const elementRe = /<\s*([A-Za-z_][\w.-]*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = elementRe.exec(rowXml)) !== null) {
    const element = m[1];
    if (!names.has(element) && SCRIPT_FIELD_PAIRS.has(`${tableName}.${element}`)) {
      names.add(element);
    }
  }
  return [...names];
}

function extractNamedField(
  rowXml: string,
  rowStart: number,
  fullText: string,
  fieldName: string,
  language: EmbeddedLanguage
): EmbeddedFieldHit[] {
  const hits: EmbeddedFieldHit[] = [];
  const cdataRe = new RegExp(
    `<\\s*${escapeRegExp(fieldName)}\\b[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</\\s*${escapeRegExp(fieldName)}\\s*>`,
    'gi'
  );
  let m: RegExpExecArray | null;
  while ((m = cdataRe.exec(rowXml)) !== null) {
    const content = m[1];
    const cdataToken = '<![CDATA[';
    const bodyLocal = m.index + m[0].indexOf(cdataToken) + cdataToken.length;
    const bodyStartOffset = rowStart + bodyLocal;
    const bodyEndOffset = bodyStartOffset + content.length;
    const pos = offsetToPosition(fullText, bodyStartOffset);
    hits.push({
      fieldName,
      language,
      isCdata: true,
      bodyStartOffset,
      bodyEndOffset,
      bodyStartLine: pos.line,
      bodyStartCharacter: pos.character,
      content,
      decodedContent: content
    });
  }

  const plainRe = new RegExp(
    `<\\s*${escapeRegExp(fieldName)}\\b[^>]*>([\\s\\S]*?)</\\s*${escapeRegExp(fieldName)}\\s*>`,
    'gi'
  );
  let pm: RegExpExecArray | null;
  while ((pm = plainRe.exec(rowXml)) !== null) {
    if (pm[0].includes('<![CDATA[')) {
      continue;
    }
    const content = pm[1];
    if (!content.trim()) {
      continue;
    }
    const openEnd = pm[0].indexOf('>') + 1;
    const bodyStartOffset = rowStart + pm.index + openEnd;
    const bodyEndOffset = bodyStartOffset + content.length;
    const pos = offsetToPosition(fullText, bodyStartOffset);
    hits.push({
      fieldName,
      language,
      isCdata: false,
      bodyStartOffset,
      bodyEndOffset,
      bodyStartLine: pos.line,
      bodyStartCharacter: pos.character,
      content,
      decodedContent: decodeXmlEntities(content)
    });
  }
  return hits;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isPrimaryAction(action: string): boolean {
  return PRIMARY_ACTIONS.has(action);
}

export function isCleanupAction(action: string): boolean {
  return CLEANUP_ACTIONS.has(action);
}

export function isValidSysId(value: string | undefined): boolean {
  return !!value && SYS_ID_RE.test(value);
}

/**
 * Extract a named child element body from a row (CDATA or plain).
 */
export function extractRowElement(
  rowXml: string,
  fieldName: string
): { content: string; isCdata: boolean; localIndex: number } | undefined {
  const cdataRe = new RegExp(
    `<\\s*${escapeRegExp(fieldName)}\\b[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</\\s*${escapeRegExp(fieldName)}\\s*>`,
    'i'
  );
  const cm = rowXml.match(cdataRe);
  if (cm && cm.index != null) {
    return { content: cm[1], isCdata: true, localIndex: cm.index };
  }
  const plainRe = new RegExp(
    `<\\s*${escapeRegExp(fieldName)}\\b[^>]*>([\\s\\S]*?)</\\s*${escapeRegExp(fieldName)}\\s*>`,
    'i'
  );
  const pm = rowXml.match(plainRe);
  if (pm && pm.index != null && !pm[0].includes('<![CDATA[')) {
    return { content: pm[1], isCdata: false, localIndex: pm.index };
  }
  return undefined;
}
