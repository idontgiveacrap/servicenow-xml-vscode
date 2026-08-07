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
  for (const r of ranges) {
    if (offset >= r.start && offset < r.end) {
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

/**
 * Scan for table-named elements that carry an action attribute (SN record rows).
 * Skips matches inside CDATA (e.g. nested record_update inside sys_update_xml payload).
 */
function scanRecordRows(text: string): RecordRow[] {
  const rows: RecordRow[] = [];
  const cdataRanges = findCdataRanges(text);
  const openTagRe =
    /<\s*([A-Za-z_][\w.-]*)\b([^>]*?)\baction\s*=\s*["']([^"']+)["']([^>]*)>/g;

  let match: RegExpExecArray | null;
  while ((match = openTagRe.exec(text)) !== null) {
    if (isInsideRanges(match.index, cdataRanges)) {
      continue;
    }
    const tableName = match[1];
    if (tableName === 'record_update' || tableName === 'unload') {
      continue;
    }
    const rawAction = match[3];
    const upperAction = rawAction.toUpperCase();
    const lowerAction = rawAction.toLowerCase();
    const action = PRIMARY_ACTIONS.has(upperAction)
      ? upperAction
      : CLEANUP_ACTIONS.has(lowerAction)
        ? lowerAction
        : rawAction;
    const startOffset = match.index;
    const pos = offsetToPosition(text, startOffset);

    const selfClosing = /\/\s*>$/.test(match[0]);
    let rowEnd: number;
    if (selfClosing) {
      rowEnd = startOffset + match[0].length;
    } else {
      const closeRe = new RegExp(`</\\s*${escapeRegExp(tableName)}\\s*>`, 'g');
      closeRe.lastIndex = startOffset + match[0].length;
      const closeMatch = closeRe.exec(text);
      rowEnd = closeMatch ? closeMatch.index + closeMatch[0].length : text.length;
      // Prefer the first close that is not inside a CDATA that started inside this row
      // (closeRe already finds first close; nested same-name tags are rare in SN exports)
    }

    const rowXml = text.slice(startOffset, rowEnd);
    const sysIdInfo = extractSysId(rowXml, startOffset, text);
    const embeddedFields = extractEmbeddedFields(rowXml, startOffset, text);
    const sysScopeValue = extractReferenceFieldValue(rowXml, 'sys_scope');
    const sysPackageValue = extractReferenceFieldValue(rowXml, 'sys_package');

    rows.push({
      tableName,
      action,
      startOffset,
      endOffset: rowEnd,
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
  fullText: string
): EmbeddedFieldHit[] {
  const hits: EmbeddedFieldHit[] = [];
  const seen = new Set<string>();

  for (const fieldName of SCRIPT_FIELD_NAMES) {
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
