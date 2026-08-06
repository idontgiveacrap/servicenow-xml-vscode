import * as vscode from 'vscode';
import { getIgnoreGlobs, isPathIgnored } from '../ignorePaths';
import { extractRecordIdentities } from './recordName';
import { RecordUsageStore } from './usage';

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

/** One indexed ServiceNow record tied to its export file. */
export interface CatalogRecord {
  table: string;
  displayName: string;
  sysId?: string;
  action?: string;
  apiName?: string;
  sysModCount?: number;
  /** File modification time in ms (shared across rows in the same file). */
  mtimeMs?: number;
  openCount: number;
  lastOpenedAt?: number;
  uri: vscode.Uri;
  relativePath: string;
}

type CatalogListener = () => void;

/**
 * Lazy in-memory catalog of ServiceNow export records.
 * Performs no I/O until {@link ensure} or {@link refresh} is called while enabled.
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
  private readonly pendingFileChanges = new Map<string, vscode.Uri | undefined>();
  private readonly listeners = new Set<CatalogListener>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly usage: RecordUsageStore;

  constructor(workspaceState: vscode.Memento) {
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
            !e.affectsConfiguration('servicenowXml.navigator.includeDelete') &&
            !e.affectsConfiguration('servicenowXml.ignoreGlobs')
          ) {
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

  includeDelete(): boolean {
    return vscode.workspace
      .getConfiguration('servicenowXml')
      .get<boolean>('navigator.includeDelete', false);
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
    return this.recordsByUri.has(uri.toString());
  }

  /**
   * Record an open for every catalog row under this URI, then rebuild sort views.
   */
  recordDocumentOpen(uri: vscode.Uri): void {
    const records = this.recordsByUri.get(uri.toString());
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
    if (this.loaded) {
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
      this.applyRecords(records);
      this.startWatching();
      this.notify();
      progress?.report({ message: `Indexed ${records.length} records` });
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
      const key = record.uri.toString();
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
    const includeDelete = this.includeDelete();
    const uris = await vscode.workspace.findFiles(
      '**/*.xml',
      '**/{node_modules,.git}/**'
    );
    const out: CatalogRecord[] = [];

    const concurrency = 16;
    for (let start = 0; start < uris.length; start += concurrency) {
      const batch = uris.slice(start, start + concurrency);
      const recordGroups = await Promise.all(
        batch.map((uri) => this.readCatalogRecords(uri, ignoreGlobs, includeDelete))
      );
      for (const records of recordGroups) {
        out.push(...records);
      }
    }

    return out;
  }

  /**
   * Read one XML export and return all of its navigable record identities.
   */
  private async readCatalogRecords(
    uri: vscode.Uri,
    ignoreGlobs = getIgnoreGlobs(),
    includeDelete = this.includeDelete()
  ): Promise<CatalogRecord[]> {
    if (isPathIgnored(uri.fsPath, ignoreGlobs)) {
      return [];
    }
    let bytes: Uint8Array;
    let mtimeMs: number | undefined;
    try {
      const [fileBytes, stat] = await Promise.all([
        vscode.workspace.fs.readFile(uri),
        vscode.workspace.fs.stat(uri)
      ]);
      bytes = fileBytes;
      mtimeMs = stat.mtime;
    } catch {
      return [];
    }
    const identities = extractRecordIdentities(
      Buffer.from(bytes).toString('utf8'),
      uri.fsPath
    );
    const relativePath = vscode.workspace.asRelativePath(uri, false);
    return identities
      .filter((identity) => includeDelete || identity.action !== 'DELETE')
      .map((identity) => {
        const usage = this.usage.get(uri, identity.sysId);
        return {
          table: identity.table,
          displayName: identity.displayName,
          sysId: identity.sysId,
          action: identity.action,
          apiName: identity.apiName,
          sysModCount: identity.sysModCount,
          mtimeMs,
          openCount: usage?.openCount ?? 0,
          lastOpenedAt: usage?.lastOpenedAt,
          uri,
          relativePath
        };
      });
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
   */
  private scheduleFileChange(uri: vscode.Uri, deleted = false): void {
    this.pendingFileChanges.set(uri.toString(), deleted ? undefined : uri);
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
