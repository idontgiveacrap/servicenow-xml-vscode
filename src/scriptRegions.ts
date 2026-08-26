import { EmbeddedFieldHit, ParsedDocument } from './kinds/types';
import { isPrimaryAction } from './parseSnXml';
import { JavaScriptSupport } from './javascriptSupport';
import { listScriptFields, scriptHitToRegion } from './scriptHits';
export { resolveScriptProfile } from './scriptProfile';

export interface ScriptRegion extends EmbeddedFieldHit {
  tableName: string;
  action: string;
  /** server vs client profile for ESLint globals */
  profile: 'server' | 'client';
  /** ServiceNow JavaScript mode used to select parser and platform rules. */
  javascriptSupport: JavaScriptSupport;
  /** Technical scope of the record that owns this script, when known. */
  callerScope?: string;
  /** Global the owning record declares, so its own script can declare it. */
  ownDeclarationName?: string;
}

export interface JsonRegion extends EmbeddedFieldHit {
  tableName: string;
  action: string;
}

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
    workspaceAppSysId?: string;
    workspaceAppScope?: string;
  }
): ScriptRegion[] {
  return listScriptFields(doc, options).map((hit) => scriptHitToRegion(doc, hit));
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
