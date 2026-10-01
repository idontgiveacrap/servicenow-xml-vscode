/**
 * Project dictionary rows to merge onto the bundled platform dictionary.
 * Studio `<database>` exports and `sys_dictionary` / `sys_db_object` rows.
 */

import { decodeXmlEntities, extractRowFieldText } from '../parseSnXml';

/** One column, or a table label when `element` is empty. */
export interface ProjectSchemaField {
  table: string;
  /** Empty when this row is only the table's label. */
  element: string;
  label?: string;
  internalType?: string;
  reference?: string;
}

/**
 * Read table and column definitions from one export file.
 * Choice values nested under `<choice>` are not columns.
 */
export function extractProjectSchema(text: string): ProjectSchemaField[] {
  const fields: ProjectSchemaField[] = [];
  if (/<\s*database\b/i.test(text)) {
    fields.push(...extractDatabaseSchema(text));
  }
  fields.push(...extractDictionaryRows(text));
  fields.push(...extractDbObjectLabels(text));
  return fields;
}

/**
 * Studio Git schema: collection element names the table; nested elements are columns.
 */
function extractDatabaseSchema(text: string): ProjectSchemaField[] {
  const stripped = text.replace(/<choice\b[^>]*>[\s\S]*?<\/choice>/gi, '');
  const collection = /<element\b([^>]*\btype\s*=\s*["']collection["'][^>]*)>/i.exec(
    stripped
  );
  if (!collection) {
    return [];
  }
  const table = attr(collection[1], 'name');
  if (!table) {
    return [];
  }
  const fields: ProjectSchemaField[] = [];
  const tableLabel = attr(collection[1], 'label');
  if (tableLabel) {
    fields.push({ table, element: '', label: tableLabel });
  }
  const elementTags = /<element\b([^>]*?)\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = elementTags.exec(stripped))) {
    const attrs = match[1];
    if (/\btype\s*=\s*["']collection["']/i.test(attrs)) {
      continue;
    }
    const element = attr(attrs, 'name');
    const internalType = attr(attrs, 'type');
    if (!element || !internalType) {
      continue;
    }
    fields.push({
      table,
      element,
      label: attr(attrs, 'label'),
      internalType,
      reference: attr(attrs, 'reference')
    });
  }
  return fields;
}

/**
 * Update-set `sys_dictionary` rows. An empty `element` is the table label, not a column.
 */
function extractDictionaryRows(text: string): ProjectSchemaField[] {
  const fields: ProjectSchemaField[] = [];
  const rows = /<\s*sys_dictionary\b[^>]*>[\s\S]*?<\/\s*sys_dictionary\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = rows.exec(text))) {
    const row = match[0];
    const table = extractRowFieldText(row, 'name');
    if (!table) {
      continue;
    }
    const element = extractRowFieldText(row, 'element') ?? '';
    fields.push({
      table,
      element,
      label: extractRowFieldText(row, 'column_label'),
      internalType: extractRowFieldText(row, 'internal_type'),
      reference: extractRowFieldText(row, 'reference')
    });
  }
  return fields;
}

/** `sys_db_object.label` when the export has no dictionary table row. */
function extractDbObjectLabels(text: string): ProjectSchemaField[] {
  const fields: ProjectSchemaField[] = [];
  const rows = /<\s*sys_db_object\b[^>]*>[\s\S]*?<\/\s*sys_db_object\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = rows.exec(text))) {
    const row = match[0];
    const table = extractRowFieldText(row, 'name');
    const label = extractRowFieldText(row, 'label');
    if (!table || !label) {
      continue;
    }
    fields.push({ table, element: '', label });
  }
  return fields;
}

function attr(tagAttrs: string, name: string): string | undefined {
  const match = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    'i'
  ).exec(tagAttrs);
  if (!match) {
    return undefined;
  }
  const value = decodeXmlEntities(match[1] ?? match[2] ?? '').trim();
  return value || undefined;
}
