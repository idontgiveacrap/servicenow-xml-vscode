import { EmbeddedFieldHit, ParsedDocument } from './kinds/types';
import { isPrimaryAction } from './parseSnXml';

export interface ScriptRegion extends EmbeddedFieldHit {
  tableName: string;
  action: string;
  /** server vs client profile for ESLint globals */
  profile: 'server' | 'client';
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

const CLIENT_FIELDS = new Set(['client_script_v2', 'script_true', 'script_false']);

/**
 * Collect lintable script regions from a parsed document.
 * Skips DELETE primary rows by default.
 */
export function extractScriptRegions(
  doc: ParsedDocument,
  options?: { includeDelete?: boolean }
): ScriptRegion[] {
  const includeDelete = options?.includeDelete === true;
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
        profile: resolveProfile(row.tableName, field.fieldName)
      });
    }
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

function resolveProfile(tableName: string, fieldName: string): 'server' | 'client' {
  if (CLIENT_FIELDS.has(fieldName)) {
    return 'client';
  }
  if (CLIENT_TABLES.has(tableName)) {
    return 'client';
  }
  return 'server';
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
