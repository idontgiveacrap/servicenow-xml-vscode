/**
 * Parsed export-row fields for the Registry MCP.
 * Embedded script, JSON, XML, and CSS stay summarized unless an excerpt is requested.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { CachedRecord } from './cache';
import { isCssFieldName, isJsonFieldName, isScriptTypedField } from './fieldKinds';
import { decodeXmlEntities, scanActionRowBounds, scanDirectChildElements } from '../parseSnXml';
import type { RecordSymbol } from './types';

/** Embedded body returned in full is cut here. */
export const RECORD_EXCERPT_CHARS = 2000;

type EmbeddedLanguage = 'javascript' | 'json' | 'xml' | 'css';

/**
 * Newest active row for a sys_id, or the newest row of any action when none are active.
 * `name` matches display name or api_name when `table` is set.
 */
export function pickCanonicalRecord(
  records: RecordSymbol[],
  query: { sysId?: string; table?: string; name?: string }
): RecordSymbol | undefined {
  let matches = records;
  if (query.sysId) {
    const id = query.sysId.toLowerCase();
    matches = matches.filter((record) => (record.sysId ?? '').toLowerCase() === id);
  }
  if (query.table) {
    matches = matches.filter((record) => record.table === query.table);
  }
  if (query.name) {
    const name = query.name.toLowerCase();
    matches = matches.filter(
      (record) =>
        record.displayName.toLowerCase() === name ||
        (record.apiName ?? '').toLowerCase() === name ||
        (record.apiName ?? '').toLowerCase().endsWith(`.${name}`)
    );
  }
  if (matches.length === 0) {
    return undefined;
  }
  const active = matches.filter((record) => record.action !== 'DELETE');
  const pool = active.length > 0 ? active : matches;
  return [...pool].sort((a, b) => {
    const ta = a.sysUpdatedOn ?? '';
    const tb = b.sysUpdatedOn ?? '';
    return tb < ta ? -1 : tb > ta ? 1 : 0;
  })[0];
}

/**
 * Read one cached row from the workspace and return its parsed fields.
 */
export function readExportRecord(
  record: Pick<RecordSymbol, 'uri' | 'relativePath' | 'startOffset' | 'table'>,
  includeEmbedded: boolean
): Record<string, unknown> {
  const filePath = workspaceFilePath(record);
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`Export file not found for ${record.relativePath ?? record.uri}`);
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const rows = scanActionRowBounds(text);
  const row =
    rows.find((candidate) => candidate.startOffset === record.startOffset) ??
    rows.find((candidate) => candidate.tableName === record.table);
  if (!row) {
    throw new Error(`No export row in ${record.relativePath ?? filePath}`);
  }
  return parseExportRecordRow(row.rowText, row.tableName, includeEmbedded);
}

/**
 * Direct child fields of one export row.
 * Reference elements with `display_value` become `{ value, display }`.
 */
export function parseExportRecordRow(
  rowXml: string,
  table: string,
  includeEmbedded: boolean
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const child of scanDirectChildElements(rowXml)) {
    const raw = rowXml.slice(child.bodyStart, child.bodyEnd);
    const openTag = rowXml.slice(child.start, child.bodyStart);
    const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(raw);
    const text = (cdata ? cdata[1] : decodeXmlEntities(raw)).trim();
    const language = embeddedLanguage(table, child.name, text);
    if (language) {
      fields[child.name] = includeEmbedded
        ? embeddedExcerpt(language, text)
        : { language, chars: text.length };
      continue;
    }
    if (!text && !tagAttr(openTag, 'display_value')) {
      continue;
    }
    const display = tagAttr(openTag, 'display_value');
    fields[child.name] = display ? { value: text, display } : text;
  }
  return fields;
}

/**
 * Workspace path for a cache row. Prefers REGISTRY_WORKSPACE plus the relative path.
 */
export function workspaceFilePath(record: {
  uri?: string;
  relativePath?: string;
}): string | undefined {
  const root = process.env.REGISTRY_WORKSPACE;
  if (root && record.relativePath) {
    return path.resolve(root, record.relativePath);
  }
  if (record.uri && record.uri.startsWith('file:')) {
    try {
      return fileURLToPath(record.uri);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Counts of records by table and action. Does not return row bodies.
 */
export function aggregateRecords(
  records: Array<Pick<CachedRecord, 'table' | 'action'>>
): {
  total: number;
  tables: Array<{ table: string; total: number; byAction: Record<string, number> }>;
} {
  const byTable = new Map<string, { total: number; byAction: Record<string, number> }>();
  for (const record of records) {
    let bucket = byTable.get(record.table);
    if (!bucket) {
      bucket = { total: 0, byAction: {} };
      byTable.set(record.table, bucket);
    }
    bucket.total += 1;
    const action = record.action || '';
    bucket.byAction[action] = (bucket.byAction[action] ?? 0) + 1;
  }
  const tables = [...byTable.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([table, bucket]) => ({ table, ...bucket }));
  return { total: records.length, tables };
}

function embeddedLanguage(
  table: string,
  field: string,
  text: string
): EmbeddedLanguage | undefined {
  if (isScriptTypedField(table, field) || field.toLowerCase() === 'client_script') {
    return 'javascript';
  }
  if (isJsonFieldName(field)) {
    return 'json';
  }
  if (isCssFieldName(field)) {
    return 'css';
  }
  if (field.toLowerCase() === 'xml') {
    return 'xml';
  }
  const trimmed = text.trim();
  if (trimmed.length > 400 && trimmed.startsWith('<')) {
    return 'xml';
  }
  if (trimmed.length > 400 && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
    return 'json';
  }
  return undefined;
}

function embeddedExcerpt(
  language: EmbeddedLanguage,
  text: string
): { language: EmbeddedLanguage; chars: number; excerpt: string; truncated: boolean } {
  const truncated = text.length > RECORD_EXCERPT_CHARS;
  return {
    language,
    chars: text.length,
    excerpt: truncated ? text.slice(0, RECORD_EXCERPT_CHARS) : text,
    truncated
  };
}

function tagAttr(openTag: string, name: string): string | undefined {
  const match = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    'i'
  ).exec(openTag);
  if (!match) {
    return undefined;
  }
  const value = decodeXmlEntities(match[1] ?? match[2] ?? '').trim();
  return value || undefined;
}
