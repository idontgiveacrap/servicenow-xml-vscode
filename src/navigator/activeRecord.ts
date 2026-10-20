import * as vscode from 'vscode';
import { RecordCatalog, uriKey } from './catalog';
import { RecordsTreeProvider, TreeNode } from './tree';

/** Coalesce bursts of tab switches / row rebuilds into one sync. */
const SYNC_DEBOUNCE_MS = 50;

/**
 * VS Code reapplies the pre-refresh tree selection up to about 200ms after
 * `onDidChangeTreeData` (microsoft/vscode#192055). The correction pass waits
 * past that window, which is what used to leave the previous record highlighted
 * after the accent had already moved.
 */
const SELECTION_RESTORE_MS = 300;

/**
 * Keeps the Records view in sync with the active editor.
 *
 * Two different indicators:
 * - The icon accent (`list.highlightForeground`) marks every row the active
 *   file exports. `reveal` can select only one node, so the accent is what
 *   shows the other rows of a file that exports several.
 * - The tree selection is the row highlight, and the scope commands such as
 *   prune read. An empty selection, or a single record from another file,
 *   moves to the active file's first visible row. A multi-selection, a
 *   selected table folder, and a single record that already belongs to the
 *   active file stay put — those are a command scope or the user's own click.
 *
 * Reveal is skipped while the view is hidden because `TreeView.reveal` opens the
 * containing view, which would pop the ServiceNow sidebar open on every tab
 * switch. State is re-synced when the view becomes visible instead.
 */
export class ActiveRecordSync implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private syncTimer: NodeJS.Timeout | undefined;
  /** Correction pass for a selection VS Code restored after a tree refresh. */
  private selectionRestoreTimer: NodeJS.Timeout | undefined;
  /**
   * URI key of the active file this class last aligned. Cleared when the
   * editor leaves indexed records, so coming back counts as a new file.
   * Tracking the file, rather than a successful `reveal`, is what lets the
   * correction pass run after VS Code puts the previous row back.
   */
  private alignedUriKey = '';
  /**
   * A tab change asked for the highlight to move, and the selection-restore
   * window is still open. Catalog refreshes outside that window must not
   * take a row the user selected themselves.
   */
  private pendingSelectionAlign = false;

  constructor(
    private readonly treeView: vscode.TreeView<TreeNode>,
    private readonly treeProvider: RecordsTreeProvider,
    private readonly catalog: RecordCatalog
  ) {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule()),
      this.treeView.onDidChangeVisibility((e) => {
        if (e.visible) {
          this.schedule();
        }
      }),
      // Covers catalog loads/updates and filter changes: a record that was not
      // indexed or was filtered out can become revealable later. Marker updates
      // do not raise this event, so this cannot re-trigger itself. While a tab
      // change is still settling, this refresh is also what makes VS Code put
      // the previous selection back, so the correction waits until after it.
      this.treeProvider.onDidChangeRecords(() => {
        this.schedule();
        if (this.pendingSelectionAlign) {
          this.scheduleSelectionRestore();
        }
      })
    );
    this.schedule();
  }

  dispose(): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = undefined;
    }
    if (this.selectionRestoreTimer) {
      clearTimeout(this.selectionRestoreTimer);
      this.selectionRestoreTimer = undefined;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  schedule(): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined;
      this.sync();
    }, SYNC_DEBOUNCE_MS);
  }

  /**
   * One delayed re-check. Reset when another refresh arrives so the pass runs
   * after the last selection restore, not after an earlier one.
   */
  private scheduleSelectionRestore(): void {
    if (this.selectionRestoreTimer) {
      clearTimeout(this.selectionRestoreTimer);
    }
    this.selectionRestoreTimer = setTimeout(() => {
      this.selectionRestoreTimer = undefined;
      this.sync({ correctSelectionOnly: true });
    }, SELECTION_RESTORE_MS);
  }

  /**
   * Move the Records highlight onto the active file when the current selection
   * is empty or is a single record from somewhere else.
   *
   * `correctSelectionOnly` is the post-refresh pass: it reveals only when that
   * highlight is still on the wrong record, and it does not arm another pass.
   */
  private sync(options?: { correctSelectionOnly?: boolean }): void {
    const correctSelectionOnly = options?.correctSelectionOnly === true;
    if (!this.catalog.isEnabled() || !this.catalog.isLoaded()) {
      this.treeProvider.setActiveUri(undefined);
      this.alignedUriKey = '';
      this.pendingSelectionAlign = false;
      return;
    }

    const uri = vscode.window.activeTextEditor?.document.uri;
    if (!uri) {
      // Focus moved off the text editors entirely (terminal, webview, settings);
      // keep the last marker rather than flickering it off.
      return;
    }

    const indexed = this.catalog.getRecordsForUri(uri).length > 0;
    this.treeProvider.setActiveUri(indexed ? uri : undefined);
    if (!indexed) {
      this.alignedUriKey = '';
      this.pendingSelectionAlign = false;
      return;
    }
    if (!this.treeView.visible) {
      return;
    }

    // Undefined when every row for this file is hidden by the active filter.
    const target = this.treeProvider.findFirstVisibleRecordNode(uri);
    if (!target) {
      return;
    }

    const key = uriKey(uri);
    const fileChanged = key !== this.alignedUriKey;
    if (!correctSelectionOnly && fileChanged) {
      this.alignedUriKey = key;
    }
    const selection = this.treeView.selection;
    // Multi-select and a selected table folder are a command scope. A single
    // record from this file is the row the user clicked, including a non-first
    // row of a multi-record file. Empty, or one record from another file, is
    // the highlight left behind by the previous tab.
    let needsMove = false;
    if (selection.length === 0) {
      needsMove = true;
    } else if (selection.length === 1 && selection[0].kind === 'record') {
      needsMove = uriKey(selection[0].record.uri) !== key;
    }
    // The correction pass selects only while a tab change is still settling.
    // A stale timer must not treat a later file change as its own.
    const select =
      needsMove &&
      (correctSelectionOnly
        ? this.pendingSelectionAlign
        : fileChanged || this.pendingSelectionAlign);
    if (correctSelectionOnly) {
      this.pendingSelectionAlign = false;
      if (!select) {
        return;
      }
    } else if (select) {
      this.pendingSelectionAlign = true;
      this.scheduleSelectionRestore();
    } else if (fileChanged) {
      this.pendingSelectionAlign = false;
    }
    // A row of this file that is already selected (a click on a later record)
    // stays the scroll target. Otherwise scroll the first visible row.
    const kept =
      !select &&
      selection.length === 1 &&
      selection[0].kind === 'record' &&
      uriKey(selection[0].record.uri) === key
        ? selection[0]
        : undefined;
    void Promise.resolve(
      this.treeView.reveal(kept ?? target, { select, focus: false })
    ).catch((error: unknown) => {
      // A concurrent refresh can drop the node between lookup and reveal.
      console.warn(
        '[servicenow-xml] reveal active record failed:',
        error instanceof Error ? error.message : String(error)
      );
    });
  }
}
