import * as vscode from 'vscode';
import { getIgnoreGlobs } from './ignorePaths';
import type { CachedDeclaration } from './registry/cache';
import { getWorkspaceRegistryService } from './registry/vscodeAdapter';
import {
  scanExportRecordsWithDeclarations
} from './navigator/scanExports';
import { ScriptDeclaration } from './scriptDeclarations';

type IndexListener = () => void;

/**
 * Workspace Script Include / UI Script / UX CSI names for lint globals.
 *
 * Prefers declarations already collected by the Records catalog's unified
 * Registry scan; falls back to its own XML scan when the navigator is off.
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
  private isActive: () => boolean = () => false;

  constructor(_workspaceState: vscode.Memento) {
    const registry = getWorkspaceRegistryService();
    this.disposables.push(
      registry.onDidChange(() => {
        if (registry.getCachedDeclarations().length > 0) {
          this.loaded = true;
          this.notify();
        }
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
  }): void {
    this.isActive = options.isActive;
    this.getWorkspaceAppSysId = options.getWorkspaceAppSysId;
    this.getWorkspaceAppScope = options.getWorkspaceAppScope;
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
    if (registry.getCachedDeclarations().length > 0) {
      this.loaded = true;
      this.notify();
      return true;
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
    // Prefer declarations already produced by the navigator's unified scan.
    const existing = getWorkspaceRegistryService().getCachedDeclarations();
    if (existing.length > 0) {
      this.loaded = true;
      this.notify();
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
   * Full-workspace declaration scan when the navigator has not populated Registry.
   */
  private async runScan(generation: number): Promise<void> {
    const ignoreGlobs = getIgnoreGlobs();
    const scanned = await scanExportRecordsWithDeclarations({
      ignoreGlobs,
      excludeDelete: false,
      extractDeclarations: true,
      workspaceAppSysId: this.getWorkspaceAppSysId(),
      workspaceAppScope: this.getWorkspaceAppScope()
    });
    if (!this.isActive() || generation !== this.scanGeneration) {
      return;
    }
    const declarations: CachedDeclaration[] = scanned.declarations;
    const service = getWorkspaceRegistryService();
    // Keep any records the navigator already stored; replace declarations only.
    service.setWorkspaceData({
      records: service.getCachedRecords(),
      declarations
    });
    const workspaceKey = JSON.stringify(
      (vscode.workspace.workspaceFolders ?? [])
        .map((folder) => folder.uri.toString())
        .sort()
    );
    const configKey = JSON.stringify({
      ignoreGlobs: [...ignoreGlobs].sort(),
      appSysId: this.getWorkspaceAppSysId() ?? '',
      appScope: this.getWorkspaceAppScope() ?? ''
    });
    await service.persistToDisk(workspaceKey, configKey);
    this.loaded = true;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
