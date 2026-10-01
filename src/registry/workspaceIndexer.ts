/**
 * Index one ServiceNow export XML into Registry-oriented workspace symbols
 * (records + declaration scripts) without vscode.
 */

import { extractRecordIdentities } from '../navigator/recordName';
import { parseSnXml } from '../parseSnXml';
import {
  extractScriptDeclarations,
  isScriptDeclarationTable,
  ScriptDeclaration
} from '../scriptDeclarations';
import type {
  CachedDeclaration,
  CachedRecord,
  CachedReference,
  CachedSchemaField
} from './cache';
import { extractProjectSchema } from './projectSchema';
import { extractXmlReferences, MAX_REFERENCE_EDGES } from './xmlReferences';

export interface IndexExportOptions {
  uri: string;
  relativePath: string;
  mtimeMs?: number;
  excludeDelete?: boolean;
  workspaceAppSysId?: string;
  workspaceAppScope?: string;
  /** Extract declaration globals from declaration-table rows. */
  extractDeclarations?: boolean;
}

export interface IndexedExport {
  records: CachedRecord[];
  declarations: CachedDeclaration[];
  schemaFields: CachedSchemaField[];
  references: CachedReference[];
}

/**
 * Parse export text into cached record rows and optional script declarations.
 */
export function indexExportText(
  text: string,
  options: IndexExportOptions
): IndexedExport {
  const identities = extractRecordIdentities(text, options.relativePath);
  const records: CachedRecord[] = [];
  for (const identity of identities) {
    if (options.excludeDelete && identity.action === 'DELETE') {
      continue;
    }
    records.push({
      table: identity.table,
      displayName: identity.displayName,
      sysId: identity.sysId,
      action: identity.action,
      apiName: identity.apiName,
      sysModCount: identity.sysModCount,
      startOffset: identity.startOffset,
      mtimeMs: options.mtimeMs,
      uri: options.uri,
      relativePath: options.relativePath
    });
  }

  const declarations: CachedDeclaration[] = [];
  if (options.extractDeclarations !== false) {
    const hasDeclarationTable = records.some(
      (r) => isScriptDeclarationTable(r.table) || r.table === 'sys_script'
    );
    if (hasDeclarationTable || looksLikeDeclarationFile(options.relativePath)) {
      const parsed = parseSnXml(text, options.relativePath);
      if (parsed.wellFormed) {
        const found = extractScriptDeclarations(parsed, {
          includePayloads: false,
          workspaceAppSysId: options.workspaceAppSysId,
          workspaceAppScope: options.workspaceAppScope
        });
        for (const declaration of found) {
          declarations.push(toCachedDeclaration(declaration, options));
        }
      }
    }
  }

  const schemaFields: CachedSchemaField[] = extractProjectSchema(text).map((field) => ({
    ...field,
    uri: options.uri,
    relativePath: options.relativePath
  }));
  const references = extractXmlReferences(text, {
    uri: options.uri,
    relativePath: options.relativePath
  }).slice(0, MAX_REFERENCE_EDGES);

  return { records, declarations, schemaFields, references };
}

/**
 * Map a ScriptDeclaration into the cache/MCP discovery shape.
 */
export function toCachedDeclaration(
  declaration: ScriptDeclaration,
  options: { uri: string; relativePath?: string; sysId?: string }
): CachedDeclaration {
  return {
    table: declaration.table,
    profile: declaration.profile,
    scope: declaration.scope,
    name: declaration.name,
    uri: options.uri,
    relativePath: options.relativePath,
    sysId: options.sysId
  };
}

function looksLikeDeclarationFile(relativePath: string): boolean {
  return /(?:^|[/\\])(sys_script_include|sys_ui_script|sys_ux_client_script_include|sys_script)_[0-9a-f]{32}\.xml$/i.test(
    relativePath
  );
}
