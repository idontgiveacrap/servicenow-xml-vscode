import * as vscode from 'vscode';
import { DiagnosticsController } from './diagnostics';
import { KindStatusBar } from './statusBar';
import { RecordCatalog } from './navigator/catalog';
import { RecordsTreeProvider } from './navigator/tree';
import { registerGoToRecord } from './navigator/goToRecord';

/**
 * Activate ServiceNow XML diagnostics and the optional Records navigator.
 * Syntax coloring is contributed via TextMate injection (no runtime hook needed).
 * The navigator does not scan until the view is opened or Go to Record is used.
 */
export function activate(context: vscode.ExtensionContext): void {
  const statusBar = new KindStatusBar();
  const diagnostics = new DiagnosticsController(statusBar);
  const catalog = new RecordCatalog();
  const treeProvider = new RecordsTreeProvider(catalog);

  context.subscriptions.push(statusBar, diagnostics, catalog, treeProvider);

  const treeView = vscode.window.createTreeView('servicenowXml.records', {
    treeDataProvider: treeProvider,
    showCollapseAll: true
  });
  context.subscriptions.push(
    treeView,
    treeView.onDidChangeVisibility((e) => {
      treeProvider.setViewVisible(e.visible);
    })
  );
  if (treeView.visible) {
    treeProvider.setViewVisible(true);
  }

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
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.languageId === 'xml') {
        diagnostics.schedule(doc);
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

export function deactivate(): void {
  // Disposals handled via subscriptions
}
