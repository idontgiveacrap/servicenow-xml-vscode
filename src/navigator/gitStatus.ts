import * as vscode from 'vscode';
import { RecordCatalog, uriKey } from './catalog';

/**
 * Scheme for the synthetic URIs attached to Records tree table folders.
 * A table folder groups records across directories, so it has no real path of
 * its own; a private scheme lets it carry decorations without those decorations
 * leaking into the file Explorer.
 */
const TABLE_SCHEME = 'servicenow-xml-table';

/**
 * Debounce for Git state churn. A single stage/commit/checkout produces several
 * repository state events, and each one would otherwise re-roll every table.
 */
const REBUILD_DEBOUNCE_MS = 150;

/**
 * File status codes from the built-in Git extension API (`vscode.git`).
 * Numeric values mirror `Status` in that extension's `api/git.d.ts`.
 */
enum GitStatus {
  INDEX_MODIFIED = 0,
  INDEX_ADDED = 1,
  INDEX_DELETED = 2,
  INDEX_RENAMED = 3,
  INDEX_COPIED = 4,
  MODIFIED = 5,
  DELETED = 6,
  UNTRACKED = 7,
  IGNORED = 8,
  INTENT_TO_ADD = 9,
  INTENT_TO_RENAME = 10,
  TYPE_CHANGED = 11,
  ADDED_BY_US = 12,
  ADDED_BY_THEM = 13,
  DELETED_BY_US = 14,
  DELETED_BY_THEM = 15,
  BOTH_ADDED = 16,
  BOTH_DELETED = 17,
  BOTH_MODIFIED = 18
}

interface StatusMeta {
  /** Badge letter the Git extension uses for this status. */
  letter: string;
  /** Status name the Git extension shows in its own tooltips. */
  text: string;
  /** Theme color id the Git extension colors this status with. */
  colorId: string;
  /** Git's severity ordering; the highest wins when a table mixes statuses. */
  priority: number;
  /** Git does not bubble deletions up to parent folders, so neither do we. */
  propagates: boolean;
}

/**
 * Letters, colors, and priorities copied from the Git extension so the Records
 * tree reads the same way as the Explorer under any theme.
 */
const STATUS_META: Readonly<Record<GitStatus, StatusMeta>> = {
  [GitStatus.INDEX_MODIFIED]: {
    letter: 'M',
    text: 'Index Modified',
    colorId: 'gitDecoration.stageModifiedResourceForeground',
    priority: 2,
    propagates: true
  },
  [GitStatus.INDEX_ADDED]: {
    letter: 'A',
    text: 'Index Added',
    colorId: 'gitDecoration.addedResourceForeground',
    priority: 1,
    propagates: true
  },
  [GitStatus.INDEX_DELETED]: {
    letter: 'D',
    text: 'Index Deleted',
    colorId: 'gitDecoration.stageDeletedResourceForeground',
    priority: 1,
    propagates: false
  },
  [GitStatus.INDEX_RENAMED]: {
    letter: 'R',
    text: 'Index Renamed',
    colorId: 'gitDecoration.renamedResourceForeground',
    priority: 1,
    propagates: true
  },
  [GitStatus.INDEX_COPIED]: {
    letter: 'C',
    text: 'Index Copied',
    colorId: 'gitDecoration.renamedResourceForeground',
    priority: 2,
    propagates: true
  },
  [GitStatus.MODIFIED]: {
    letter: 'M',
    text: 'Modified',
    colorId: 'gitDecoration.modifiedResourceForeground',
    priority: 2,
    propagates: true
  },
  [GitStatus.DELETED]: {
    letter: 'D',
    text: 'Deleted',
    colorId: 'gitDecoration.deletedResourceForeground',
    priority: 1,
    propagates: false
  },
  [GitStatus.UNTRACKED]: {
    letter: 'U',
    text: 'Untracked',
    colorId: 'gitDecoration.untrackedResourceForeground',
    priority: 1,
    propagates: true
  },
  [GitStatus.IGNORED]: {
    letter: 'I',
    text: 'Ignored',
    colorId: 'gitDecoration.ignoredResourceForeground',
    priority: 3,
    propagates: true
  },
  [GitStatus.INTENT_TO_ADD]: {
    letter: 'A',
    text: 'Intent to Add',
    colorId: 'gitDecoration.addedResourceForeground',
    priority: 1,
    propagates: true
  },
  [GitStatus.INTENT_TO_RENAME]: {
    letter: 'R',
    text: 'Intent to Rename',
    colorId: 'gitDecoration.renamedResourceForeground',
    priority: 1,
    propagates: true
  },
  [GitStatus.TYPE_CHANGED]: {
    letter: 'T',
    text: 'Type Changed',
    colorId: 'gitDecoration.modifiedResourceForeground',
    priority: 2,
    propagates: true
  },
  [GitStatus.ADDED_BY_US]: {
    letter: '!',
    text: 'Conflict: Added By Us',
    colorId: 'gitDecoration.conflictingResourceForeground',
    priority: 4,
    propagates: true
  },
  [GitStatus.ADDED_BY_THEM]: {
    letter: '!',
    text: 'Conflict: Added By Them',
    colorId: 'gitDecoration.conflictingResourceForeground',
    priority: 4,
    propagates: true
  },
  [GitStatus.DELETED_BY_US]: {
    letter: 'D',
    text: 'Conflict: Deleted By Us',
    colorId: 'gitDecoration.conflictingResourceForeground',
    priority: 4,
    propagates: true
  },
  [GitStatus.DELETED_BY_THEM]: {
    letter: 'D',
    text: 'Conflict: Deleted By Them',
    colorId: 'gitDecoration.conflictingResourceForeground',
    priority: 4,
    propagates: true
  },
  [GitStatus.BOTH_ADDED]: {
    letter: '!',
    text: 'Conflict: Both Added',
    colorId: 'gitDecoration.conflictingResourceForeground',
    priority: 4,
    propagates: true
  },
  [GitStatus.BOTH_DELETED]: {
    letter: '!',
    text: 'Conflict: Both Deleted',
    colorId: 'gitDecoration.conflictingResourceForeground',
    priority: 4,
    propagates: true
  },
  [GitStatus.BOTH_MODIFIED]: {
    letter: '!',
    text: 'Conflict: Both Modified',
    colorId: 'gitDecoration.conflictingResourceForeground',
    priority: 4,
    propagates: true
  }
};

/** One file with a pending Git change. */
export interface GitFileStatus {
  uri: vscode.Uri;
  status: GitStatus;
}

/** Subset of the `vscode.git` API surface this extension consumes. */
interface GitChange {
  readonly uri: vscode.Uri;
  readonly status: GitStatus;
}

interface GitRepositoryState {
  readonly indexChanges: GitChange[];
  readonly workingTreeChanges: GitChange[];
  readonly mergeChanges: GitChange[];
  /** Absent on older Git extension API builds. */
  readonly untrackedChanges?: GitChange[];
  readonly onDidChange: vscode.Event<void>;
}

interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: GitRepositoryState;
}

interface GitApi {
  readonly repositories: GitRepository[];
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
}

interface GitExtensionExports {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: vscode.Event<boolean>;
  getAPI(version: 1): GitApi;
}

/**
 * Synthetic URI for a Records tree table folder, so VS Code asks
 * {@link RecordsGitDecorationProvider} for that folder's decoration.
 */
export function tableDecorationUri(table: string): vscode.Uri {
  return vscode.Uri.from({ scheme: TABLE_SCHEME, path: `/${table}` });
}

/**
 * Mirror of the per-file Git status the built-in Git extension publishes.
 * Stays disconnected until {@link connect} is called, so a window that never
 * opens the navigator never touches Git.
 */
export class GitStatusTracker implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires when the set of changed files, or their statuses, changed. */
  readonly onDidChange = this._onDidChange.event;

  private extension: GitExtensionExports | undefined;
  private api: GitApi | undefined;
  private connecting = false;
  private disposed = false;
  private statuses = new Map<string, GitFileStatus>();
  private rebuildDebounce: NodeJS.Timeout | undefined;
  private readonly repoSubscriptions = new Map<GitRepository, vscode.Disposable>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      this._onDidChange,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('git.enabled') ||
          e.affectsConfiguration('git.decorations.enabled')
        ) {
          this.scheduleRebuild();
        }
      })
    );
  }

  dispose(): void {
    this.disposed = true;
    if (this.rebuildDebounce) {
      clearTimeout(this.rebuildDebounce);
      this.rebuildDebounce = undefined;
    }
    this.detachRepositories();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.statuses.clear();
  }

  /**
   * Attach to the built-in Git extension. Idempotent, and a no-op when Git is
   * not installed; activation failures degrade to "no Git data".
   */
  connect(): void {
    if (this.disposed || this.api || this.connecting) {
      return;
    }
    const extension =
      vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
    if (!extension) {
      return;
    }
    this.connecting = true;
    const exports = extension.isActive
      ? Promise.resolve(extension.exports)
      : extension.activate();
    void exports.then(
      (api) => {
        this.connecting = false;
        if (this.disposed) {
          return;
        }
        this.extension = api;
        this.disposables.push(api.onDidChangeEnablement(() => this.attachApi()));
        this.attachApi();
      },
      (error: unknown) => {
        this.connecting = false;
        console.error('[servicenow-xml] git extension unavailable:', error);
      }
    );
  }

  /** Files with a pending Git change (empty while Git decorations are off). */
  changedFiles(): Iterable<GitFileStatus> {
    return this.statuses.values();
  }

  private attachApi(): void {
    if (this.disposed) {
      return;
    }
    const extension = this.extension;
    if (!extension?.enabled) {
      this.detachRepositories();
      this.scheduleRebuild();
      return;
    }
    if (!this.api) {
      try {
        this.api = extension.getAPI(1);
      } catch (error) {
        console.error('[servicenow-xml] git API unavailable:', error);
        return;
      }
      this.disposables.push(
        this.api.onDidOpenRepository((repo) => this.watchRepository(repo)),
        this.api.onDidCloseRepository((repo) => this.unwatchRepository(repo))
      );
    }
    for (const repo of this.api.repositories) {
      this.watchRepository(repo);
    }
    this.scheduleRebuild();
  }

  private watchRepository(repo: GitRepository): void {
    if (!this.repoSubscriptions.has(repo)) {
      this.repoSubscriptions.set(
        repo,
        repo.state.onDidChange(() => this.scheduleRebuild())
      );
    }
    this.scheduleRebuild();
  }

  private unwatchRepository(repo: GitRepository): void {
    this.repoSubscriptions.get(repo)?.dispose();
    this.repoSubscriptions.delete(repo);
    this.scheduleRebuild();
  }

  private detachRepositories(): void {
    for (const subscription of this.repoSubscriptions.values()) {
      subscription.dispose();
    }
    this.repoSubscriptions.clear();
  }

  private scheduleRebuild(): void {
    if (this.disposed) {
      return;
    }
    if (this.rebuildDebounce) {
      clearTimeout(this.rebuildDebounce);
    }
    this.rebuildDebounce = setTimeout(() => {
      this.rebuildDebounce = undefined;
      this.rebuild();
    }, REBUILD_DEBOUNCE_MS);
  }

  private rebuild(): void {
    const next = new Map<string, GitFileStatus>();
    const git = vscode.workspace.getConfiguration('git');
    // Same switches that turn the Explorer's Git colors off.
    const gitDecorations =
      git.get<boolean>('enabled', true) &&
      git.get<boolean>('decorations.enabled', true);

    if (gitDecorations) {
      for (const repo of this.repoSubscriptions.keys()) {
        const state = repo.state;
        // Group order matches how the Git extension layers its own decorations:
        // later groups overwrite earlier ones for the same file.
        const groups = [
          state.indexChanges,
          state.untrackedChanges ?? [],
          state.workingTreeChanges,
          state.mergeChanges
        ];
        for (const group of groups) {
          for (const change of group) {
            next.set(uriKey(change.uri), {
              uri: change.uri,
              status: change.status
            });
          }
        }
      }
    }

    const unchanged =
      next.size === this.statuses.size &&
      [...next].every(
        ([key, value]) => this.statuses.get(key)?.status === value.status
      );
    if (unchanged) {
      return;
    }
    this.statuses = next;
    this._onDidChange.fire();
  }
}

/** Rolled-up Git state for one table folder. */
interface TableGitSummary {
  status: GitStatus;
  tooltip: string;
}

/**
 * Decorates Records tree table folders with the Git state of the record files
 * they contain. Record leaves need no help here: they carry the real file URI,
 * so VS Code already applies the Git extension's own decoration to them.
 */
export class RecordsGitDecorationProvider
  implements vscode.FileDecorationProvider, vscode.Disposable
{
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<
    vscode.Uri[]
  >();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  private summaries = new Map<string, TableGitSummary>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly catalog: RecordCatalog,
    private readonly git: GitStatusTracker
  ) {
    this.disposables.push(
      this._onDidChangeFileDecorations,
      this.git.onDidChange(() => this.rebuild()),
      this.catalog.onDidChange(() => {
        // Keep Git cold until the navigator has actually indexed something.
        if (this.catalog.isLoaded()) {
          this.git.connect();
        }
        this.rebuild();
      })
    );
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== TABLE_SCHEME) {
      return undefined;
    }
    const summary = this.summaries.get(uri.path.slice(1));
    if (!summary) {
      return undefined;
    }
    const meta: StatusMeta | undefined = STATUS_META[summary.status];
    if (!meta) {
      return undefined;
    }
    return new vscode.FileDecoration(
      meta.letter,
      summary.tooltip,
      new vscode.ThemeColor(meta.colorId)
    );
  }

  /**
   * Roll per-file Git status up to the tables holding those files. Only changed
   * files are visited, so cost tracks the size of the diff, not the catalog.
   */
  private rebuild(): void {
    const counts = new Map<string, Map<GitStatus, number>>();
    for (const change of this.git.changedFiles()) {
      const meta: StatusMeta | undefined = STATUS_META[change.status];
      if (!meta?.propagates) {
        continue;
      }
      // One file can hold several records; count it once per table.
      const tables = new Set(
        this.catalog.getRecordsForUri(change.uri).map((record) => record.table)
      );
      for (const table of tables) {
        let byStatus = counts.get(table);
        if (!byStatus) {
          byStatus = new Map<GitStatus, number>();
          counts.set(table, byStatus);
        }
        byStatus.set(change.status, (byStatus.get(change.status) ?? 0) + 1);
      }
    }

    const summaries = new Map<string, TableGitSummary>();
    for (const [table, byStatus] of counts) {
      const ranked = [...byStatus].sort(
        (a, b) =>
          STATUS_META[b[0]].priority - STATUS_META[a[0]].priority || b[1] - a[1]
      );
      const parts = ranked.map(
        ([status, files]) => `${files} ${STATUS_META[status].text}`
      );
      summaries.set(table, {
        status: ranked[0][0],
        tooltip: `Git: ${parts.join(', ')}`
      });
    }

    const affected = new Set([...this.summaries.keys(), ...summaries.keys()]);
    this.summaries = summaries;
    if (affected.size > 0) {
      this._onDidChangeFileDecorations.fire(
        [...affected].map((table) => tableDecorationUri(table))
      );
    }
  }
}
