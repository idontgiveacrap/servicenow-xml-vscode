import * as vscode from 'vscode';
import { RecordCatalog } from './catalog';
import { RecordsTreeProvider, TreeNode } from './tree';

/** Coalesce bursts of tab switches / row rebuilds into one sync. */
const SYNC_DEBOUNCE_MS = 50;

/**
 * Keeps the Records view in sync with the active editor: marks every indexed
 * record from the active file and scrolls the first one into view.
 *
 * Tree selection is deliberately left alone. `reveal` cannot set a multi-item
 * selection anyway, and selecting on every editor change put three writers on
 * one piece of state — this class, the user's clicks, and the selection VS Code
 * re-applies after a refresh — which is what made the marker flicker.
 *
 * Reveal is skipped while the view is hidden because `TreeView.reveal` opens the
 * containing view, which would pop the ServiceNow sidebar open on every tab
 * switch. State is re-synced when the view becomes visible instead.
 */
export class ActiveRecordSync implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private syncTimer: NodeJS.Timeout | undefined;

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
      // do not raise this event, so this cannot re-trigger itself.
      this.treeProvider.onDidChangeRecords(() => this.schedule())
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
    if (!indexed || !this.treeView.visible) {
      return;
    }

    // Undefined when every row for this file is hidden by the active filter.
    const target = this.treeProvider.findFirstVisibleRecordNode(uri);
    if (!target) {
      return;
    }
    void Promise.resolve(
      this.treeView.reveal(target, { select: false, focus: false })
    ).catch((error: unknown) => {
      // A concurrent refresh can drop the node between lookup and reveal.
      console.warn(
        '[servicenow-xml] reveal active record failed:',
        error instanceof Error ? error.message : String(error)
      );
    });
  }
}
