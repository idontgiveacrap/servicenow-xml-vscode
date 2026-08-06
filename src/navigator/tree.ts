import * as vscode from 'vscode';
import { CatalogRecord, RecordCatalog } from './catalog';

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
        vscode.TreeItemCollapsibleState.Collapsed
      );
      item.description = String(element.count);
      item.contextValue = 'servicenowXml.table';
      item.iconPath = new vscode.ThemeIcon('folder');
      return item;
    }

    const r = element.record;
    const isDelete = r.action === 'DELETE';
    const item = new vscode.TreeItem(
      isDelete ? strikeThroughText(r.displayName) : r.displayName,
      vscode.TreeItemCollapsibleState.None
    );
    item.description = isDelete ? `DELETE · ${r.table}` : r.table;
    const tipLines = [
      r.displayName,
      `Table: ${r.table}`,
      r.sysId ? `sys_id: ${r.sysId}` : undefined,
      r.apiName ? `api_name: ${r.apiName}` : undefined,
      isDelete ? 'Action: DELETE' : undefined,
      `File: ${r.relativePath}`
    ].filter(Boolean);
    item.tooltip = tipLines.join('\n');
    item.resourceUri = r.uri;
    item.command = {
      command: 'vscode.open',
      title: 'Open',
      arguments: [r.uri]
    };
    item.contextValue = 'servicenowXml.record';
    item.iconPath = isDelete
      ? new vscode.ThemeIcon('trash', new vscode.ThemeColor('errorForeground'))
      : new vscode.ThemeIcon('file-code');
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
      const tables = this.catalog.getTables();
      if (tables.length === 0) {
        return [
          {
            kind: 'message',
            label: 'No ServiceNow records found'
          }
        ];
      }
      return tables.map((table) => ({
        kind: 'table' as const,
        table,
        count: this.catalog.getRecordsForTable(table).length
      }));
    }

    if (element.kind === 'table') {
      return this.catalog.getRecordsForTable(element.table).map((record) => ({
        kind: 'record' as const,
        record
      }));
    }

    return [];
  }
}

/**
 * Apply combining long-stroke overlays so DELETE labels read as struck through.
 * VS Code TreeItem has no public strikethrough style API.
 */
function strikeThroughText(text: string): string {
  return Array.from(text, (ch) => `${ch}\u0336`).join('');
}
