import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { isPathIgnored } from '../ignorePaths';
import type {
  CachedDeclaration,
  CachedReference,
  CachedSchemaField
} from '../registry/cache';
import { indexExportText } from '../registry/workspaceIndexer';

/**
 * Directories never worth walking for exports. Spelled out because passing any
 * explicit exclude to `findFiles` drops the `files.exclude` defaults.
 */
export const SCAN_EXCLUDE_BASE = ['**/node_modules/**', '**/.git/**'];

/**
 * Files read in parallel during a scan. Reads are I/O bound rather than CPU
 * bound, so this sits well above core count.
 */
export const SCAN_CONCURRENCY = 64;

/** One primary row from an export XML, without navigator usage metrics. */
export interface ExportRecord {
  table: string;
  displayName: string;
  sysId?: string;
  action?: string;
  apiName?: string;
  sysModCount?: number;
  /** Indexed row offset, used to disambiguate records when opening at their line. */
  startOffset: number;
  uri: vscode.Uri;
  relativePath: string;
}

/** Options for a workspace or single-file export scan. */
export interface ScanExportOptions {
  ignoreGlobs: string[];
  excludeDelete: boolean;
  token?: vscode.CancellationToken;
  /** When set, also extract Script Include / UI Script declarations in the same pass. */
  extractDeclarations?: boolean;
  workspaceAppSysId?: string;
  workspaceAppScope?: string;
}

/** Combined scan result for Registry + navigator. */
export interface ScanExportResult {
  records: ExportRecord[];
  declarations: CachedDeclaration[];
  schemaFields: CachedSchemaField[];
  references: CachedReference[];
}

/**
 * Scan workspace XML exports with bounded concurrency.
 * Callers choose ignore globs and whether DELETE rows are dropped.
 */
export async function scanExportRecords(
  options: ScanExportOptions
): Promise<ExportRecord[]> {
  const result = await scanExportRecordsWithDeclarations(options);
  return result.records;
}

/**
 * Scan workspace XML once for navigator records and lint declarations.
 */
export async function scanExportRecordsWithDeclarations(
  options: ScanExportOptions
): Promise<ScanExportResult> {
  const uris = await vscode.workspace.findFiles(
    '**/*.xml',
    `{${[...SCAN_EXCLUDE_BASE, ...options.ignoreGlobs].join(',')}}`
  );
  const out: ExportRecord[] = [];
  const declarations: CachedDeclaration[] = [];
  const schemaFields: CachedSchemaField[] = [];
  const references: CachedReference[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(SCAN_CONCURRENCY, uris.length) }, async () => {
      while (next < uris.length) {
        if (options.token?.isCancellationRequested) {
          throw new vscode.CancellationError();
        }
        const uri = uris[next++];
        const found = await readExportRecordsWithDeclarations(uri, options);
        for (const record of found.records) {
          out.push(record);
        }
        for (const declaration of found.declarations) {
          declarations.push(declaration);
        }
        for (const field of found.schemaFields) {
          schemaFields.push(field);
        }
        for (const edge of found.references) {
          references.push(edge);
        }
      }
    })
  );
  return { records: out, declarations, schemaFields, references };
}

/**
 * Read one XML export and return its navigable record identities.
 */
export async function readExportRecords(
  uri: vscode.Uri,
  options: ScanExportOptions
): Promise<ExportRecord[]> {
  const found = await readExportRecordsWithDeclarations(uri, options);
  return found.records;
}

/**
 * Read one XML export into records + optional declaration symbols.
 */
export async function readExportRecordsWithDeclarations(
  uri: vscode.Uri,
  options: ScanExportOptions
): Promise<ScanExportResult> {
  if (isPathIgnored(uri.fsPath, options.ignoreGlobs)) {
    return { records: [], declarations: [], schemaFields: [], references: [] };
  }
  let text: string;
  try {
    // Local files skip `workspace.fs`, whose calls round-trip to the main
    // process. A scan reads every export in the workspace, so that per-call
    // overhead outweighed the parsing. Virtual schemes keep the provider API.
    text =
      uri.scheme === 'file'
        ? await fs.readFile(uri.fsPath, 'utf8')
        : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  } catch {
    return { records: [], declarations: [], schemaFields: [], references: [] };
  }
  const relativePath = vscode.workspace.asRelativePath(uri, false);
  const indexed = indexExportText(text, {
    uri: uri.toString(),
    relativePath,
    excludeDelete: options.excludeDelete,
    extractDeclarations: options.extractDeclarations !== false,
    workspaceAppSysId: options.workspaceAppSysId,
    workspaceAppScope: options.workspaceAppScope
  });
  return {
    records: indexed.records.map((record) => ({
      table: record.table,
      displayName: record.displayName,
      sysId: record.sysId,
      action: record.action,
      apiName: record.apiName,
      sysModCount: record.sysModCount,
      startOffset: record.startOffset,
      uri,
      relativePath: record.relativePath
    })),
    declarations: indexed.declarations,
    schemaFields: indexed.schemaFields,
    references: indexed.references
  };
}
