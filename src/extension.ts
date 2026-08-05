import * as vscode from 'vscode';
import { DiagnosticsController } from './diagnostics';
import { KindStatusBar } from './statusBar';

/**
 * Activate ServiceNow XML diagnostics (kind validation + embedded JS lint).
 * Syntax coloring is contributed via TextMate injection (no runtime hook needed).
 */
export function activate(context: vscode.ExtensionContext): void {
  const statusBar = new KindStatusBar();
  const diagnostics = new DiagnosticsController(statusBar);

  context.subscriptions.push(statusBar, diagnostics);

  context.subscriptions.push(
    vscode.commands.registerCommand('servicenowXml.showKind', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'xml') {
        void vscode.window.showInformationMessage(
          'Open a ServiceNow XML file to see its document kind.'
        );
        return;
      }
      void diagnostics.refresh(editor.document).then(() => {
        const label = statusBar.currentLabel;
        if (label) {
          void vscode.window.showInformationMessage(`ServiceNow XML kind: ${label}`);
        }
      });
    }),
    vscode.commands.registerCommand('servicenowXml.revalidate', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'xml') {
        return;
      }
      void diagnostics.refresh(editor.document);
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
      diagnostics.diagnosticCollection.delete(doc.uri);
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      diagnostics.refreshActiveEditor();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('servicenowXml')) {
        for (const doc of vscode.workspace.textDocuments) {
          if (doc.languageId === 'xml') {
            diagnostics.schedule(doc);
          }
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
