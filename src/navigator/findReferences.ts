/**
 * Records navigator: find workspace references to a record's sys_id.
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import { offsetToPosition, parseSnXml } from '../parseSnXml';
import { findSysIdReferences } from '../registry/sysIdReferences';
import { getWorkspaceRegistryService } from '../registry/vscodeAdapter';
import type { CatalogRecord } from './catalog';

/**
 * Collect references to `record.sysId` and show them in the References peek.
 */
export async function findReferencesForRecord(
  record: CatalogRecord
): Promise<void> {
  if (!record.sysId) {
    void vscode.window.showInformationMessage('This record has no sys_id.');
    return;
  }

  const service = getWorkspaceRegistryService();
  const registry = service.registry;
  const openTextByUri = new Map<string, string>();
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme === 'file' && doc.isDirty) {
      openTextByUri.set(doc.uri.toString(), doc.getText());
    }
  }

  const exportUris = registry
    .listByKind('Record')
    .filter((symbol) => symbol.kind === 'Record' && symbol.uri)
    .map((symbol) => symbol.uri!);

  const hits = findSysIdReferences({
    sysId: record.sysId,
    referenceEdges: registry.listReferenceEdges(),
    exportUris,
    openTextByUri,
    readText: readWorkspaceExport
  });

  if (hits.length === 0) {
    void vscode.window.showInformationMessage(
      `No references to ${record.sysId} in the workspace.`
    );
    return;
  }

  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(record.uri);
  } catch {
    void vscode.window.showErrorMessage(
      'Could not open the record file to anchor references.'
    );
    return;
  }

  const anchor = anchorPositionForRecord(document, record);
  const locations = hits.map((hit) => locationForHit(hit, document, openTextByUri));

  await vscode.commands.executeCommand(
    'editor.action.showReferences',
    document.uri,
    anchor,
    locations
  );
}

function readWorkspaceExport(uri: string): string | undefined {
  try {
    const parsed = vscode.Uri.parse(uri);
    if (parsed.scheme !== 'file') {
      return undefined;
    }
    return fs.readFileSync(parsed.fsPath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Position on the record's own sys_id value, or the row opening tag when missing.
 */
function anchorPositionForRecord(
  document: vscode.TextDocument,
  record: CatalogRecord
): vscode.Position {
  const text = document.getText();
  const parsed = parseSnXml(text, document.uri.fsPath);
  const targetId = record.sysId?.toLowerCase();
  const row =
    parsed.rows.find(
      (candidate) =>
        candidate.startOffset === record.startOffset ||
        (targetId && candidate.sysId?.toLowerCase() === targetId)
    ) ?? parsed.rows[0];
  if (row?.sysIdLine !== undefined && row.sysIdCharacter !== undefined) {
    return new vscode.Position(row.sysIdLine, row.sysIdCharacter);
  }
  return document.positionAt(record.startOffset);
}

function locationForHit(
  hit: { uri: string; startOffset: number; endOffset: number },
  anchorDocument: vscode.TextDocument,
  openTextByUri: ReadonlyMap<string, string>
): vscode.Location {
  const uri = vscode.Uri.parse(hit.uri);
  if (hit.uri === anchorDocument.uri.toString()) {
    return new vscode.Location(
      uri,
      new vscode.Range(
        anchorDocument.positionAt(hit.startOffset),
        anchorDocument.positionAt(hit.endOffset)
      )
    );
  }
  const text =
    openTextByUri.get(hit.uri) ?? readWorkspaceExport(hit.uri) ?? '';
  const start = offsetToPosition(text, hit.startOffset);
  const end = offsetToPosition(text, hit.endOffset);
  return new vscode.Location(
    uri,
    new vscode.Range(
      new vscode.Position(start.line, start.character),
      new vscode.Position(end.line, end.character)
    )
  );
}
