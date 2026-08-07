import * as vscode from 'vscode';
import { DiagnosticsController } from './diagnostics';
import { KindStatusBar } from './statusBar';
import { NavigatorSortBy, RecordCatalog } from './navigator/catalog';
import {
  getRecordUriFromTreeElement,
  RecordsDragAndDropController,
  RecordsTreeProvider,
  TreeNode
} from './navigator/tree';
import { registerGoToRecord } from './navigator/goToRecord';
import { SnWorkspaceGate } from './snWorkspaceGate';

const SORT_BY_PICKS: Array<{
  label: string;
  description: string;
  value: NavigatorSortBy;
}> = [
  {
    label: 'Most opened',
    description: 'Open count (sum per table)',
    value: 'mostOpened'
  },
  {
    label: 'Recently opened',
    description: 'Last open time',
    value: 'recentlyOpened'
  },
  {
    label: 'Recently updated',
    description: 'File modification time',
    value: 'recentlyUpdated'
  },
  {
    label: 'sys_mod_count',
    description: 'ServiceNow update count',
    value: 'sysModCount'
  },
  {
    label: 'Name',
    description: 'Alphabetical',
    value: 'name'
  }
];

/**
 * Activate ServiceNow XML diagnostics and the optional Records navigator.
 * Syntax coloring is contributed via TextMate injection (no runtime hook needed).
 * The tree provider is registered first so the Records view never sits without a provider.
 * Catalog indexing stays lazy until the view is used and navigator.enable is true.
 * Lint and the Records view stay gated until `{sys_id}/sys_app_{sys_id}.xml` is found
 * (or `enabledForAllWindows` bypasses the gate).
 */
export function activate(context: vscode.ExtensionContext): void {
  const gate = new SnWorkspaceGate();
  context.subscriptions.push(gate);

  // Register the Records tree before any heavier work so the activity-bar view
  // never shows "no data provider" if a later step fails or activation is delayed.
  const catalog = new RecordCatalog(context.workspaceState);
  const treeProvider = new RecordsTreeProvider(catalog);
  const treeView = vscode.window.createTreeView<TreeNode>('servicenowXml.records', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
    canSelectMany: true,
    dragAndDropController: new RecordsDragAndDropController(treeProvider)
  });
  context.subscriptions.push(
    catalog,
    treeProvider,
    treeView,
    treeView.onDidChangeVisibility((e) => {
      treeProvider.setViewVisible(e.visible);
    })
  );
  if (treeView.visible) {
    treeProvider.setViewVisible(true);
  }
  syncRecordsFilterUi(treeView, treeProvider);

  try {
    activateDiagnosticsAndCommands(context, catalog, treeProvider, treeView, gate);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[servicenow-xml] activation failed after tree registration:', error);
    void vscode.window.showErrorMessage(
      `ServiceNow XML activated the Records view, but other features failed: ${message}`
    );
  }
}

/**
 * Wire diagnostics, commands, and search after the Records tree is available.
 */
function activateDiagnosticsAndCommands(
  context: vscode.ExtensionContext,
  catalog: RecordCatalog,
  treeProvider: RecordsTreeProvider,
  treeView: vscode.TreeView<TreeNode>,
  gate: SnWorkspaceGate
): void {
  const statusBar = new KindStatusBar();
  const diagnostics = new DiagnosticsController(
    statusBar,
    () => gate.isLintActive(),
    () => gate.getWorkspaceAppSysId()
  );
  context.subscriptions.push(
    statusBar,
    diagnostics,
    gate.onDidChange(() => {
      for (const doc of vscode.workspace.textDocuments) {
        if (doc.languageId === 'xml') {
          diagnostics.schedule(doc);
        }
      }
      diagnostics.refreshActiveEditor();
    })
  );

  registerGoToRecord(context, catalog);

  context.subscriptions.push(
    vscode.commands.registerCommand('servicenowXml.showKind', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'xml') {
        void vscode.window.showInformationMessage(
          'Open a ServiceNow XML file to see its document kind.'
        );
        return;
      }
      diagnostics.refresh(editor.document);
      const label = statusBar.currentLabel;
      if (label) {
        void vscode.window.showInformationMessage(`ServiceNow XML kind: ${label}`);
      }
    }),
    vscode.commands.registerCommand('servicenowXml.revalidate', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'xml') {
        return;
      }
      diagnostics.refresh(editor.document);
    }),
    vscode.commands.registerCommand('servicenowXml.navigator.enable', async () => {
      await vscode.workspace
        .getConfiguration('servicenowXml')
        .update('navigator.enable', true, vscode.ConfigurationTarget.Workspace);
      treeProvider.refreshTree();
    }),
    vscode.commands.registerCommand('servicenowXml.navigator.refresh', async () => {
      if (!catalog.isEnabled()) {
        void vscode.window.showInformationMessage(
          'Enable servicenowXml.navigator.enable to use the Records navigator.'
        );
        return;
      }
      try {
        await catalog.refresh({ showProgress: true });
        treeProvider.refreshTree();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(
          `ServiceNow Records refresh failed: ${message}`
        );
      }
    }),
    vscode.commands.registerCommand('servicenowXml.navigator.sortBy', async () => {
      const current = catalog.sortBy();
      const picked = await vscode.window.showQuickPick(
        SORT_BY_PICKS.map((item) => ({
          ...item,
          description:
            item.value === current
              ? `${item.description} (current)`
              : item.description
        })),
        { title: 'Sort Records by', placeHolder: 'Choose sort order' }
      );
      if (!picked) {
        return;
      }
      await vscode.workspace
        .getConfiguration('servicenowXml')
        .update(
          'navigator.sortBy',
          picked.value,
          vscode.ConfigurationTarget.Workspace
        );
    }),
    vscode.commands.registerCommand('servicenowXml.navigator.filter', async () => {
      if (!catalog.isEnabled()) {
        void vscode.window.showInformationMessage(
          'Enable servicenowXml.navigator.enable to use the Records navigator.'
        );
        return;
      }
      const value = await vscode.window.showInputBox({
        title: 'Filter Records',
        prompt: 'Filter by name, table, api_name, sys_id, or path',
        value: treeProvider.getFilterQuery(),
        placeHolder: 'e.g. CompareRowForm or sys_script_include'
      });
      if (value === undefined) {
        return;
      }
      treeProvider.setFilterQuery(value);
      syncRecordsFilterUi(treeView, treeProvider);
    }),
    vscode.commands.registerCommand('servicenowXml.navigator.clearFilter', () => {
      treeProvider.clearFilter();
      syncRecordsFilterUi(treeView, treeProvider);
    }),
    vscode.commands.registerCommand(
      'servicenowXml.revealInExplorer',
      async (element?: unknown) => {
        const uri = getRecordUriFromTreeElement(element);
        if (!uri) {
          return;
        }
        await vscode.commands.executeCommand('revealInExplorer', uri);
      }
    ),
    vscode.commands.registerCommand(
      'servicenowXml.revealInFileExplorer',
      async (element?: unknown) => {
        const uri = getRecordUriFromTreeElement(element);
        if (!uri) {
          return;
        }
        await vscode.commands.executeCommand('revealFileInOS', uri);
      }
    )
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.languageId === 'xml') {
        diagnostics.schedule(doc);
        if (
          catalog.isEnabled() &&
          catalog.isLoaded() &&
          catalog.hasUri(doc.uri)
        ) {
          catalog.recordDocumentOpen(doc.uri);
        }
      }
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.languageId === 'xml') {
        diagnostics.schedule(e.document);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      diagnostics.close(doc);
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      diagnostics.refreshActiveEditor();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      const diagnosticsChanged =
        e.affectsConfiguration('servicenowXml.enable') ||
        e.affectsConfiguration('servicenowXml.enabledForAllWindows') ||
        e.affectsConfiguration('servicenowXml.lintJavaScript') ||
        e.affectsConfiguration('servicenowXml.lintJson') ||
        e.affectsConfiguration('servicenowXml.ignoreGlobs') ||
        e.affectsConfiguration('servicenowXml.debounceMs');
      if (diagnosticsChanged) {
        for (const doc of vscode.workspace.textDocuments) {
          if (doc.languageId === 'xml') {
            diagnostics.schedule(doc);
          }
        }
      }
      if (e.affectsConfiguration('servicenowXml.navigator')) {
        treeProvider.refreshTree();
        if (
          e.affectsConfiguration('servicenowXml.navigator.enable') &&
          treeView.visible &&
          catalog.isEnabled()
        ) {
          treeProvider.setViewVisible(true);
        }
      }
    })
  );

  for (const doc of vscode.workspace.textDocuments) {
    if (doc.languageId === 'xml') {
      diagnostics.schedule(doc);
    }
  }
  diagnostics.refreshActiveEditor();
}

/**
 * Sync the Records view filter banner and clear-filter context key.
 */
function syncRecordsFilterUi(
  treeView: vscode.TreeView<TreeNode>,
  treeProvider: RecordsTreeProvider
): void {
  const query = treeProvider.getFilterQuery();
  treeView.message = query ? `Filter: ${query}` : undefined;
  void vscode.commands.executeCommand(
    'setContext',
    'servicenowXml.recordsFiltered',
    Boolean(query)
  );
}

export function deactivate(): void {
  // Disposals handled via subscriptions
}
