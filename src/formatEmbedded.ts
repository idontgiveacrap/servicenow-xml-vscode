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

let xmlFormatReentry = false;

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
  if (xmlFormatReentry || !isSnXmlFormatTarget(document, isValidationAllowed)) {
    return undefined;
  }
  const offset = document.offsetAt(range.start);
  const hit = scriptAt(document.getText(), offset);
  if (hit?.role === 'scriptField') {
    const formatted = await formatOneScriptHit(hit, options, token);
    if (formatted === undefined || formatted === document.getText().slice(hit.hostStart, hit.hostEnd)) {
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
  if (xmlFormatReentry) {
    return undefined;
  }
  if (!isSnXmlFormatTarget(document, isValidationAllowed)) {
    return undefined;
  }

  const config = vscode.workspace.getConfiguration('servicenowXml', document);
  const formatJs = config.get<boolean>('formatJavaScript', true);
  const formatXmlFirst = config.get<boolean>('formatXmlFirst', true);

  let text = document.getText();

  if (formatXmlFirst) {
    xmlFormatReentry = true;
    let xmlEdits: vscode.TextEdit[] | undefined;
    try {
      xmlEdits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
        'vscode.executeFormatDocumentProvider',
        document.uri,
        options
      );
    } finally {
      xmlFormatReentry = false;
    }
    if (token.isCancellationRequested) {
      return undefined;
    }
    if (xmlEdits?.length) {
      text = applyTextEdits(text, xmlEdits, document);
    }
  }

  if (!formatJs) {
    if (text === document.getText()) {
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
  if (text === document.getText()) {
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
