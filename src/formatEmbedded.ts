/**
 * XML document formatter: other XML providers via reentry, then JS format of
 * script-typed fields through encodeThroughLayers.
 */

import * as vscode from 'vscode';
import { looksLikeSnExportDocument } from './snDocumentShape';
import { parseSnXml } from './parseSnXml';
import {
  encodeHit,
  listScriptFields,
  restoreIndent,
  scriptAt,
  stripIndent,
  type ScriptHit
} from './scriptHits';

/**
 * Documents currently inside the nested `executeFormatDocumentProvider` call, so
 * this provider can decline when the editor re-enters it for the same document.
 * Keyed per document rather than a single flag: a concurrent format of another
 * file would otherwise be silently skipped.
 */
const xmlFormatReentry = new Set<string>();

/**
 * Register document and range formatting for ServiceNow XML.
 */
export function registerEmbeddedFormatter(
  context: vscode.ExtensionContext,
  isValidationAllowed: (document: vscode.TextDocument) => boolean
): void {
  const selector: vscode.DocumentSelector = { language: 'xml' };
  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider(selector, {
      provideDocumentFormattingEdits: (document, options, token) =>
        formatSnXmlDocument(document, options, token, isValidationAllowed)
    }),
    vscode.languages.registerDocumentRangeFormattingEditProvider(selector, {
      provideDocumentRangeFormattingEdits: (
        document,
        range,
        options,
        token
      ) =>
        formatSnXmlRange(document, range, options, token, isValidationAllowed)
    })
  );
}

async function formatSnXmlRange(
  document: vscode.TextDocument,
  range: vscode.Range,
  options: vscode.FormattingOptions,
  token: vscode.CancellationToken,
  isValidationAllowed: (document: vscode.TextDocument) => boolean
): Promise<vscode.TextEdit[] | undefined> {
  if (
    xmlFormatReentry.has(document.uri.toString()) ||
    !isSnXmlFormatTarget(document, isValidationAllowed)
  ) {
    return undefined;
  }
  const text = document.getText();
  const offset = document.offsetAt(range.start);
  const hit = scriptAt(text, offset);
  if (hit?.role === 'scriptField') {
    const original = text.slice(hit.hostStart, hit.hostEnd);
    const formatted = await formatOneScriptHit(hit, options, token);
    if (formatted === undefined || formatted === original) {
      return [];
    }
    // Formatting the script is async, so the buffer can move while it runs. The
    // hit offsets came from the pre-format snapshot, and applying them to a
    // shifted buffer splices the formatted script over unrelated XML while
    // leaving part of the original behind — a silent duplication rather than a
    // failure. Abandon the format instead.
    if (
      token.isCancellationRequested ||
      document.getText().slice(hit.hostStart, hit.hostEnd) !== original
    ) {
      return [];
    }
    return [
      vscode.TextEdit.replace(
        new vscode.Range(
          document.positionAt(hit.hostStart),
          document.positionAt(hit.hostEnd)
        ),
        formatted
      )
    ];
  }
  return formatSnXmlDocument(document, options, token, isValidationAllowed);
}

async function formatSnXmlDocument(
  document: vscode.TextDocument,
  options: vscode.FormattingOptions,
  token: vscode.CancellationToken,
  isValidationAllowed: (document: vscode.TextDocument) => boolean
): Promise<vscode.TextEdit[] | undefined> {
  const reentryKey = document.uri.toString();
  if (xmlFormatReentry.has(reentryKey)) {
    return undefined;
  }
  if (!isSnXmlFormatTarget(document, isValidationAllowed)) {
    return undefined;
  }

  const config = vscode.workspace.getConfiguration('servicenowXml', document);
  const formatJs = config.get<boolean>('formatJavaScript', true);
  const formatXmlFirst = config.get<boolean>('formatXmlFirst', true);

  // Every edit below is expressed against this snapshot, so a buffer that moves
  // mid-format invalidates all of them.
  const original = document.getText();
  let text = original;

  if (formatXmlFirst) {
    xmlFormatReentry.add(reentryKey);
    let xmlEdits: vscode.TextEdit[] | undefined;
    try {
      xmlEdits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
        'vscode.executeFormatDocumentProvider',
        document.uri,
        options
      );
    } finally {
      xmlFormatReentry.delete(reentryKey);
    }
    if (token.isCancellationRequested || document.getText() !== original) {
      return undefined;
    }
    if (xmlEdits?.length) {
      text = applyTextEdits(text, xmlEdits, document);
    }
  }

  if (!formatJs) {
    if (text === original) {
      return [];
    }
    return [vscode.TextEdit.replace(fullRange(document), text)];
  }

  const parsed = parseSnXml(text, document.uri.fsPath);
  const hits = listScriptFields(parsed);
  const offsetEdits: Array<{ start: number; end: number; text: string }> = [];
  for (const hit of hits) {
    if (token.isCancellationRequested) {
      return undefined;
    }
    const encoded = await formatOneScriptHit(hit, options, token);
    if (encoded === undefined) {
      continue;
    }
    const current = text.slice(hit.hostStart, hit.hostEnd);
    if (encoded !== current) {
      offsetEdits.push({ start: hit.hostStart, end: hit.hostEnd, text: encoded });
    }
  }

  text = applyOffsetEdits(text, offsetEdits);
  // A buffer that moved while the scripts were formatting would have every edit
  // below it shifted, so the whole-document replacement built from the snapshot
  // no longer describes this document.
  if (document.getText() !== original || text === original) {
    return [];
  }
  return [vscode.TextEdit.replace(fullRange(document), text)];
}

function isSnXmlFormatTarget(
  document: vscode.TextDocument,
  isValidationAllowed: (document: vscode.TextDocument) => boolean
): boolean {
  if (document.languageId !== 'xml') {
    return false;
  }
  return isValidationAllowed(document) || looksLikeSnExportDocument(document);
}

async function formatOneScriptHit(
  hit: ScriptHit,
  options: vscode.FormattingOptions,
  token: vscode.CancellationToken
): Promise<string | undefined> {
  const stripped = stripIndent(hit.code, hit.indent);
  const formatted = await formatJavaScript(stripped, options, token);
  if (formatted === undefined) {
    return undefined;
  }
  const restored = restoreIndent(formatted, hit.indent);
  const encoded = encodeHit(hit, restored);
  if (!encoded.ok) {
    return undefined;
  }
  return encoded.text;
}

async function formatJavaScript(
  code: string,
  options: vscode.FormattingOptions,
  token: vscode.CancellationToken
): Promise<string | undefined> {
  if (token.isCancellationRequested) {
    return undefined;
  }
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument({
      language: 'javascript',
      content: code
    });
  } catch {
    return code;
  }
  const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
    'vscode.executeFormatDocumentProvider',
    doc.uri,
    options
  );
  if (!edits?.length) {
    return code;
  }
  return applyTextEdits(code, edits, doc);
}

function applyTextEdits(
  text: string,
  edits: vscode.TextEdit[],
  document: vscode.TextDocument
): string {
  const offsets = edits.map((e) => ({
    start: document.offsetAt(e.range.start),
    end: document.offsetAt(e.range.end),
    newText: e.newText
  }));
  offsets.sort((a, b) => b.start - a.start);
  let next = text;
  for (const e of offsets) {
    next = next.slice(0, e.start) + e.newText + next.slice(e.end);
  }
  return next;
}

function applyOffsetEdits(
  text: string,
  edits: Array<{ start: number; end: number; text: string }>
): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let next = text;
  for (const e of sorted) {
    next = next.slice(0, e.start) + e.text + next.slice(e.end);
  }
  return next;
}

function fullRange(document: vscode.TextDocument): vscode.Range {
  return new vscode.Range(
    document.positionAt(0),
    document.positionAt(document.getText().length)
  );
}
