import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import {
  getIgnoreGlobs,
  isPathIgnored,
  isWorkspaceSchemeUri
} from '../ignorePaths';
import {
  CATALOG_CACHE_STATE_KEY,
  createCatalogCache,
  PersistedCatalogRecord,
  readCatalogCache
} from './catalogCache';
import { extractRecordIdentities } from './recordName';
import { RecordUsageStore, uriKey } from './usage';

/** Selectable Records navigator sort modes. */
export type NavigatorSortBy =
  | 'mostOpened'
  | 'recentlyOpened'
  | 'recentlyUpdated'
  | 'sysModCount'
  | 'name';

const SORT_BY_VALUES: readonly NavigatorSortBy[] = [
  'mostOpened',
  'recentlyOpened',
  'recentlyUpdated',
  'sysModCount',
  'name'
] as const;

export { uriKey } from './usage';

/**
 * Directories never worth walking for exports. Spelled out because passing any
 * explicit exclude to `findFiles` drops the `files.exclude` defaults.
 */
const SCAN_EXCLUDE_BASE = ['**/node_modules/**', '**/.git/**'];

/**
 * Files read in parallel during a scan. Reads are I/O bound rather than CPU
 * bound, so this sits well above core count.
 */
const SCAN_CONCURRENCY = 64;

/** One indexed ServiceNow record tied to its export file. */
export interface CatalogRecord {
  table: string;
  displayName: string;
  sysId?: string;
  action?: string;
  apiName?: string;
  sysModCount?: number;
  /** Indexed row offset, used to disambiguate records when opening at their line. */
  startOffset: number;
  /**
   * File modification time in ms (shared across rows in the same file).
   * Filled in lazily by the catalog, and only for the `recentlyUpdated` sort;
   * undefined otherwise, which that sort treats as "unknown, order last".
   */
  mtimeMs?: number;
  openCount: number;
  lastOpenedAt?: number;
  uri: vscode.Uri;
  relativePath: string;
}

type CatalogListener = () => void;

/**
 * Lazy catalog of ServiceNow export records with a persisted metadata snapshot.
 * Performs no file I/O until {@link ensure} or {@link refresh} is called while
 * enabled; ensure can render a compatible snapshot before revalidating it.
 */
export class RecordCatalog implements vscode.Disposable {
  private byTable = new Map<string, CatalogRecord[]>();
  private allRecords: CatalogRecord[] = [];
  private recordsByUri = new Map<string, CatalogRecord[]>();
  private tableOrder: string[] = [];
  private loaded = false;
  private loading: Promise<void> | undefined;
  private refreshQueued = false;
  private scanGeneration = 0;
  private watchers: vscode.FileSystemWatcher[] = [];
  private watchDebounce: NodeJS.Timeout | undefined;
  private usageRebuildDebounce: NodeJS.Timeout | undefined;
  private cacheRestoreAttempted = false;
  private restoredFromCache = false;
  private cacheRevalidationStarted = false;
  private readonly pendingFileChanges = new Map<string, vscode.Uri | undefined>();
  private readonly listeners = new Set<CatalogListener>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly usage: RecordUsageStore;
  private readonly workspaceState: vscode.Memento;

  constructor(workspaceState: vscode.Memento) {
    this.workspaceState = workspaceState;
    this.usage = new RecordUsageStore(workspaceState);
    this.disposables.push(
      this.usage,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('servicenowXml.navigator') ||
          e.affectsConfiguration('servicenowXml.ignoreGlobs')
        ) {
          if (!this.isEnabled()) {
            this.clearAndStopWatching();
            this.notify();
            return;
          }
          // Sort-only changes rebuild views without rescanning the workspace.
          if (
            this.loaded &&
            e.affectsConfiguration('servicenowXml.navigator.sortBy') &&
            !e.affectsConfiguration('servicenowXml.navigator.enable') &&
            !e.affectsConfiguration('servicenowXml.navigator.excludeDelete') &&
            !e.affectsConfiguration('servicenowXml.ignoreGlobs')
          ) {
            // Switching into recentlyUpdated is the first time mtimes are needed.
            if (this.sortBy() === 'recentlyUpdated') {
              void this.ensureMtimes().then(async () => {
                if (!this.loaded || !this.isEnabled()) {
                  return;
                }
                this.rebuildViews();
                this.notify();
                await this.persistCache();
              });
              return;
            }
            this.rebuildViews();
            this.notify();
            return;
          }
          if (this.loaded) {
            void this.refresh({ showProgress: false }).catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              void vscode.window.showErrorMessage(
                `ServiceNow Records refresh failed: ${message}`
              );
            });
          }
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        if (this.loaded && this.isEnabled()) {
          this.stopWatching();
          void this.refresh({ showProgress: false }).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(
              `ServiceNow Records refresh failed: ${message}`
            );
          });
        }
      })
    );
  }

  dispose(): void {
    this.clearAndStopWatching();
    if (this.usageRebuildDebounce) {
      clearTimeout(this.usageRebuildDebounce);
      this.usageRebuildDebounce = undefined;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.listeners.clear();
  }

  /** Subscribe to catalog rebuilds (tree refresh). */
  onDidChange(listener: CatalogListener): vscode.Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      }
    };
  }

  isEnabled(): boolean {
    return vscode.workspace
      .getConfiguration('servicenowXml')
      .get<boolean>('navigator.enable', false);
  }

  excludeDelete(): boolean {
    return vscode.workspace
      .getConfiguration('servicenowXml')
      .get<boolean>('navigator.excludeDelete', false);
  }

  /**
   * Current navigator sort mode (defaults to mostOpened).
   */
  sortBy(): NavigatorSortBy {
    const raw = vscode.workspace
      .getConfiguration('servicenowXml')
      .get<string>('navigator.sortBy', 'mostOpened');
    return SORT_BY_VALUES.includes(raw as NavigatorSortBy)
      ? (raw as NavigatorSortBy)
      : 'mostOpened';
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Table folders in current sort order.
   */
  getTables(): string[] {
    return this.tableOrder;
  }

  getRecordsForTable(table: string): CatalogRecord[] {
    return this.byTable.get(table) ?? [];
  }

  getAllRecords(): CatalogRecord[] {
    return this.allRecords;
  }

  /**
   * Whether the URI is indexed in the catalog (any primary row).
   */
  hasUri(uri: vscode.Uri): boolean {
    return this.recordsByUri.has(uriKey(uri));
  }

  /**
   * Catalog rows indexed for a file URI; empty when the file is not indexed.
   */
  getRecordsForUri(uri: vscode.Uri): CatalogRecord[] {
    return this.recordsByUri.get(uriKey(uri)) ?? [];
  }

  /**
   * Record an open for every catalog row under this URI, then rebuild sort views.
   */
  recordDocumentOpen(uri: vscode.Uri): void {
    const records = this.recordsByUri.get(uriKey(uri));
    if (!records || records.length === 0) {
      return;
    }
    for (const record of records) {
      this.usage.recordOpen(uri, record.sysId);
    }
    if (this.usageRebuildDebounce) {
      clearTimeout(this.usageRebuildDebounce);
    }
    this.usageRebuildDebounce = setTimeout(() => {
      this.usageRebuildDebounce = undefined;
      if (!this.loaded || !this.isEnabled()) {
        return;
      }
      this.rebuildViews();
      this.notify();
    }, 200);
  }

  /**
   * Load the catalog if enabled and not yet loaded. No-op when disabled or warm.
   */
  async ensure(options?: { showProgress?: boolean }): Promise<boolean> {
    if (!this.isEnabled()) {
      return false;
    }
    if (!this.loaded && this.restoreCache()) {
      this.startWatching();
      this.notify();
      this.startCacheRevalidation();
      return true;
    }
    if (this.loaded) {
      if (this.restoredFromCache) {
        this.startCacheRevalidation();
      }
      return true;
    }
    if (this.loading) {
      await this.loading;
      return this.loaded;
    }
    await this.refresh(options);
    return this.loaded;
  }

  /**
   * Restore a compatible workspace-state snapshot into the in-memory catalog.
   * Usage metrics remain authoritative in RecordUsageStore and are merged while
   * views rebuild, so cached open counts cannot overwrite newer usage state.
   */
  private restoreCache(): boolean {
    if (this.cacheRestoreAttempted) {
      return false;
    }
    this.cacheRestoreAttempted = true;
    const records = readCatalogCache(
      this.workspaceState.get<unknown>(CATALOG_CACHE_STATE_KEY),
      this.workspaceCacheKey(),
      this.configCacheKey()
    );
    if (!records) {
      return false;
    }
    const restored: CatalogRecord[] = [];
    try {
      for (const record of records) {
        const uri = vscode.Uri.parse(record.uri);
        // Snapshots written before watcher events were scheme-filtered can hold
        // rows for virtual copies of a file; drop them instead of rendering a
        // duplicate row until the next full scan.
        if (!isWorkspaceSchemeUri(uri)) {
          continue;
        }
        restored.push({
          ...record,
          uri,
          openCount: 0
        });
      }
    } catch (error) {
      console.warn('[servicenow-xml] navigator cache is malformed:', error);
      void this.workspaceState.update(CATALOG_CACHE_STATE_KEY, undefined);
      return false;
    }
    this.applyRecords(restored);
    this.restoredFromCache = true;
    return true;
  }

  /**
   * Revalidate a restored snapshot once per activation without delaying its
   * first render. Failure leaves the cached catalog usable for manual refresh.
   */
  private startCacheRevalidation(): void {
    if (this.cacheRevalidationStarted || !this.restoredFromCache) {
      return;
    }
    this.cacheRevalidationStarted = true;
    void this.refresh({ showProgress: false }).catch((error: unknown) => {
      this.cacheRevalidationStarted = false;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        '[servicenow-xml] cached navigator background refresh failed:',
        message
      );
      void vscode.window.showWarningMessage(
        `ServiceNow Records is showing its cached index because background refresh failed: ${message}`
      );
    });
  }

  /**
   * Rebuild the catalog from workspace XML files. No-op when navigator is disabled.
   */
  async refresh(options?: { showProgress?: boolean }): Promise<void> {
    if (!this.isEnabled()) {
      this.clearAndStopWatching();
      this.notify();
      return;
    }

    if (this.loading) {
      this.refreshQueued = true;
      await this.loading;
      return;
    }

    this.loading = this.drainRefreshQueue(options?.showProgress !== false);
    try {
      await this.loading;
    } finally {
      this.loading = undefined;
    }
  }

  /**
   * Run queued full scans under one shared promise so all callers await the drain.
   */
  private async drainRefreshQueue(showProgress: boolean): Promise<void> {
    let lastError: unknown;
    do {
      this.refreshQueued = false;
      const generation = ++this.scanGeneration;
      try {
        await this.runScan(showProgress, generation);
        lastError = undefined;
      } catch (error) {
        lastError = error;
      }
      showProgress = false;
    } while (this.refreshQueued && this.isEnabled());

    if (lastError) {
      throw lastError;
    }
  }

  private async runScan(showProgress: boolean, generation: number): Promise<void> {
    const run = async (
      progress?: vscode.Progress<{ message?: string; increment?: number }>
    ) => {
      progress?.report({ message: 'Scanning ServiceNow XML…' });
      const records = await this.scanWorkspace();
      if (!this.isEnabled() || generation !== this.scanGeneration) {
        return;
      }
      // applyRecords marks the catalog loaded; remember whether the tree was
      // already showing rows so a recentlyUpdated refresh does not notify once
      // with empty mtimes (name-order fallback) before stats finish.
      const alreadyVisible = this.loaded;
      this.applyRecords(records);
      this.restoredFromCache = false;
      this.startWatching();
      progress?.report({ message: `Indexed ${records.length} records` });
      const needsMtimes = this.sortBy() === 'recentlyUpdated';
      // Cold start: paint before statting so the tree is usable. A catalog that
      // is already on screen keeps its current order until mtimes are back.
      if (!alreadyVisible || !needsMtimes) {
        this.notify();
      }
      if (needsMtimes) {
        await this.ensureMtimes();
        if (this.isEnabled() && generation === this.scanGeneration) {
          this.rebuildViews();
          this.notify();
        }
      }
      await this.persistCache();
    };

    if (showProgress) {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: 'ServiceNow Records'
        },
        async (progress) => run(progress)
      );
    } else {
      await run();
    }
  }

  private applyRecords(records: CatalogRecord[]): void {
    const recordsByUri = new Map<string, CatalogRecord[]>();
    for (const record of records) {
      const key = uriKey(record.uri);
      const existing = recordsByUri.get(key);
      if (existing) {
        existing.push(record);
      } else {
        recordsByUri.set(key, [record]);
      }
    }
    this.recordsByUri = recordsByUri;
    this.rebuildViews();
    this.loaded = true;
  }

  /**
   * Persist identity metadata only; usage remains in its existing dedicated
   * store and XML/script bodies never enter workspaceState.
   */
  private async persistCache(): Promise<void> {
    if (!this.loaded || !this.isEnabled()) {
      return;
    }
    const records: PersistedCatalogRecord[] = [
      ...this.recordsByUri.values()
    ].flatMap((rows) =>
      rows.map((record) => ({
        table: record.table,
        displayName: record.displayName,
        sysId: record.sysId,
        action: record.action,
        apiName: record.apiName,
        sysModCount: record.sysModCount,
        startOffset: record.startOffset,
        mtimeMs: record.mtimeMs,
        uri: record.uri.toString(),
        relativePath: record.relativePath
      }))
    );
    try {
      await this.workspaceState.update(
        CATALOG_CACHE_STATE_KEY,
        createCatalogCache(this.workspaceCacheKey(), this.configCacheKey(), records)
      );
    } catch (error) {
      console.warn('[servicenow-xml] navigator cache write failed:', error);
    }
  }

  /**
   * Stable identity for the folders whose XML records make up this catalog.
   */
  private workspaceCacheKey(): string {
    return JSON.stringify(
      (vscode.workspace.workspaceFolders ?? [])
        .map((folder) => folder.uri.toString())
        .sort()
    );
  }

  /**
   * Index-affecting settings; sort and usage do not change catalog membership.
   */
  private configCacheKey(): string {
    return JSON.stringify({
      excludeDelete: this.excludeDelete(),
      ignoreGlobs: [...getIgnoreGlobs()].sort()
    });
  }

  /**
   * Merge usage stats and rebuild sorted table / flat views from the URI-keyed catalog.
   */
  private rebuildViews(): void {
    const sortBy = this.sortBy();
    const records = [...this.recordsByUri.values()].flat().map((record) => {
      const usage = this.usage.get(record.uri, record.sysId);
      return {
        ...record,
        openCount: usage?.openCount ?? 0,
        lastOpenedAt: usage?.lastOpenedAt
      };
    });

    const byTable = new Map<string, CatalogRecord[]>();
    for (const record of records) {
      const list = byTable.get(record.table);
      if (list) {
        list.push(record);
      } else {
        byTable.set(record.table, [record]);
      }
    }
    for (const list of byTable.values()) {
      list.sort((a, b) => compareRecords(a, b, sortBy));
    }
    this.byTable = byTable;
    this.tableOrder = [...byTable.keys()].sort((a, b) =>
      compareTables(a, b, byTable.get(a) ?? [], byTable.get(b) ?? [], sortBy)
    );
    this.allRecords = records.sort((a, b) => compareRecords(a, b, sortBy));
  }

  /**
   * Scan XML files with bounded concurrency to avoid serial I/O and memory spikes.
   */
  private async scanWorkspace(): Promise<CatalogRecord[]> {
    const ignoreGlobs = getIgnoreGlobs();
    const excludeDelete = this.excludeDelete();
    // Ignored paths are dropped during the walk rather than after it, so the
    // search never reports files the catalog would discard anyway.
    const uris = await vscode.workspace.findFiles(
      '**/*.xml',
      `{${[...SCAN_EXCLUDE_BASE, ...ignoreGlobs].join(',')}}`
    );
    const out: CatalogRecord[] = [];

    // Workers pull the next file as they finish rather than advancing in fixed
    // batches, so one multi-megabyte export cannot idle the other slots.
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(SCAN_CONCURRENCY, uris.length) }, async () => {
        while (next < uris.length) {
          const records = await this.readCatalogRecords(
            uris[next++],
            ignoreGlobs,
            excludeDelete
          );
          for (const record of records) {
            out.push(record);
          }
        }
      })
    );

    return out;
  }

  /**
   * Read one XML export and return all of its navigable record identities.
   */
  private async readCatalogRecords(
    uri: vscode.Uri,
    ignoreGlobs = getIgnoreGlobs(),
    excludeDelete = this.excludeDelete()
  ): Promise<CatalogRecord[]> {
    if (isPathIgnored(uri.fsPath, ignoreGlobs)) {
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
      .filter((identity) => !excludeDelete || identity.action !== 'DELETE')
      .map((identity) => {
        const usage = this.usage.get(uri, identity.sysId);
        return {
          table: identity.table,
          displayName: identity.displayName,
          sysId: identity.sysId,
          action: identity.action,
          apiName: identity.apiName,
          sysModCount: identity.sysModCount,
          startOffset: identity.startOffset,
          openCount: usage?.openCount ?? 0,
          lastOpenedAt: usage?.lastOpenedAt,
          uri,
          relativePath
        };
      });
  }

  /**
   * Fill in file modification times for indexed files that still lack them.
   *
   * Only the `recentlyUpdated` sort reads mtimes, so a scan skips the stat call
   * entirely — it would double the I/O calls per file for a value the other four
   * sort modes never touch. Callers invoke this when that sort is active: after a
   * scan, when the user switches to it, and after watcher updates replace rows.
   * Files that already carry an mtime are skipped, so repeat calls are cheap.
   */
  private async ensureMtimes(): Promise<void> {
    const pending = [...this.recordsByUri.values()].filter(
      (records) => records.length > 0 && records[0].mtimeMs === undefined
    );
    if (pending.length === 0) {
      return;
    }
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(SCAN_CONCURRENCY, pending.length) }, async () => {
        while (next < pending.length) {
          const records = pending[next++];
          const uri = records[0].uri;
          let mtimeMs: number;
          try {
            mtimeMs =
              uri.scheme === 'file'
                ? (await fs.stat(uri.fsPath)).mtimeMs
                : (await vscode.workspace.fs.stat(uri)).mtime;
          } catch {
            // Deleted between the scan and now; leave the rows unranked.
            continue;
          }
          for (const record of records) {
            record.mtimeMs = mtimeMs;
          }
        }
      })
    );
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
      const pattern = new vscode.RelativePattern(folder, '**/*.xml');
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidCreate((uri) => this.scheduleFileChange(uri));
      watcher.onDidChange((uri) => this.scheduleFileChange(uri));
      watcher.onDidDelete((uri) => this.scheduleFileChange(uri, true));
      this.watchers.push(watcher);
    }
  }

  /**
   * Debounce changed paths and update only those catalog entries.
   *
   * Watcher events are filtered by scheme here rather than at each watcher
   * because this is also the entry point for any future change source.
   */
  private scheduleFileChange(uri: vscode.Uri, deleted = false): void {
    if (!isWorkspaceSchemeUri(uri)) {
      return;
    }
    this.pendingFileChanges.set(uriKey(uri), deleted ? undefined : uri);
    if (this.watchDebounce) {
      clearTimeout(this.watchDebounce);
    }
    this.watchDebounce = setTimeout(() => {
      this.watchDebounce = undefined;
      void this.applyPendingFileChanges();
    }, 300);
  }

  /**
   * Apply watcher changes without rescanning unaffected XML files.
   */
  private async applyPendingFileChanges(): Promise<void> {
    if (!this.isEnabled() || !this.loaded) {
      this.pendingFileChanges.clear();
      return;
    }
    if (this.loading) {
      this.watchDebounce = setTimeout(() => {
        this.watchDebounce = undefined;
        void this.applyPendingFileChanges();
      }, 300);
      return;
    }

    const changes = [...this.pendingFileChanges.entries()];
    this.pendingFileChanges.clear();
    const generation = this.scanGeneration;
    const updated = await Promise.all(
      changes.map(async ([key, uri]) => ({
        key,
        records: uri ? await this.readCatalogRecords(uri) : []
      }))
    );

    if (
      !this.isEnabled() ||
      !this.loaded ||
      generation !== this.scanGeneration
    ) {
      return;
    }

    for (const { key, records } of updated) {
      if (records.length > 0) {
        this.recordsByUri.set(key, records);
      } else {
        this.recordsByUri.delete(key);
      }
    }
    this.rebuildViews();
    this.notify();

    // Replacement rows carry no mtime, and a changed file is exactly the one
    // this sort is meant to surface first.
    if (this.sortBy() === 'recentlyUpdated') {
      await this.ensureMtimes();
      if (this.isEnabled() && this.loaded) {
        this.rebuildViews();
        this.notify();
      }
    }
    await this.persistCache();
  }

  private stopWatching(): void {
    if (this.watchDebounce) {
      clearTimeout(this.watchDebounce);
      this.watchDebounce = undefined;
    }
    this.pendingFileChanges.clear();
    for (const w of this.watchers) {
      w.dispose();
    }
    this.watchers = [];
  }

  private clearAndStopWatching(): void {
    this.scanGeneration++;
    this.refreshQueued = false;
    this.stopWatching();
    this.byTable = new Map();
    this.allRecords = [];
    this.recordsByUri = new Map();
    this.tableOrder = [];
    this.loaded = false;
    this.cacheRestoreAttempted = false;
    this.restoredFromCache = false;
    this.cacheRevalidationStarted = false;
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/**
 * Compare two records for the active sort mode (missing metrics sort last).
 */
function compareRecords(
  a: CatalogRecord,
  b: CatalogRecord,
  sortBy: NavigatorSortBy
): number {
  let primary = 0;
  switch (sortBy) {
    case 'mostOpened':
      primary = b.openCount - a.openCount;
      break;
    case 'recentlyOpened':
      primary = compareOptionalDesc(a.lastOpenedAt, b.lastOpenedAt);
      break;
    case 'recentlyUpdated':
      primary = compareOptionalDesc(a.mtimeMs, b.mtimeMs);
      break;
    case 'sysModCount':
      primary = compareOptionalDesc(a.sysModCount, b.sysModCount);
      break;
    case 'name':
      primary = a.displayName.localeCompare(b.displayName);
      break;
  }
  if (primary !== 0) {
    return primary;
  }
  const byName = a.displayName.localeCompare(b.displayName);
  if (byName !== 0) {
    return byName;
  }
  const aSys = a.sysId ?? '';
  const bSys = b.sysId ?? '';
  const bySys = aSys.localeCompare(bSys);
  if (bySys !== 0) {
    return bySys;
  }
  return a.relativePath.localeCompare(b.relativePath);
}

/**
 * Compare table folders: name mode is alphabetical; usage modes use child aggregates.
 */
function compareTables(
  tableA: string,
  tableB: string,
  recordsA: CatalogRecord[],
  recordsB: CatalogRecord[],
  sortBy: NavigatorSortBy
): number {
  let primary = 0;
  switch (sortBy) {
    case 'name':
      primary = tableA.localeCompare(tableB);
      break;
    case 'mostOpened': {
      const sumA = recordsA.reduce((sum, r) => sum + r.openCount, 0);
      const sumB = recordsB.reduce((sum, r) => sum + r.openCount, 0);
      primary = sumB - sumA;
      break;
    }
    case 'recentlyOpened':
      primary = compareOptionalDesc(
        maxOptional(recordsA.map((r) => r.lastOpenedAt)),
        maxOptional(recordsB.map((r) => r.lastOpenedAt))
      );
      break;
    case 'recentlyUpdated':
      primary = compareOptionalDesc(
        maxOptional(recordsA.map((r) => r.mtimeMs)),
        maxOptional(recordsB.map((r) => r.mtimeMs))
      );
      break;
    case 'sysModCount':
      primary = compareOptionalDesc(
        maxOptional(recordsA.map((r) => r.sysModCount)),
        maxOptional(recordsB.map((r) => r.sysModCount))
      );
      break;
  }
  if (primary !== 0) {
    return primary;
  }
  return tableA.localeCompare(tableB);
}

/**
 * Descending compare where undefined values sort after defined ones.
 */
function compareOptionalDesc(
  a: number | undefined,
  b: number | undefined
): number {
  const aMissing = a === undefined;
  const bMissing = b === undefined;
  if (aMissing && bMissing) {
    return 0;
  }
  if (aMissing) {
    return 1;
  }
  if (bMissing) {
    return -1;
  }
  return b - a;
}

/**
 * Max of optional numbers, ignoring undefined.
 */
function maxOptional(values: Array<number | undefined>): number | undefined {
  let max: number | undefined;
  for (const value of values) {
    if (value === undefined) {
      continue;
    }
    if (max === undefined || value > max) {
      max = value;
    }
  }
  return max;
}
