import * as vscode from 'vscode';
import { minimatch } from 'minimatch';
import { classifyAndValidate } from './kinds';
import { SnDiagnostic } from './kinds/types';
import { parseSnXml } from './parseSnXml';
import { extractJsonRegions, extractScriptRegions } from './scriptRegions';
import { lintScriptRegions } from './jsLint';
import { lintJsonRegions } from './jsonLint';
import { KindStatusBar } from './statusBar';

const COLLECTION_NAME = 'servicenowXml';

/**
 * Owns diagnostic collection, debounce timers, and kind status updates.
 */
export class DiagnosticsController {
  private readonly collection: vscode.DiagnosticCollection;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly statusBar: KindStatusBar;

  constructor(statusBar: KindStatusBar) {
    this.collection = vscode.languages.createDiagnosticCollection(COLLECTION_NAME);
    this.statusBar = statusBar;
  }

  dispose(): void {
    for (const t of this.timers.values()) {
      clearTimeout(t);
    }
    this.timers.clear();
    this.collection.dispose();
  }

  get diagnosticCollection(): vscode.DiagnosticCollection {
    return this.collection;
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
      void this.refresh(document);
    }, ms);
    this.timers.set(key, timer);
  }

  async refresh(document: vscode.TextDocument): Promise<void> {
    const config = vscode.workspace.getConfiguration('servicenowXml');
    if (!config.get<boolean>('enable', true)) {
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

    const text = document.getText();
    const filePath = document.uri.fsPath;
    const parsed = parseSnXml(text, filePath);
    const classification = classifyAndValidate(parsed);

    const snDiags: SnDiagnostic[] = [...classification.diagnostics];

    if (
      config.get<boolean>('lintJavaScript', true) &&
      classification.lintScripts &&
      parsed.wellFormed
    ) {
      const regions = extractScriptRegions(parsed);
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
    const globs =
      vscode.workspace
        .getConfiguration('servicenowXml')
        .get<string[]>('ignoreGlobs', ['**/author_elective_update/**']) ?? [];
    const fsPath = document.uri.fsPath.replace(/\\/g, '/');
    return globs.some((g) => minimatch(fsPath, g, { dot: true }));
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
