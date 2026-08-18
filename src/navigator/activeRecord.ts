import * as vscode from 'vscode';
import { RecordCatalog } from './catalog';
import { RecordsTreeProvider, TreeNode } from './tree';

/** How long a navigator click suppresses the follow-up scroll-into-view. */
const SUPPRESS_REVEAL_MS = 1000;

/** Coalesce bursts of tab switches / tree refreshes into one sync. */
const SYNC_DEBOUNCE_MS = 50;

/**
 * Keeps the Records view in sync with the active editor: marks every indexed
 * record from the active file and scrolls the first visible one into view.
 *
 * Reveal is skipped while the view is hidden because `TreeView.reveal` opens the
 * containing view, which would pop the ServiceNow sidebar open on every tab
 * switch. State is re-synced when the view becomes visible instead.
 */
export class ActiveRecordSync implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private syncTimer: NodeJS.Timeout | undefined;
  /** Timestamp until which reveal is skipped (set by clicks in this view). */
  private suppressRevealUntil = 0;

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
      // indexed or was filtered out can become revealable later.
      this.treeProvider.onDidChangeTreeData(() => this.schedule())
    );
    this.schedule();
  }

  dispose(): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = undefined;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  /**
   * Skip the next scroll-into-view, for editor changes the user started from
   * this view (the tree already shows and selects the clicked row).
   */
  suppressNextReveal(): void {
    this.suppressRevealUntil = Date.now() + SUPPRESS_REVEAL_MS;
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

  private sync(): void {
    const suppressed = Date.now() < this.suppressRevealUntil;

    if (!this.catalog.isEnabled() || !this.catalog.isLoaded()) {
      this.treeProvider.setActiveUri(undefined);
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
    if (!indexed || suppressed || !this.treeView.visible) {
      return;
    }

    // Undefined when every row for this file is hidden by the active filter.
    const target = this.treeProvider.findFirstVisibleRecordNode(uri);
    if (!target) {
      return;
    }
    this.suppressRevealUntil = 0;
    void Promise.resolve(
      this.treeView.reveal(target, { select: true, focus: false })
    ).catch((error: unknown) => {
      // A concurrent refresh can drop the node between lookup and reveal.
      console.warn(
        '[servicenow-xml] reveal active record failed:',
        error instanceof Error ? error.message : String(error)
      );
    });
  }
}
