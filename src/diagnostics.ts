import * as vscode from 'vscode';
import { classifyAndValidate } from './kinds';
import { SnDiagnostic } from './kinds/types';
import { parseSnXml } from './parseSnXml';
import { extractJsonRegions, extractScriptRegions } from './scriptRegions';
import { lintScriptRegions } from './jsLint';
import { lintJsonRegions } from './jsonLint';
import { KindStatusBar } from './statusBar';
import { isPathIgnored } from './ignorePaths';
import {
  detectJavaScriptSupport,
  JavaScriptSupport
} from './javascriptSupport';

const COLLECTION_NAME = 'servicenowXml';

/**
 * Owns diagnostic collection, debounce timers, and kind status updates.
 */
export class DiagnosticsController implements vscode.Disposable {
  private readonly collection: vscode.DiagnosticCollection;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly statusBar: KindStatusBar;
  private readonly isValidationAllowed: (document: vscode.TextDocument) => boolean;
  private readonly getWorkspaceAppSysId: () => string | undefined;
  private readonly getWorkspaceJavaScriptSupport: () =>
    | JavaScriptSupport
    | undefined;

  constructor(
    statusBar: KindStatusBar,
    isValidationAllowed: (document: vscode.TextDocument) => boolean,
    getWorkspaceAppSysId: () => string | undefined = () => undefined,
    getWorkspaceJavaScriptSupport: () =>
      | JavaScriptSupport
      | undefined = () => undefined
  ) {
    this.collection = vscode.languages.createDiagnosticCollection(COLLECTION_NAME);
    this.statusBar = statusBar;
    this.isValidationAllowed = isValidationAllowed;
    this.getWorkspaceAppSysId = getWorkspaceAppSysId;
    this.getWorkspaceJavaScriptSupport = getWorkspaceJavaScriptSupport;
  }

  dispose(): void {
    for (const t of this.timers.values()) {
      clearTimeout(t);
    }
    this.timers.clear();
    this.collection.dispose();
  }

  schedule(document: vscode.TextDocument): void {
    if (document.languageId !== 'xml') {
      return;
    }
    const key = document.uri.toString();
    const existing = this.timers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    const ms = vscode.workspace
      .getConfiguration('servicenowXml')
      .get<number>('debounceMs', 400);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      this.refresh(document);
    }, ms);
    this.timers.set(key, timer);
  }

  /**
   * Cancel pending work and remove diagnostics when a document closes.
   */
  close(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
    this.collection.delete(document.uri);
  }

  /**
   * Parse and lint one XML document synchronously.
   * Ignores results when the document changed during work (version guard).
   */
  refresh(document: vscode.TextDocument): void {
    const config = vscode.workspace.getConfiguration('servicenowXml');
    if (!this.isValidationAllowed(document) || !config.get<boolean>('enable', true)) {
      this.collection.delete(document.uri);
      if (vscode.window.activeTextEditor?.document === document) {
        this.statusBar.clear();
      }
      return;
    }

    if (this.isIgnored(document)) {
      this.collection.delete(document.uri);
      if (vscode.window.activeTextEditor?.document === document) {
        this.statusBar.setIgnored();
      }
      return;
    }

    const version = document.version;
    const text = document.getText();
    const filePath = document.uri.fsPath;
    const parsed = parseSnXml(text, filePath);
    const classification = classifyAndValidate(parsed, {
      workspaceAppSysId: this.getWorkspaceAppSysId()
    });

    const snDiags: SnDiagnostic[] = [...classification.diagnostics];

    if (
      config.get<boolean>('lintJavaScript', true) &&
      classification.lintScripts &&
      parsed.wellFormed
    ) {
      const javascriptSupport = detectJavaScriptSupport(
        text,
        this.getWorkspaceJavaScriptSupport() ?? 'ES5'
      );
      const regions = extractScriptRegions(parsed, { javascriptSupport });
      snDiags.push(...lintScriptRegions(regions));
    }

    if (
      config.get<boolean>('lintJson', true) &&
      classification.lintJson &&
      parsed.wellFormed
    ) {
      const jsonRegions = extractJsonRegions(parsed);
      snDiags.push(...lintJsonRegions(jsonRegions));
    }

    if (document.version !== version) {
      return;
    }

    const vsDiags = snDiags.map((d) => toVsDiagnostic(d, document));
    this.collection.set(document.uri, vsDiags);

    if (vscode.window.activeTextEditor?.document === document) {
      this.statusBar.setKind(classification.kind, classification.label);
    }
  }

  refreshActiveEditor(): void {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === 'xml') {
      this.schedule(editor.document);
    } else {
      this.statusBar.clear();
    }
  }

  private isIgnored(document: vscode.TextDocument): boolean {
    return isPathIgnored(document.uri.fsPath);
  }
}

function toVsDiagnostic(
  d: SnDiagnostic,
  document: vscode.TextDocument
): vscode.Diagnostic {
  const start = clampPosition(document, d.line, d.character);
  const end = clampPosition(
    document,
    d.endLine ?? d.line,
    d.endCharacter ?? d.character + 1
  );
  const range = new vscode.Range(start, end);
  const severity = toSeverity(d.severity);
  const diagnostic = new vscode.Diagnostic(range, d.message, severity);
  diagnostic.source = 'ServiceNow XML';
  if (d.code) {
    diagnostic.code = d.code;
  }
  return diagnostic;
}

function toSeverity(level: SnDiagnostic['severity']): vscode.DiagnosticSeverity {
  switch (level) {
    case 'error':
      return vscode.DiagnosticSeverity.Error;
    case 'warning':
      return vscode.DiagnosticSeverity.Warning;
    case 'information':
      return vscode.DiagnosticSeverity.Information;
    case 'hint':
      return vscode.DiagnosticSeverity.Hint;
    default:
      return vscode.DiagnosticSeverity.Warning;
  }
}

function clampPosition(
  document: vscode.TextDocument,
  line: number,
  character: number
): vscode.Position {
  const maxLine = Math.max(0, document.lineCount - 1);
  const safeLine = Math.min(Math.max(0, line), maxLine);
  const lineLen = document.lineAt(safeLine).text.length;
  const safeChar = Math.min(Math.max(0, character), lineLen);
  return new vscode.Position(safeLine, safeChar);
}
