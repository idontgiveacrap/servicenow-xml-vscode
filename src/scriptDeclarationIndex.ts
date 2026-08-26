import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { getIgnoreGlobs, isPathIgnored } from './ignorePaths';
import { parseSnXml } from './parseSnXml';
import {
  createDeclarationCache,
  DECLARATION_CACHE_STATE_KEY,
  PersistedScriptDeclaration,
  readDeclarationCache
} from './scriptDeclarationCache';
import {
  extractScriptDeclarations,
  isScriptDeclarationExportPath,
  SCRIPT_DECLARATION_EXPORT_GLOB,
  ScriptDeclaration
} from './scriptDeclarations';
import { uriKey } from './navigator/usage';

const SCAN_EXCLUDE_BASE = ['**/node_modules/**', '**/.git/**'];
const SCAN_CONCURRENCY = 64;
const WATCH_DEBOUNCE_MS = 300;

type IndexListener = () => void;

/**
 * Workspace index of Script Include / UI Script / UX CSI names for lint globals.
 * Independent of the Records navigator.
 */
export class ScriptDeclarationIndex implements vscode.Disposable {
  private declarations: PersistedScriptDeclaration[] = [];
  private loaded = false;
  private loading: Promise<void> | undefined;
  private refreshQueued = false;
  private scanGeneration = 0;
  private watchers: vscode.FileSystemWatcher[] = [];
  private watchDebounce: NodeJS.Timeout | undefined;
  private cacheRestoreAttempted = false;
  private readonly pendingFileChanges = new Map<string, vscode.Uri | undefined>();
  private readonly listeners = new Set<IndexListener>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly workspaceState: vscode.Memento;
  private getWorkspaceAppSysId: () => string | undefined = () => undefined;
  private getWorkspaceAppScope: () => string | undefined = () => undefined;
  private isActive: () => boolean = () => false;

  constructor(workspaceState: vscode.Memento) {
    this.workspaceState = workspaceState;
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        if (this.isActive()) {
          void this.refresh();
        } else {
          this.clearAndStopWatching();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('servicenowXml.ignoreGlobs')) {
          if (this.isActive()) {
            void this.refresh();
          }
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
    this.clearAndStopWatching();
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
   * Indexed declarations, or undefined when the index is not in use.
   */
  getDeclarations(): ScriptDeclaration[] | undefined {
    if (!this.loaded) {
      return undefined;
    }
    return this.declarations.map(({ table, profile, scope, name }) => ({
      table,
      profile,
      scope,
      name
    }));
  }

  /**
   * Load or refresh the index when lint is active in an SN workspace window.
   */
  async ensure(): Promise<boolean> {
    if (!this.isActive()) {
      this.clearAndStopWatching();
      return false;
    }
    if (!this.loaded && this.restoreCache()) {
      this.startWatching();
      this.notify();
      void this.refresh();
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
      this.clearAndStopWatching();
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

  private async runScan(generation: number): Promise<void> {
    const ignoreGlobs = getIgnoreGlobs();
    const uris = await vscode.workspace.findFiles(
      SCRIPT_DECLARATION_EXPORT_GLOB,
      `{${[...SCAN_EXCLUDE_BASE, ...ignoreGlobs].join(',')}}`
    );
    const out: PersistedScriptDeclaration[] = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(SCAN_CONCURRENCY, uris.length) }, async () => {
        while (next < uris.length) {
          const found = await this.readFileDeclarations(uris[next++], ignoreGlobs);
          for (const declaration of found) {
            out.push(declaration);
          }
        }
      })
    );
    if (!this.isActive() || generation !== this.scanGeneration) {
      return;
    }
    this.declarations = out;
    this.loaded = true;
    this.startWatching();
    this.notify();
    await this.persistCache();
  }

  private restoreCache(): boolean {
    if (this.cacheRestoreAttempted) {
      return false;
    }
    this.cacheRestoreAttempted = true;
    const records = readDeclarationCache(
      this.workspaceState.get<unknown>(DECLARATION_CACHE_STATE_KEY),
      this.workspaceCacheKey(),
      this.configCacheKey()
    );
    if (!records) {
      return false;
    }
    this.declarations = records;
    this.loaded = true;
    return true;
  }

  private async persistCache(): Promise<void> {
    if (!this.loaded || !this.isActive()) {
      return;
    }
    try {
      await this.workspaceState.update(
        DECLARATION_CACHE_STATE_KEY,
        createDeclarationCache(
          this.workspaceCacheKey(),
          this.configCacheKey(),
          this.declarations
        )
      );
    } catch (error) {
      console.warn('[servicenow-xml] declaration cache write failed:', error);
    }
  }

  private workspaceCacheKey(): string {
    return JSON.stringify(
      (vscode.workspace.workspaceFolders ?? [])
        .map((folder) => folder.uri.toString())
        .sort()
    );
  }

  private configCacheKey(): string {
    return JSON.stringify({
      ignoreGlobs: [...getIgnoreGlobs()].sort(),
      appSysId: this.getWorkspaceAppSysId() ?? '',
      appScope: this.getWorkspaceAppScope() ?? ''
    });
  }

  private async readFileDeclarations(
    uri: vscode.Uri,
    ignoreGlobs = getIgnoreGlobs()
  ): Promise<PersistedScriptDeclaration[]> {
    if (isPathIgnored(uri.fsPath, ignoreGlobs)) {
      return [];
    }
    if (!isScriptDeclarationExportPath(uri.fsPath)) {
      return [];
    }
    let text: string;
    try {
      text =
        uri.scheme === 'file'
          ? await fs.readFile(uri.fsPath, 'utf8')
          : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch {
      return [];
    }
    const parsed = parseSnXml(text, uri.fsPath);
    if (!parsed.wellFormed) {
      return [];
    }
    const uriString = uri.toString();
    return extractScriptDeclarations(parsed, {
      includePayloads: false,
      workspaceAppSysId: this.getWorkspaceAppSysId(),
      workspaceAppScope: this.getWorkspaceAppScope()
    }).map((declaration) => ({ ...declaration, uri: uriString }));
  }

  private startWatching(): void {
    if (this.watchers.length > 0) {
      return;
    }
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return;
    }
    for (const folder of folders) {
      const pattern = new vscode.RelativePattern(
        folder,
        SCRIPT_DECLARATION_EXPORT_GLOB
      );
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidCreate((uri) => this.scheduleFileChange(uri));
      watcher.onDidChange((uri) => this.scheduleFileChange(uri));
      watcher.onDidDelete((uri) => this.scheduleFileChange(uri, true));
      this.watchers.push(watcher);
    }
  }

  private scheduleFileChange(uri: vscode.Uri, deleted = false): void {
    this.pendingFileChanges.set(uriKey(uri), deleted ? undefined : uri);
    if (this.watchDebounce) {
      clearTimeout(this.watchDebounce);
    }
    this.watchDebounce = setTimeout(() => {
      this.watchDebounce = undefined;
      void this.applyPendingFileChanges();
    }, WATCH_DEBOUNCE_MS);
  }

  private async applyPendingFileChanges(): Promise<void> {
    if (!this.isActive() || !this.loaded) {
      this.pendingFileChanges.clear();
      return;
    }
    if (this.loading) {
      this.watchDebounce = setTimeout(() => {
        this.watchDebounce = undefined;
        void this.applyPendingFileChanges();
      }, WATCH_DEBOUNCE_MS);
      return;
    }
    const changes = [...this.pendingFileChanges.entries()];
    this.pendingFileChanges.clear();
    const generation = this.scanGeneration;
    const updated = await Promise.all(
      changes.map(async ([key, uri]) => ({
        key,
        declarations: uri ? await this.readFileDeclarations(uri) : []
      }))
    );
    if (!this.isActive() || !this.loaded || generation !== this.scanGeneration) {
      return;
    }
    const next = this.declarations.filter(
      (declaration) =>
        !changes.some(([key]) => uriKey(vscode.Uri.parse(declaration.uri)) === key)
    );
    for (const { declarations } of updated) {
      for (const declaration of declarations) {
        next.push(declaration);
      }
    }
    this.declarations = next;
    this.notify();
    await this.persistCache();
  }

  private clearAndStopWatching(): void {
    this.scanGeneration++;
    this.loaded = false;
    this.declarations = [];
    this.pendingFileChanges.clear();
    if (this.watchDebounce) {
      clearTimeout(this.watchDebounce);
      this.watchDebounce = undefined;
    }
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.watchers.length = 0;
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
