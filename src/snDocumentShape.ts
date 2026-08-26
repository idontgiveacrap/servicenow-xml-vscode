import * as vscode from 'vscode';
import { parseExportFileName } from './fileName';

/**
 * Export roots and record tables that identify a ServiceNow payload.
 * Broader than any single kind profile on purpose: this only decides whether the
 * document is worth parsing, and the kind profiles still classify it afterwards.
 */
const SN_EXPORT_MARKER_RE =
  /<\s*(?:unload|record_update|sys_update_xml|sys_remote_update_set|sys_update_set)\b/i;

/** Lines scanned from the top; export roots appear within the first few. */
const PREFIX_LINE_LIMIT = 200;

/**
 * Schemes whose documents are buffers the user can actually edit and save.
 *
 * Diff and review documents (`git:`, `gitlens:`, `pr:`, and the quick-diff
 * original resource, whose path is the file path plus `.git`) are synced to the
 * extension host like any other document, and the XML language claims them
 * because it matches a leading `<?xml` line rather than the file extension.
 * Anything published against them shows up as a second, read-only `*.xml.git`
 * entry beside the real file.
 */
const EDITABLE_SCHEMES = new Set([
  'file',
  'untitled',
  'vscode-remote',
  'vscode-vfs'
]);

/**
 * True when the document is a real editable buffer rather than a diff, review,
 * or otherwise virtual copy of one. See {@link EDITABLE_SCHEMES}.
 */
export function isEditableDocument(document: vscode.TextDocument): boolean {
  return EDITABLE_SCHEMES.has(document.uri.scheme);
}

/**
 * Permissive document-level gate: true when the buffer looks like a ServiceNow
 * export even though the workspace has no `{sys_id}/sys_app_{sys_id}.xml` marker
 * (single-file windows, or an export opened from an unrelated project).
 *
 * Deliberately matches on the export basename convention or a root/table marker
 * near the top rather than on a successful classification, so a malformed or
 * truncated export still reaches the parser and reports its structure errors.
 * The prefix bound keeps this cheap enough to call per validation pass on the
 * multi-megabyte update sets ServiceNow can produce.
 */
export function looksLikeSnExportDocument(document: vscode.TextDocument): boolean {
  if (document.languageId !== 'xml' || !isEditableDocument(document)) {
    return false;
  }
  if (parseExportFileName(document.uri.fsPath)) {
    return true;
  }
  const prefix = document.getText(
    new vscode.Range(0, 0, Math.min(document.lineCount, PREFIX_LINE_LIMIT), 0)
  );
  return SN_EXPORT_MARKER_RE.test(prefix);
}
