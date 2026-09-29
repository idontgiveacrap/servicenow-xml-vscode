import * as vscode from 'vscode';
import { RecordCatalog, uriKey } from './catalog';
import { RecordsTreeProvider, TreeNode } from './tree';

/** Coalesce bursts of tab switches / row rebuilds into one sync. */
const SYNC_DEBOUNCE_MS = 50;

/**
 * Keeps the Records view in sync with the active editor: selects the first
 * record from the active file, scrolls it into view, and accents every row that
 * file exports.
 *
 * Selection is the primary indicator, matching `explorer.autoReveal` and the
 * Outline view — VS Code has no convention for an icon tint meaning "active
 * file", and having the selection sit on the last-clicked row while the accent
 * sat elsewhere read as two competing highlights. The accent stays because
 * `reveal` can only select one node, so it is what shows the remaining rows of
 * a file that exports several.
 *
 * Selection only moves when the active file changes, which is what keeps this
 * class from competing with the user's own clicks and with the selection VS
 * Code re-applies after a refresh (microsoft/vscode#192055).
 *
 * Reveal is skipped while the view is hidden because `TreeView.reveal` opens the
 * containing view, which would pop the ServiceNow sidebar open on every tab
 * switch. State is re-synced when the view becomes visible instead.
 */
export class ActiveRecordSync implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private syncTimer: NodeJS.Timeout | undefined;
  /**
   * URI key this class last moved the selection for. Reset whenever the active
   * editor stops pointing at an indexed record, so returning to that file
   * re-asserts the selection instead of leaving it on a stale row.
   */
  private selectedUriKey = '';

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
      this.selectedUriKey = '';
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
      this.selectedUriKey = '';
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
    // A live multi-selection is the user staging a bulk action — prune reads it
    // as its scope — so a tab switch must not collapse it to one row.
    const select =
      key !== this.selectedUriKey && this.treeView.selection.length <= 1;
    if (select) {
      this.selectedUriKey = key;
    }
    void Promise.resolve(
      this.treeView.reveal(target, { select, focus: false })
    ).catch((error: unknown) => {
      // A concurrent refresh can drop the node between lookup and reveal.
      console.warn(
        '[servicenow-xml] reveal active record failed:',
        error instanceof Error ? error.message : String(error)
      );
    });
  }
}
