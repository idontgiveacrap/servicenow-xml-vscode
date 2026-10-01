import * as vscode from 'vscode';
import { getIgnoreGlobs } from './ignorePaths';
import type { CachedApp, CachedDeclaration } from './registry/cache';
import {
  getWorkspaceRegistryService,
  registrySnapshotKeys
} from './registry/vscodeAdapter';
import {
  scanExportRecordsWithDeclarations
} from './navigator/scanExports';
import { ScriptDeclaration } from './scriptDeclarations';

type IndexListener = () => void;

/**
 * Workspace Script Include / UI Script / UX CSI names for lint globals.
 *
 * Reads the shared Registry snapshot. When the navigator is off, this index
 * runs the same export scan and writes `.servicenow-xml/registry-cache.json`.
 */
export class ScriptDeclarationIndex implements vscode.Disposable {
  private loaded = false;
  private loading: Promise<void> | undefined;
  private refreshQueued = false;
  private scanGeneration = 0;
  private readonly listeners = new Set<IndexListener>();
  private readonly disposables: vscode.Disposable[] = [];
  private getWorkspaceAppSysId: () => string | undefined = () => undefined;
  private getWorkspaceAppScope: () => string | undefined = () => undefined;
  private getWorkspaceJavaScriptSupport: () => string | undefined = () =>
    undefined;
  private getRestrictTableAccess: () => boolean | undefined = () => undefined;
  private isActive: () => boolean = () => false;

  constructor(workspaceState: vscode.Memento) {
    void workspaceState.update('servicenowXml.scriptDeclarations.cache', undefined);
    const registry = getWorkspaceRegistryService();
    this.disposables.push(
      registry.onDidChange(() => {
        if (!this.isActive()) {
          return;
        }
        this.loaded = true;
        this.notify();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        if (this.isActive()) {
          void this.refresh();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('servicenowXml.ignoreGlobs') && this.isActive()) {
          void this.refresh();
        }
      })
    );
  }

  /**
   * Bind workspace app metadata and the lint/gate active predicate.
   */
  configure(options: {
    isActive: () => boolean;
    getWorkspaceAppSysId: () => string | undefined;
    getWorkspaceAppScope: () => string | undefined;
    getWorkspaceJavaScriptSupport?: () => string | undefined;
    getRestrictTableAccess?: () => boolean | undefined;
  }): void {
    this.isActive = options.isActive;
    this.getWorkspaceAppSysId = options.getWorkspaceAppSysId;
    this.getWorkspaceAppScope = options.getWorkspaceAppScope;
    if (options.getWorkspaceJavaScriptSupport) {
      this.getWorkspaceJavaScriptSupport = options.getWorkspaceJavaScriptSupport;
    }
    if (options.getRestrictTableAccess) {
      this.getRestrictTableAccess = options.getRestrictTableAccess;
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.listeners.clear();
  }

  onDidChange(listener: IndexListener): vscode.Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      }
    };
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Indexed declarations from the shared Registry, or undefined when unused.
   */
  getDeclarations(): ScriptDeclaration[] | undefined {
    if (!this.loaded) {
      return undefined;
    }
    return getWorkspaceRegistryService().getDeclarationsForLint() ?? [];
  }

  /**
   * Load or refresh the index when lint is active in an SN workspace window.
   */
  async ensure(): Promise<boolean> {
    if (!this.isActive()) {
      this.loaded = false;
      return false;
    }
    const registry = getWorkspaceRegistryService();
    if (
      registry.getCachedDeclarations().length > 0 ||
      registry.getCachedRecords().length > 0
    ) {
      this.loaded = true;
      this.notify();
      return true;
    }
    const keys = registrySnapshotKeys();
    if (await registry.restoreFromDisk(keys.workspaceKey, keys.configKey)) {
      this.loaded = true;
      this.notify();
      return true;
    }
    if (this.isNavigatorEnabled()) {
      return false;
    }
    if (this.loaded) {
      return true;
    }
    if (this.loading) {
      await this.loading;
      return this.loaded;
    }
    await this.refresh();
    return this.loaded;
  }

  async refresh(): Promise<void> {
    if (!this.isActive()) {
      this.loaded = false;
      this.notify();
      return;
    }
    const existing = getWorkspaceRegistryService();
    if (
      existing.getCachedDeclarations().length > 0 ||
      existing.getCachedRecords().length > 0
    ) {
      this.loaded = true;
      this.notify();
      return;
    }
    if (this.isNavigatorEnabled()) {
      return;
    }
    if (this.loading) {
      this.refreshQueued = true;
      await this.loading;
      return;
    }
    this.loading = this.drainRefreshQueue();
    try {
      await this.loading;
    } finally {
      this.loading = undefined;
    }
  }

  private async drainRefreshQueue(): Promise<void> {
    let lastError: unknown;
    do {
      this.refreshQueued = false;
      const generation = ++this.scanGeneration;
      try {
        await this.runScan(generation);
        lastError = undefined;
      } catch (error) {
        lastError = error;
      }
    } while (this.refreshQueued && this.isActive());
    if (lastError) {
      throw lastError;
    }
  }

  /**
   * Full-workspace scan when the Records navigator is off.
   * Writes records and declarations into the same Registry cache the navigator uses.
   */
  private async runScan(generation: number): Promise<void> {
    const keys = registrySnapshotKeys();
    const scanned = await scanExportRecordsWithDeclarations({
      ignoreGlobs: getIgnoreGlobs(),
      excludeDelete: vscode.workspace
        .getConfiguration('servicenowXml')
        .get<boolean>('navigator.excludeDelete', false),
      extractDeclarations: true,
      workspaceAppSysId: this.getWorkspaceAppSysId(),
      workspaceAppScope: this.getWorkspaceAppScope()
    });
    if (!this.isActive() || generation !== this.scanGeneration) {
      return;
    }
    const declarations: CachedDeclaration[] = scanned.declarations;
    const service = getWorkspaceRegistryService();
    service.setWorkspaceData({
      records: scanned.records.map((record) => ({
        table: record.table,
        displayName: record.displayName,
        sysId: record.sysId,
        action: record.action,
        apiName: record.apiName,
        sysModCount: record.sysModCount,
        startOffset: record.startOffset,
        uri: record.uri.toString(),
        relativePath: record.relativePath
      })),
      declarations,
      app: this.workspaceApp(),
      schemaFields: scanned.schemaFields,
      references: scanned.references
    });
    await service.persistToDisk(keys.workspaceKey, keys.configKey);
    this.loaded = true;
    this.notify();
  }

  private isNavigatorEnabled(): boolean {
    return vscode.workspace
      .getConfiguration('servicenowXml')
      .get<boolean>('navigator.enable', false);
  }

  private workspaceApp(): CachedApp {
    const scope = this.getWorkspaceAppScope();
    const jsLevel = this.getWorkspaceJavaScriptSupport();
    return {
      sysId: this.getWorkspaceAppSysId(),
      scope,
      jsLevel,
      supportsES12:
        Boolean(scope) &&
        scope !== 'global' &&
        (jsLevel === 'ES12' || jsLevel === 'es_latest'),
      restrictTableAccess: this.getRestrictTableAccess()
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
