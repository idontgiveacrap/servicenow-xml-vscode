import { XMLValidator } from 'fast-xml-parser';
import {
  CLEANUP_ACTIONS,
  CUSTOMER_UPDATE_TABLES,
  EmbeddedFieldHit,
  EmbeddedLanguage,
  ParsedDocument,
  PRIMARY_ACTIONS,
  RecordRow,
  SnDiagnostic,
  SYS_ID_RE
} from './kinds/types';
import { isCssFieldName, isScriptTypedField } from './registry/fieldKinds';
import { looksLikeJavaScript } from './embedded/jsLikeness';

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
 * Collapse CRLF and lone CR to LF after entity decode.
 *
 * ServiceNow entity-encoded script fields often end each source line with
 * `&#13;` and a literal newline in the XML file — together one CRLF line ending,
 * not two logical newlines.
 */
export function normalizeDecodedLineEndings(text: string): string {
  // SN exports end each line with &#13; before the XML file newline; on Windows
  // that decodes to \r\r\n — collapse the whole run to one LF.
  return text.replace(/\r+\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Decode entity-encoded XML field text and normalize line endings for editing.
 */
export function decodeXmlFieldText(raw: string): string {
  return normalizeDecodedLineEndings(decodeXmlEntities(raw));
}

/**
 * Encode characters that must be escaped in non-CDATA XML text nodes.
 *
 * Only `&`, `<` and `>` are encoded, matching what ServiceNow itself emits in
 * text nodes. Quotes and apostrophes are legal unescaped in text content, and
 * encoding them mangles embedded JSON: a JSON string's own `"` delimiters and
 * its `\"` escapes would come back as `&quot;` / `\&quot;`, producing a diff
 * against the instance export even though the decoded value is unchanged.
 * Not safe for attribute values — this is text-node encoding only.
 *
 * Non-ASCII is left as-is (ServiceNow exports often keep them; CDATA is preferred for scripts).
 */
export function encodeXmlEntities(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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

const CDATA_OPEN = '<![CDATA[';

/** Direct child of a single rooted element (row or similar). CDATA is opaque. */
export interface DirectChildElement {
  name: string;
  /** Offset of the opening `<` in `xml`. */
  start: number;
  /** Offset of the first character after the opening tag. */
  bodyStart: number;
  /** Offset of the closing tag's `<`. */
  bodyEnd: number;
}

const CHILD_TAG_RE =
  /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/([A-Za-z_][\w.:-]*)\s*>|<([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)(\/?)>/g;

/**
 * List elements that are direct children of the root element in `xml`.
 * Tags inside CDATA, comments, and processing instructions are ignored.
 */
export function scanDirectChildElements(xml: string): DirectChildElement[] {
  const children: DirectChildElement[] = [];
  CHILD_TAG_RE.lastIndex = 0;
  let depth = 0;
  let pending: { name: string; start: number; bodyStart: number } | undefined;
  let m: RegExpExecArray | null;
  while ((m = CHILD_TAG_RE.exec(xml)) !== null) {
    if (m[1] != null) {
      if (
        pending &&
        depth === 2 &&
        pending.name.toLowerCase() === m[1].toLowerCase()
      ) {
        children.push({
          name: pending.name,
          start: pending.start,
          bodyStart: pending.bodyStart,
          bodyEnd: m.index
        });
        pending = undefined;
      }
      depth--;
      continue;
    }
    if (m[2] == null) {
      continue;
    }
    const name = m[2];
    if (m[0].endsWith('/>')) {
      if (depth === 1) {
        children.push({
          name,
          start: m.index,
          bodyStart: CHILD_TAG_RE.lastIndex,
          bodyEnd: CHILD_TAG_RE.lastIndex
        });
      }
      continue;
    }
    depth++;
    if (depth === 2) {
      pending = {
        name,
        start: m.index,
        bodyStart: CHILD_TAG_RE.lastIndex
      };
    }
  }
  return children;
}

/**
 * True when `fieldName` is a script-typed element for `tableName`.
 * Uses Registry fieldKinds pack (dictionary-derived) plus bootstrap names.
 */
export { isScriptTypedField };

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
    const sysScopeValue = extractRowFieldText(rowXml, 'sys_scope');
    const sysPackageValue = extractRowFieldText(rowXml, 'sys_package');
    // Direct children only: payload CDATA often embeds another record's
    // <sys_update_name> / <sys_scope>, which must not mark this row as owning them.
    const directChildNames = new Set(
      scanDirectChildElements(rowXml).map((c) => c.name.toLowerCase())
    );

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
      hasSysScope: directChildNames.has('sys_scope'),
      hasSysUpdateName: directChildNames.has('sys_update_name'),
      hasSysPackage: directChildNames.has('sys_package'),
      sysScopeValue,
      sysPackageValue,
      embeddedFields,
      scriptFields: embeddedFields.filter((f) => f.language === 'javascript')
    });
  }

  return rows;
}

/**
 * Decoded text of the first matching simple child element in `rowXml`.
 */
export function extractRowFieldText(
  rowXml: string,
  fieldName: string
): string | undefined {
  const el = extractRowElement(rowXml, fieldName);
  if (!el) {
    return undefined;
  }
  const value = (el.isCdata ? el.content : decodeXmlEntities(el.content)).trim();
  return value || undefined;
}

/**
 * Read the row's own `<sys_id>`.
 *
 * Must scan direct children rather than the raw row text: rows such as
 * `sys_metadata_link` and `sys_update_xml` carry a `<payload>` CDATA holding a
 * nested record, and the payload's `<sys_id>` precedes the row's own field in
 * the export's alphabetical field order.
 */
function extractSysId(
  rowXml: string,
  rowStart: number,
  fullText: string
): { sysId: string; line: number; character: number } | undefined {
  const child = scanDirectChildElements(rowXml).find(
    (c) => c.name.toLowerCase() === 'sys_id'
  );
  if (!child) {
    return undefined;
  }
  const classified = classifyLeafFieldBody(
    rowXml.slice(child.bodyStart, child.bodyEnd)
  );
  if (!classified) {
    return undefined;
  }
  const trimmedValue = classified.content.trim();
  const sysId = classified.isCdata
    ? trimmedValue
    : decodeXmlEntities(trimmedValue);
  const localOffset =
    child.bodyStart +
    classified.innerStart +
    classified.content.indexOf(trimmedValue);
  const pos = offsetToPosition(fullText, rowStart + localOffset);
  return { sysId, line: pos.line, character: pos.character };
}

/**
 * Extract script / CSS / JSON leaf fields from a row.
 */
function extractEmbeddedFields(
  rowXml: string,
  rowStart: number,
  fullText: string,
  tableName?: string
): EmbeddedFieldHit[] {
  const hits: EmbeddedFieldHit[] = [];
  const seen = new Set<string>();

  for (const child of scanDirectChildElements(rowXml)) {
    const classified = classifyLeafFieldBody(rowXml.slice(child.bodyStart, child.bodyEnd));
    if (!classified) {
      continue;
    }
    const decodedContent = classified.isCdata
      ? normalizeDecodedLineEndings(classified.content)
      : decodeXmlFieldText(classified.content);
    const language = languageForChild(tableName, child.name, decodedContent);
    if (!language) {
      continue;
    }
    const bodyStartOffset = rowStart + child.bodyStart + classified.innerStart;
    const bodyEndOffset = bodyStartOffset + classified.content.length;
    const pos = offsetToPosition(fullText, bodyStartOffset);
    const key = `${child.name}:${bodyStartOffset}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    hits.push({
      fieldName: child.name,
      language,
      isCdata: classified.isCdata,
      bodyStartOffset,
      bodyEndOffset,
      bodyStartLine: pos.line,
      bodyStartCharacter: pos.character,
      content: classified.content,
      decodedContent
    });
  }

  pushFlowStepScriptValue(rowXml, rowStart, fullText, tableName, hits, seen);

  return hits;
}

/**
 * Flow Designer stores step scripts in sys_variable_value rows (value field)
 * whose document points at sys_hub_step_instance.
 */
function pushFlowStepScriptValue(
  rowXml: string,
  rowStart: number,
  fullText: string,
  tableName: string | undefined,
  hits: EmbeddedFieldHit[],
  seen: Set<string>
): void {
  if (tableName?.toLowerCase() !== 'sys_variable_value') {
    return;
  }
  const documentChild = scanDirectChildElements(rowXml).find(
    (c) => c.name.toLowerCase() === 'document'
  );
  if (!documentChild) {
    return;
  }
  const documentName = decodeXmlEntities(
    rowXml.slice(documentChild.bodyStart, documentChild.bodyEnd).trim()
  ).trim();
  if (documentName !== 'sys_hub_step_instance') {
    return;
  }
  const valueChild = scanDirectChildElements(rowXml).find(
    (c) => c.name.toLowerCase() === 'value'
  );
  if (!valueChild) {
    return;
  }
  const classified = classifyLeafFieldBody(
    rowXml.slice(valueChild.bodyStart, valueChild.bodyEnd)
  );
  if (!classified) {
    return;
  }
  const decodedContent = classified.isCdata
    ? normalizeDecodedLineEndings(classified.content)
    : decodeXmlFieldText(classified.content);
  if (!looksLikeJavaScript(decodedContent.trim()).ok) {
    return;
  }
  const bodyStartOffset = rowStart + valueChild.bodyStart + classified.innerStart;
  const bodyEndOffset = bodyStartOffset + classified.content.length;
  const key = `value:${bodyStartOffset}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  const pos = offsetToPosition(fullText, bodyStartOffset);
  hits.push({
    fieldName: 'value',
    language: 'javascript',
    isCdata: classified.isCdata,
    bodyStartOffset,
    bodyEndOffset,
    bodyStartLine: pos.line,
    bodyStartCharacter: pos.character,
    content: classified.content,
    decodedContent
  });
}

/**
 * Language of a leaf field.
 *
 * Script/CSS come from Registry fieldKinds (dictionary embeddedLanguage).
 * JSON is decided by body shape: ServiceNow spreads JSON across far more
 * elements than a name list keeps up with, and structural fields like
 * `payload` / `sys_*` stay excluded.
 */
function languageForChild(
  tableName: string | undefined,
  fieldName: string,
  decodedContent: string
): EmbeddedLanguage | undefined {
  if (isScriptTypedField(tableName, fieldName)) {
    return 'javascript';
  }
  const lower = fieldName.toLowerCase();
  if (isCssFieldName(fieldName)) {
    return 'css';
  }
  if (lower === 'payload' || lower.startsWith('sys_')) {
    return undefined;
  }
  return looksLikeJsonBody(decodedContent) ? 'json' : undefined;
}

/**
 * Shape test, not a parse: a body that opens as an object or array is JSON that
 * the caller should lint, even when it is malformed. Requiring a successful
 * parse here would make broken JSON vanish from diagnostics entirely.
 */
function looksLikeJsonBody(decodedContent: string): boolean {
  const trimmed = decodedContent.trim();
  return (
    trimmed.length >= 2 && (trimmed.startsWith('{') || trimmed.startsWith('['))
  );
}

/**
 * CDATA-only or text leaf. Nested element markup is skipped.
 */
function classifyLeafFieldBody(
  bodyRaw: string
): { isCdata: boolean; content: string; innerStart: number } | undefined {
  const cdataMatch = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(bodyRaw);
  if (cdataMatch) {
    return {
      isCdata: true,
      content: cdataMatch[1],
      innerStart: bodyRaw.indexOf(CDATA_OPEN) + CDATA_OPEN.length
    };
  }
  if (/<[A-Za-z_]/.test(bodyRaw)) {
    return undefined;
  }
  if (!bodyRaw.trim()) {
    return undefined;
  }
  return { isCdata: false, content: bodyRaw, innerStart: 0 };
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
 * Prefers a direct child so markup inside CDATA cannot spoof a second field.
 */
export function extractRowElement(
  rowXml: string,
  fieldName: string
): { content: string; isCdata: boolean; localIndex: number } | undefined {
  const want = fieldName.toLowerCase();
  for (const child of scanDirectChildElements(rowXml)) {
    if (child.name.toLowerCase() !== want) {
      continue;
    }
    const classified = classifyLeafFieldBody(
      rowXml.slice(child.bodyStart, child.bodyEnd)
    );
    if (!classified) {
      continue;
    }
    return {
      content: classified.content,
      isCdata: classified.isCdata,
      localIndex: child.start
    };
  }
  // Fallbacks only see markup outside payload CDATA. Nested record_update
  // bodies inside <payload> must not supply this row's field values.
  const cdataRanges = findCdataRanges(rowXml);
  const cdataRe = new RegExp(
    `<\\s*${escapeRegExp(fieldName)}\\b[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</\\s*${escapeRegExp(fieldName)}\\s*>`,
    'gi'
  );
  let cm: RegExpExecArray | null;
  while ((cm = cdataRe.exec(rowXml)) !== null) {
    if (cm.index != null && !isInsideRanges(cm.index, cdataRanges)) {
      return { content: cm[1], isCdata: true, localIndex: cm.index };
    }
  }
  const plainRe = new RegExp(
    `<\\s*${escapeRegExp(fieldName)}\\b[^>]*>([\\s\\S]*?)</\\s*${escapeRegExp(fieldName)}\\s*>`,
    'gi'
  );
  let pm: RegExpExecArray | null;
  while ((pm = plainRe.exec(rowXml)) !== null) {
    if (
      pm.index != null &&
      !pm[0].includes('<![CDATA[') &&
      !isInsideRanges(pm.index, cdataRanges)
    ) {
      return { content: pm[1], isCdata: false, localIndex: pm.index };
    }
  }
  return undefined;
}
