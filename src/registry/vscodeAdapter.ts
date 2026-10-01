/**
 * VS Code host adapter for the vscode-free Registry.
 * Owns static pack load, workspace sync, and disk cache persistence.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { getIgnoreGlobs } from '../ignorePaths';
import { ScriptDeclaration } from '../scriptDeclarations';
import {
  CachedApp,
  CachedDeclaration,
  CachedRecord,
  CachedReference,
  CachedSchemaField,
  cachedDeclarationsToSymbols,
  cachedRecordsToSymbols,
  createRegistryCache,
  loadRegistryCacheFile,
  registryCachePath,
  saveRegistryCacheFile
} from './cache';
import { MAX_REFERENCE_EDGES } from './xmlReferences';
import { createNodeFileSystem } from './nodeFs';
import { getRuntimeFieldIndex, getRuntimeRegistry } from './runtime';
import { workspaceDeclarationsFromRegistry } from './lintGlobals';

type RegistryListener = () => void;

/**
 * Extension-host owner of the shared Registry instance.
 */
export class WorkspaceRegistryService implements vscode.Disposable {
  readonly registry = getRuntimeRegistry();
  private readonly listeners = new Set<RegistryListener>();
  private readonly fs = createNodeFileSystem();
  private workspaceRecords: CachedRecord[] = [];
  private workspaceDeclarations: CachedDeclaration[] = [];
  private workspaceSchema: CachedSchemaField[] = [];
  private workspaceReferences: CachedReference[] = [];
  private workspaceApp: CachedApp | undefined;

  constructor() {
    this.loadStatic();
  }

  /**
   * Lazy dictionary field index (gunzips on first use).
   */
  getFieldIndex() {
    return getRuntimeFieldIndex();
  }

  dispose(): void {
    this.listeners.clear();
  }

  onDidChange(listener: RegistryListener): vscode.Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      }
    };
  }

  /**
   * Load bundled SI / scopes / platform globals / dictionary tables once.
   */
  loadStatic(): void {
    getRuntimeRegistry();
  }

  /**
   * Replace workspace Record + declaration symbols and refresh indexes.
   */
  setWorkspaceData(options: {
    records: CachedRecord[];
    declarations: CachedDeclaration[];
    app?: CachedApp;
    schemaFields?: CachedSchemaField[];
    references?: CachedReference[];
  }): void {
    this.workspaceRecords = options.records;
    this.workspaceDeclarations = options.declarations;
    if (options.app !== undefined) {
      this.workspaceApp = options.app;
    }
    if (options.schemaFields !== undefined) {
      this.workspaceSchema = options.schemaFields;
    }
    if (options.references !== undefined) {
      this.workspaceReferences = options.references.slice(0, MAX_REFERENCE_EDGES);
    }
    this.applyWorkspaceSymbols();
  }

  /**
   * Merge declaration rows (e.g. from declaration-only scan) without clearing records.
   */
  setWorkspaceDeclarations(declarations: CachedDeclaration[]): void {
    this.workspaceDeclarations = declarations;
    this.applyWorkspaceSymbols();
  }

  /**
   * Replace workspace symbols, then overlay project dictionary and reference edges.
   */
  private applyWorkspaceSymbols(): void {
    this.registry.clearWorkspaceSymbols();
    this.registry.upsertMany(cachedRecordsToSymbols(this.workspaceRecords));
    this.registry.upsertMany(
      cachedDeclarationsToSymbols(this.workspaceDeclarations)
    );
    this.registry.setProjectOverlay(this.workspaceSchema, this.workspaceReferences);
    this.notify();
  }

  getCachedRecords(): CachedRecord[] {
    return this.workspaceRecords;
  }

  getCachedDeclarations(): CachedDeclaration[] {
    return this.workspaceDeclarations;
  }

  getCachedApp(): CachedApp | undefined {
    return this.workspaceApp;
  }

  /**
   * Script declarations for ESLint (undefined when none indexed yet).
   */
  getDeclarationsForLint(): ScriptDeclaration[] | undefined {
    if (this.workspaceDeclarations.length === 0 && this.workspaceRecords.length === 0) {
      return undefined;
    }
    return workspaceDeclarationsFromRegistry(this.registry);
  }

  /**
   * Persist workspace snapshot under the first workspace folder.
   */
  async persistToDisk(workspaceKey: string, configKey: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || folder.uri.scheme !== 'file') {
      return;
    }
    const cachePath = registryCachePath(folder.uri.fsPath);
    const cache = createRegistryCache({
      workspaceKey,
      configKey,
      updatedAt: Date.now(),
      records: this.workspaceRecords,
      declarations: this.workspaceDeclarations,
      app: this.workspaceApp,
      schemaFields: this.workspaceSchema,
      references: this.workspaceReferences
    });
    try {
      await saveRegistryCacheFile(this.fs, cachePath, cache);
    } catch (error) {
      console.warn('[servicenow-xml] registry cache write failed:', error);
    }
  }

  /**
   * Restore workspace symbols from disk cache when keys match.
   */
  async restoreFromDisk(
    workspaceKey: string,
    configKey: string
  ): Promise<boolean> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || folder.uri.scheme !== 'file') {
      return false;
    }
    const cachePath = registryCachePath(folder.uri.fsPath);
    const cache = await loadRegistryCacheFile(
      this.fs,
      cachePath,
      workspaceKey,
      configKey
    );
    if (!cache) {
      return false;
    }
    this.setWorkspaceData({
      records: cache.records,
      declarations: cache.declarations,
      app: cache.app,
      schemaFields: cache.schemaFields ?? [],
      references: cache.references ?? []
    });
    return true;
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/** Singleton used by extension, lint, and navigator facades. */
let sharedService: WorkspaceRegistryService | undefined;

/**
 * Get or create the extension-wide Registry service.
 */
export function getWorkspaceRegistryService(): WorkspaceRegistryService {
  if (!sharedService) {
    sharedService = new WorkspaceRegistryService();
  }
  return sharedService;
}

/**
 * Reset the singleton (tests).
 */
export function resetWorkspaceRegistryService(): void {
  sharedService?.dispose();
  sharedService = undefined;
}

/**
 * Workspace and config keys for `.servicenow-xml/registry-cache.json`.
 * Navigator and the declaration index must share these so one snapshot restores both.
 */
export function registrySnapshotKeys(): { workspaceKey: string; configKey: string } {
  const workspaceKey = JSON.stringify(
    (vscode.workspace.workspaceFolders ?? [])
      .map((folder) => folder.uri.toString())
      .sort()
  );
  const excludeDelete = vscode.workspace
    .getConfiguration('servicenowXml')
    .get<boolean>('navigator.excludeDelete', false);
  const configKey = JSON.stringify({
    excludeDelete,
    ignoreGlobs: [...getIgnoreGlobs()].sort()
  });
  return { workspaceKey, configKey };
}

/**
 * Relative path helper for cache rows.
 */
export function relativePathForUri(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    return path.basename(uri.fsPath);
  }
  return path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, '/');
}
