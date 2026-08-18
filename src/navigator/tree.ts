import * as vscode from 'vscode';
import { CatalogRecord, RecordCatalog, uriKey } from './catalog';
import { matchesQuery } from './goToRecord';
import { tableDecorationUri } from './gitStatus';

export type TreeNode = TableNode | RecordNode | MessageNode;

interface TableNode {
  kind: 'table';
  table: string;
  count: number;
}

interface RecordNode {
  kind: 'record';
  record: CatalogRecord;
}

interface MessageNode {
  kind: 'message';
  label: string;
  command?: string;
}

/**
 * Resolve a record URI from a Records tree context-menu element.
 */
export function getRecordUriFromTreeElement(
  element: unknown
): vscode.Uri | undefined {
  if (
    element &&
    typeof element === 'object' &&
    'kind' in element &&
    (element as TreeNode).kind === 'record'
  ) {
    return (element as RecordNode).record.uri;
  }
  return undefined;
}

/**
 * Drag records (and table folders as their visible child files) as `text/uri-list`.
 */
export class RecordsDragAndDropController
  implements vscode.TreeDragAndDropController<TreeNode>
{
  readonly dragMimeTypes = ['text/uri-list'];
  readonly dropMimeTypes: string[] = [];

  constructor(private readonly treeProvider: RecordsTreeProvider) {}

  /**
   * Pack dragged record file URIs into the data transfer.
   */
  handleDrag(
    source: readonly TreeNode[],
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): void {
    const seen = new Set<string>();
    const uris: string[] = [];
    for (const node of source) {
      for (const uri of this.treeProvider.getDragUris(node)) {
        const key = uri.toString();
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        uris.push(key);
      }
    }
    if (uris.length === 0) {
      return;
    }
    dataTransfer.set(
      'text/uri-list',
      new vscode.DataTransferItem(uris.join('\r\n'))
    );
  }

  /**
   * Records tree is an index, not a drop target.
   */
  handleDrop(): void {
    // no-op
  }
}

/**
 * Tree data provider: tables as folders, records as leaves (name + table description).
 * Does not scan until the view is visible and the navigator is enabled.
 */
export class RecordsTreeProvider
  implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    TreeNode | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private viewVisible = false;
  private loadError = '';
  /** Lowercased filter text; empty means show all. */
  private filterQuery = '';
  /** URI key of the file in the active editor; empty means no record is marked. */
  private activeUriKey = '';
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly catalog: RecordCatalog) {
    this.disposables.push(
      this.catalog.onDidChange(() => this._onDidChangeTreeData.fire()),
      this._onDidChangeTreeData
    );
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  /**
   * Current filter text as shown to the user (may be empty).
   */
  getFilterQuery(): string {
    return this.filterQuery;
  }

  /**
   * Apply a filter query (trimmed, lowercased) and refresh the tree.
   */
  setFilterQuery(query: string): void {
    this.filterQuery = query.trim().toLowerCase();
    this._onDidChangeTreeData.fire();
  }

  /**
   * Clear the tree filter and refresh.
   */
  clearFilter(): void {
    if (!this.filterQuery) {
      return;
    }
    this.filterQuery = '';
    this._onDidChangeTreeData.fire();
  }

  /**
   * Mark every record from `uri` as belonging to the active editor; pass undefined
   * to clear the marker. Returns true when the marker changed (tree refreshed).
   */
  setActiveUri(uri: vscode.Uri | undefined): boolean {
    const key = uri ? uriKey(uri) : '';
    if (key === this.activeUriKey) {
      return false;
    }
    this.activeUriKey = key;
    this._onDidChangeTreeData.fire();
    return true;
  }

  /**
   * First node for `uri` in current sort/filter order, or undefined when the file
   * has no node the tree would render (navigator off, catalog cold, file not
   * indexed, or every row hidden by the active filter).
   */
  findFirstVisibleRecordNode(uri: vscode.Uri): TreeNode | undefined {
    if (!this.catalog.isEnabled() || !this.catalog.isLoaded() || this.loadError) {
      return undefined;
    }
    const key = uriKey(uri);
    const tables = new Set(
      this.catalog.getRecordsForUri(uri).map((record) => record.table)
    );
    if (tables.size === 0) {
      return undefined;
    }
    // Walk in tree order so "first" matches what the user sees top-down.
    for (const table of this.catalog.getTables()) {
      if (!tables.has(table)) {
        continue;
      }
      for (const record of this.filteredRecordsForTable(table)) {
        if (uriKey(record.uri) === key) {
          return { kind: 'record', record };
        }
      }
    }
    return undefined;
  }

  /**
   * Parent lookup that `TreeView.reveal` requires; only records have a parent.
   */
  getParent(element: TreeNode): TreeNode | undefined {
    if (element.kind !== 'record') {
      return undefined;
    }
    const table = element.record.table;
    return {
      kind: 'table',
      table,
      count: this.filteredRecordsForTable(table).length
    };
  }

  /**
   * File URIs to include when dragging a tree node (respects the active filter).
   */
  getDragUris(node: TreeNode): vscode.Uri[] {
    if (node.kind === 'record') {
      return [node.record.uri];
    }
    if (node.kind === 'table') {
      return this.filteredRecordsForTable(node.table).map((r) => r.uri);
    }
    return [];
  }

  /**
   * Called when the SN Records view becomes visible or hidden.
   * Triggers a lazy catalog load only when visible and enabled.
   */
  setViewVisible(visible: boolean): void {
    this.viewVisible = visible;
    if (visible && this.catalog.isEnabled()) {
      this.loadError = '';
      void this.catalog
        .ensure({ showProgress: true })
        .catch((error: unknown) => {
          this.loadError =
            error instanceof Error ? error.message : String(error);
          void vscode.window.showErrorMessage(
            `ServiceNow Records indexing failed: ${this.loadError}`
          );
        })
        .finally(() => this._onDidChangeTreeData.fire());
    }
    this._onDidChangeTreeData.fire();
  }

  refreshTree(): void {
    this.loadError = '';
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element.kind === 'message') {
      const item = new vscode.TreeItem(
        element.label,
        vscode.TreeItemCollapsibleState.None
      );
      if (element.command) {
        item.command = {
          command: element.command,
          title: element.label
        };
      }
      return item;
    }

    if (element.kind === 'table') {
      const item = new vscode.TreeItem(
        element.table,
        this.filterQuery
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
      );
      item.description = String(element.count);
      // Stable ids keep expansion state across refreshes and let reveal resolve
      // the table → record chain. Filter count stays out of the id on purpose.
      item.id = `table:${element.table}`;
      item.contextValue = 'servicenowXml.table';
      // `symbol-folder` is the same glyph as `folder`, but VS Code treats the
      // `folder` id as "let the file icon theme draw this" once resourceUri is
      // set — which leaves no icon at all under themes without folder icons.
      item.iconPath = new vscode.ThemeIcon('symbol-folder');
      item.tooltip = `${element.table}\n${element.count} record${
        element.count === 1 ? '' : 's'
      }`;
      // Synthetic URI so the folder picks up the Git state rolled up from its
      // record files; record leaves get that from their own file URI.
      item.resourceUri = tableDecorationUri(element.table);
      return item;
    }

    const r = element.record;
    const isDelete = r.action === 'DELETE';
    const isActive = this.activeUriKey !== '' && uriKey(r.uri) === this.activeUriKey;
    const item = new vscode.TreeItem(
      isDelete ? strikeThroughText(r.displayName) : r.displayName,
      vscode.TreeItemCollapsibleState.None
    );
    item.description = isDelete ? `DELETE · ${r.table}` : r.table;
    item.id = `record:${r.table}|${uriKey(r.uri)}|${r.sysId ?? r.displayName}`;
    // Tooltip is filled in by resolveTreeItem; see the note there.
    item.resourceUri = r.uri;
    // Routed through our own command so a click from this view can suppress the
    // scroll-into-view that follows an editor change from elsewhere.
    item.command = {
      command: 'servicenowXml.navigator.openRecord',
      title: 'Open',
      arguments: [r]
    };
    item.contextValue = 'servicenowXml.record';
    // Tree selection can only hold one item, so every row from the active file
    // gets an accented icon; the first one also gets selected via reveal.
    item.iconPath = new vscode.ThemeIcon(
      isDelete ? 'trash' : 'file-code',
      isActive
        ? new vscode.ThemeColor('list.highlightForeground')
        : isDelete
          ? new vscode.ThemeColor('errorForeground')
          : undefined
    );
    return item;
  }

  /**
   * Build the record tooltip on hover, including the file's diagnostic counts.
   *
   * Counts are resolved here rather than in {@link getTreeItem} because they
   * would otherwise need a tree refresh on every diagnostics change, and each
   * refresh re-reveals the active record — distracting while editing. The cost
   * is a tooltip that can miss diagnostics published after the first hover.
   *
   * The counts are spelled out because VS Code colors a row amber once the file
   * has warnings, which reads like a Git/unsaved-change decoration.
   */
  resolveTreeItem(
    item: vscode.TreeItem,
    element: TreeNode,
    _token: vscode.CancellationToken
  ): vscode.TreeItem {
    if (element.kind !== 'record' || item.tooltip !== undefined) {
      return item;
    }
    const r = element.record;
    let errors = 0;
    let warnings = 0;
    for (const d of vscode.languages.getDiagnostics(r.uri)) {
      if (d.severity === vscode.DiagnosticSeverity.Error) {
        errors++;
      } else if (d.severity === vscode.DiagnosticSeverity.Warning) {
        warnings++;
      }
    }
    const problems = [
      errors ? `${errors} error${errors === 1 ? '' : 's'}` : undefined,
      warnings ? `${warnings} warning${warnings === 1 ? '' : 's'}` : undefined
    ].filter(Boolean);

    item.tooltip = [
      r.displayName,
      `Table: ${r.table}`,
      r.sysId ? `sys_id: ${r.sysId}` : undefined,
      r.apiName ? `api_name: ${r.apiName}` : undefined,
      r.action === 'DELETE' ? 'Action: DELETE' : undefined,
      this.activeUriKey !== '' && uriKey(r.uri) === this.activeUriKey
        ? 'In the active editor'
        : undefined,
      `File: ${r.relativePath}`,
      problems.length
        ? `Problems in this file: ${problems.join(', ')} — the colored name is from these, not from an unsaved or Git change`
        : undefined
    ]
      .filter(Boolean)
      .join('\n');
    return item;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!this.catalog.isEnabled()) {
      if (element) {
        return [];
      }
      return [
        {
          kind: 'message',
          label: 'Enable ServiceNow Records navigator…',
          command: 'servicenowXml.navigator.enable'
        }
      ];
    }

    if (!this.viewVisible && !this.catalog.isLoaded()) {
      // View contributed but not yet shown — avoid scanning
      if (element) {
        return [];
      }
      return [
        {
          kind: 'message',
          label: 'Open this view to index records'
        }
      ];
    }

    if (this.loadError) {
      if (element) {
        return [];
      }
      return [
        {
          kind: 'message',
          label: `Index failed: ${this.loadError}`,
          command: 'servicenowXml.navigator.refresh'
        }
      ];
    }

    if (!this.catalog.isLoaded()) {
      if (element) {
        return [];
      }
      return [{ kind: 'message', label: 'Indexing…' }];
    }

    if (!element) {
      const tables = this.filteredTables();
      if (tables.length === 0) {
        return [
          {
            kind: 'message',
            label: this.filterQuery
              ? 'No records match the filter'
              : 'No ServiceNow records found'
          }
        ];
      }
      return tables;
    }

    if (element.kind === 'table') {
      return this.filteredRecordsForTable(element.table).map((record) => ({
        kind: 'record' as const,
        record
      }));
    }

    return [];
  }

  /**
   * Tables with at least one matching record when filtered; otherwise all tables.
   */
  private filteredTables(): TableNode[] {
    const tables = this.catalog.getTables();
    const nodes: TableNode[] = [];
    for (const table of tables) {
      const count = this.filteredRecordsForTable(table).length;
      if (count === 0) {
        continue;
      }
      nodes.push({ kind: 'table', table, count });
    }
    return nodes;
  }

  /**
   * Records under a table, optionally narrowed by the active filter query.
   */
  private filteredRecordsForTable(table: string): CatalogRecord[] {
    const records = this.catalog.getRecordsForTable(table);
    if (!this.filterQuery) {
      return records;
    }
    return records.filter((record) => matchesQuery(record, this.filterQuery));
  }
}

/**
 * Apply combining long-stroke overlays so DELETE labels read as struck through.
 * VS Code TreeItem has no public strikethrough style API.
 */
function strikeThroughText(text: string): string {
  return Array.from(text, (ch) => `${ch}\u0336`).join('');
}
