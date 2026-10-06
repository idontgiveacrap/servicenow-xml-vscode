/**
 * XML document formatter: other XML providers via reentry, then JS and JSON
 * format of script- and JSON-typed fields through encodeThroughLayers.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ensureGitignoreEntry } from './jsonStringEditor/drafts';
import { looksLikeSnExportDocument } from './snDocumentShape';
import { parseSnXml } from './parseSnXml';
import {
  encodeHit,
  listJsonFields,
  listScriptFields,
  restoreIndent,
  scriptAt,
  stripIndent,
  type ScriptHit
} from './scriptHits';

/** Sub-directory under the workspace `.servicenow-xml/` for format scratch files. */
const FORMAT_TEMP_SUBDIR = path.join('.servicenow-xml', 'format-tmp');

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
    const formatted = await formatOneHit(hit, 'javascript', options, token);
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
  const formatJson = config.get<boolean>('formatJson', true);
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

  if (!formatJs && !formatJson) {
    if (text === original) {
      return [];
    }
    return [vscode.TextEdit.replace(fullRange(document), text)];
  }

  const parsed = parseSnXml(text, document.uri.fsPath);
  const targets: Array<{ hit: ScriptHit; language: 'javascript' | 'json' }> = [];
  if (formatJs) {
    for (const hit of listScriptFields(parsed)) {
      targets.push({ hit, language: 'javascript' });
    }
  }
  if (formatJson) {
    for (const hit of listJsonFields(parsed)) {
      targets.push({ hit, language: 'json' });
    }
  }

  const offsetEdits: Array<{ start: number; end: number; text: string }> = [];
  for (const { hit, language } of targets) {
    if (token.isCancellationRequested) {
      return undefined;
    }
    const encoded = await formatOneHit(hit, language, options, token);
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

async function formatOneHit(
  hit: ScriptHit,
  language: 'javascript' | 'json',
  options: vscode.FormattingOptions,
  token: vscode.CancellationToken
): Promise<string | undefined> {
  // A JSON formatter given a malformed document can drop or reorder the text it
  // cannot parse, which would silently destroy the field. Invalid JSON is
  // already surfaced by the JSON lint pass, so leave it untouched here.
  if (language === 'json' && !isParseableJson(hit.code)) {
    return undefined;
  }
  const stripped = stripIndent(hit.code, hit.indent);
  const formatted = await formatThroughProvider(stripped, language, options, token);
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

function isParseableJson(code: string): boolean {
  try {
    JSON.parse(code);
    return true;
  } catch {
    return false;
  }
}

/**
 * Format `code` with whichever provider is registered for `language`.
 *
 * Writes `code` to a scratch file under `.servicenow-xml/format-tmp/` (or the
 * OS temp dir when no workspace is open) and formats that file. `openTextDocument`
 * on a real file URI does not open a tab, unlike the untitled-document form which
 * in practice does — so the scratch file avoids leaking a tab per embedded
 * field. The file is deleted in a `finally` block.
 *
 * Falls back to an in-memory untitled document if the scratch file cannot be
 * created (read-only filesystem, etc.).
 */
async function formatThroughProvider(
  code: string,
  language: 'javascript' | 'json',
  options: vscode.FormattingOptions,
  token: vscode.CancellationToken
): Promise<string | undefined> {
  if (token.isCancellationRequested) {
    return undefined;
  }

  const temp = createFormatTempFile(code, language);
  if (temp) {
    try {
      const doc = await vscode.workspace.openTextDocument(temp.uri);
      const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
        'vscode.executeFormatDocumentProvider',
        doc.uri,
        options
      );
      if (!edits?.length) {
        return code;
      }
      return applyTextEdits(code, edits, doc);
    } finally {
      try {
        fs.rmSync(temp.path, { force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  }

  // Fallback: untitled in-memory document when a scratch file could not be created.
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument({
      language,
      content: code
    });
  } catch {
    return code;
  }
  const fallbackEdits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
    'vscode.executeFormatDocumentProvider',
    doc.uri,
    options
  );
  if (!fallbackEdits?.length) {
    return code;
  }
  return applyTextEdits(code, fallbackEdits, doc);
}

/** Temp-file info for the formatting scratch file. */
interface FormatTempFile {
  uri: vscode.Uri;
  path: string;
}

/**
 * Resolve the directory for formatting scratch files.
 *
 * Prefers `.servicenow-xml/format-tmp/` in the first workspace folder so the
 * files are gitignored and co-located with other extension data. Falls back to
 * a directory under the OS temp dir when no workspace folder is open.
 */
function resolveFormatTempDir(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder && folder.uri.scheme === 'file') {
    const dir = path.join(folder.uri.fsPath, FORMAT_TEMP_SUBDIR);
    try {
      fs.mkdirSync(dir, { recursive: true });
      ensureGitignoreEntry(folder.uri.fsPath);
      return dir;
    } catch {
      return undefined;
    }
  }
  // No workspace folder (or non-file scheme): use OS temp dir as a last resort.
  return undefined;
}

/**
 * Write `code` to a uniquely-named scratch file and return its path/URI.
 * Returns undefined if the file cannot be created.
 */
function createFormatTempFile(
  code: string,
  language: 'javascript' | 'json'
): FormatTempFile | undefined {
  const ext = language === 'javascript' ? '.js' : '.json';
  const baseDir =
    resolveFormatTempDir() ??
    path.join(os.tmpdir(), 'servicenow-xml-format-tmp');
  try {
    fs.mkdirSync(baseDir, { recursive: true });
    const tmpPath = path.join(
      baseDir,
      `format-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
    );
    fs.writeFileSync(tmpPath, code, 'utf8');
    return { uri: vscode.Uri.file(tmpPath), path: tmpPath };
  } catch {
    return undefined;
  }
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
