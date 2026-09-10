import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { isPathIgnored } from '../ignorePaths';
import { extractRecordIdentities } from './recordName';

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
}

/**
 * Scan workspace XML exports with bounded concurrency.
 * Callers choose ignore globs and whether DELETE rows are dropped.
 */
export async function scanExportRecords(
  options: ScanExportOptions
): Promise<ExportRecord[]> {
  const uris = await vscode.workspace.findFiles(
    '**/*.xml',
    `{${[...SCAN_EXCLUDE_BASE, ...options.ignoreGlobs].join(',')}}`
  );
  const out: ExportRecord[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(SCAN_CONCURRENCY, uris.length) }, async () => {
      while (next < uris.length) {
        if (options.token?.isCancellationRequested) {
          throw new vscode.CancellationError();
        }
        const uri = uris[next++];
        const records = await readExportRecords(uri, options);
        for (const record of records) {
          out.push(record);
        }
      }
    })
  );
  return out;
}

/**
 * Read one XML export and return its navigable record identities.
 */
export async function readExportRecords(
  uri: vscode.Uri,
  options: ScanExportOptions
): Promise<ExportRecord[]> {
  if (isPathIgnored(uri.fsPath, options.ignoreGlobs)) {
    return [];
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
    return [];
  }
  const identities = extractRecordIdentities(text, uri.fsPath);
  const relativePath = vscode.workspace.asRelativePath(uri, false);
  return identities
    .filter((identity) => !options.excludeDelete || identity.action !== 'DELETE')
    .map((identity) => ({
      table: identity.table,
      displayName: identity.displayName,
      sysId: identity.sysId,
      action: identity.action,
      apiName: identity.apiName,
      sysModCount: identity.sysModCount,
      startOffset: identity.startOffset,
      uri,
      relativePath
    }));
}
