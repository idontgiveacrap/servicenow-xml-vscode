import { parseExportFileName } from '../fileName';
import { decodeXmlEntities, findCdataRanges } from '../parseSnXml';

/** Lightweight record identity extracted from a ServiceNow export XML. */
export interface RecordIdentity {
  table: string;
  displayName: string;
  sysId?: string;
  action?: string;
  apiName?: string;
}

const META_ROOTS = new Set(['record_update', 'unload', 'xml', '?xml']);

/**
 * Extract table, display name, sys_id, and action from ServiceNow export XML text.
 * Uses light regex so large script bodies are not fully parsed.
 */
export function extractRecordIdentity(
  text: string,
  filePath?: string
): RecordIdentity | undefined {
  return extractRecordIdentities(text, filePath)[0];
}

/**
 * Extract every primary record row from a ServiceNow XML export.
 * Multi-row unload and update-set files therefore produce multiple navigator items.
 */
export function extractRecordIdentities(
  text: string,
  filePath?: string
): RecordIdentity[] {
  const fileMeta = parseExportFileName(filePath);
  const primaryRows = findPrimaryRows(text);
  if (primaryRows.length === 0) {
    const fallback = buildIdentity(text, fileMeta?.table, undefined, fileMeta?.sysId);
    return fallback ? [fallback] : [];
  }

  return primaryRows
    .map((row, index) =>
      buildIdentity(
        row.rowText,
        row.tableName,
        row.action,
        index === 0 && row.tableName === fileMeta?.table ? fileMeta.sysId : undefined
      )
    )
    .filter((identity): identity is RecordIdentity => identity !== undefined);
}

/**
 * Build one record identity from an isolated row.
 */
function buildIdentity(
  recordText: string,
  table: string | undefined,
  action: string | undefined,
  fallbackSysId?: string
): RecordIdentity | undefined {
  if (!table) {
    return undefined;
  }

  const sysId =
    extractElementText(recordText, 'sys_id') || fallbackSysId || undefined;

  const name = extractElementText(recordText, 'name');
  const sysName = extractElementText(recordText, 'sys_name');
  const apiName = extractElementText(recordText, 'api_name');
  const targetName =
    table === 'sys_update_xml'
      ? extractElementText(recordText, 'target_name')
      : undefined;

  let displayName = targetName || name || sysName;
  if (!displayName && apiName) {
    const dot = apiName.lastIndexOf('.');
    displayName = dot >= 0 ? apiName.slice(dot + 1) : apiName;
  }
  if (!displayName) {
    displayName = sysId ? `${table}_${sysId.slice(0, 8)}` : table;
  }

  return {
    table,
    displayName,
    sysId,
    action,
    apiName: apiName || undefined
  };
}

interface PrimaryRowHit {
  tableName: string;
  action: string;
  rowText: string;
}

/**
 * Find primary rows outside CDATA and isolate each row from its siblings.
 */
function findPrimaryRows(text: string): PrimaryRowHit[] {
  const rows: PrimaryRowHit[] = [];
  const cdataRanges = findCdataRanges(text);
  const openTagRe =
    /<\s*([A-Za-z_][\w.-]*)\b([^>]*?)\baction\s*=\s*["']([^"']+)["']([^>]*)>/g;
  let match: RegExpExecArray | null;
  while ((match = openTagRe.exec(text)) !== null) {
    if (
      cdataRanges.some(
        (range) => match!.index >= range.start && match!.index < range.end
      )
    ) {
      continue;
    }
    const tableName = match[1];
    if (META_ROOTS.has(tableName.toLowerCase())) {
      continue;
    }
    const action = match[3].toUpperCase();
    if (
      action === 'INSERT_OR_UPDATE' ||
      action === 'DELETE' ||
      action === 'INSERT' ||
      action === 'UPDATE'
    ) {
      if (/\/\s*>$/.test(match[0])) {
        rows.push({ tableName, action, rowText: match[0] });
        continue;
      }
      const closeRe = new RegExp(`</\\s*${escapeRegExp(tableName)}\\s*>`, 'i');
      const remainder = text.slice(match.index + match[0].length);
      const closeMatch = closeRe.exec(remainder);
      const rowEnd = closeMatch
        ? match.index + match[0].length + closeMatch.index + closeMatch[0].length
        : text.length;
      rows.push({
        tableName,
        action,
        rowText: text.slice(match.index, rowEnd)
      });
      openTagRe.lastIndex = rowEnd;
    }
  }
  return rows;
}

/**
 * Return decoded text or CDATA content of the first matching simple element.
 */
function extractElementText(text: string, elementName: string): string | undefined {
  const re = new RegExp(
    `<\\s*${escapeRegExp(elementName)}\\b[^>]*>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))\\s*</\\s*${escapeRegExp(elementName)}\\s*>`,
    'i'
  );
  const m = text.match(re);
  if (!m) {
    return undefined;
  }
  const value = (m[1] ?? decodeXmlEntities(m[2] ?? '')).trim();
  return value || undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
