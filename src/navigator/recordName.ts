import { parseExportFileName } from '../fileName';
import { decodeXmlEntities, scanActionRowBounds } from '../parseSnXml';

/** Lightweight record identity extracted from a ServiceNow export XML. */
export interface RecordIdentity {
  table: string;
  displayName: string;
  sysId?: string;
  action?: string;
  apiName?: string;
  /** ServiceNow update counter from `<sys_mod_count>`, when present. */
  sysModCount?: number;
  /** Zero-based UTF-16 offset of the record row's opening tag. */
  startOffset: number;
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
    const fallback = buildIdentity(
      text,
      fileMeta?.table,
      undefined,
      fileMeta?.sysId,
      0
    );
    return fallback ? [fallback] : [];
  }

  return primaryRows
    .map((row, index) =>
      buildIdentity(
        row.rowText,
        row.tableName,
        row.action,
        index === 0 && row.tableName === fileMeta?.table ? fileMeta.sysId : undefined,
        row.startOffset
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
  fallbackSysId: string | undefined,
  startOffset: number
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
  const sysModCount = parseSysModCount(
    extractElementText(recordText, 'sys_mod_count')
  );

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
    apiName: apiName || undefined,
    sysModCount,
    startOffset
  };
}

/**
 * Parse `<sys_mod_count>` text as a non-negative integer, or undefined if absent/invalid.
 */
function parseSysModCount(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

interface PrimaryRowHit {
  tableName: string;
  action: string;
  rowText: string;
  startOffset: number;
}

/**
 * Find primary rows outside CDATA and isolate each row from its siblings.
 */
function findPrimaryRows(text: string): PrimaryRowHit[] {
  const rows: PrimaryRowHit[] = [];
  for (const bounds of scanActionRowBounds(text)) {
    if (META_ROOTS.has(bounds.tableName.toLowerCase())) {
      continue;
    }
    const action = bounds.rawAction.toUpperCase();
    if (
      action !== 'INSERT_OR_UPDATE' &&
      action !== 'DELETE' &&
      action !== 'INSERT' &&
      action !== 'UPDATE'
    ) {
      continue;
    }
    rows.push({
      tableName: bounds.tableName,
      action,
      rowText: bounds.rowText,
      startOffset: bounds.startOffset
    });
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
