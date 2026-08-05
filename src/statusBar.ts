import * as vscode from 'vscode';
import { DocumentKindId } from './kinds/types';

/**
 * Status bar item showing the classified ServiceNow XML kind for the active editor.
 */
export class KindStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  /** Last label shown for the active editor (for showKind command). */
  currentLabel = '';

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.item.name = 'ServiceNow XML Kind';
    this.item.tooltip = 'Classified ServiceNow XML document kind';
  }

  dispose(): void {
    this.item.dispose();
  }

  setKind(kind: DocumentKindId, label: string): void {
    this.currentLabel = label;
    this.item.text = `SN XML: ${label}`;
    this.item.tooltip = `Document kind: ${kind}`;
    this.item.backgroundColor =
      kind === 'not_xml'
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : kind === 'unknown_sn_xml'
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
    this.item.show();
  }

  setIgnored(): void {
    this.currentLabel = 'ignored';
    this.item.text = 'SN XML: ignored';
    this.item.tooltip = 'Path matches servicenowXml.ignoreGlobs';
    this.item.backgroundColor = undefined;
    this.item.show();
  }

  clear(): void {
    this.currentLabel = '';
    this.item.hide();
  }
}
