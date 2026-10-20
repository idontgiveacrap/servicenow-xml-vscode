import * as vscode from 'vscode';
import { CatalogRecord } from './catalog';
import { removeRecordRow } from './removeRecordRow';

/**
 * Delete one Records navigator row from the filesystem.
 *
 * A file that exports only this record goes to the OS trash; a file that
 * exports several loses just this record's row, because deleting the file
 * would take the sibling records with it.
 *
 * This is the filesystem counterpart to authoring a deletion: nothing here
 * records an intent to remove the record on the instance, so the export simply
 * stops existing in the repo.
 */
export async function deleteRecordFromDisk(record: CatalogRecord): Promise<void> {
  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(record.uri);
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not delete record: ${describe(error)}`);
    return;
  }

  const relative = vscode.workspace.asRelativePath(record.uri);
  const result = removeRecordRow(document.getText(), record.uri.fsPath, record);

  if (result.outcome === 'not-found') {
    void vscode.window.showErrorMessage(
      `Could not delete "${record.displayName}" from ${relative}: ${result.reason}.`
    );
    return;
  }

  if (result.outcome === 'delete-file') {
    const confirm = await vscode.window.showWarningMessage(
      `Delete ${relative}?`,
      {
        modal: true,
        detail: `"${record.displayName}" (${record.table}) is the only record this export holds, so the file goes to the trash.`
      },
      'Delete File'
    );
    if (confirm !== 'Delete File') {
      return;
    }
    try {
      await vscode.workspace.fs.delete(record.uri, { useTrash: true });
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Could not delete ${relative}: ${describe(error)}`
      );
    }
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Remove "${record.displayName}" (${record.table}) from ${relative}?`,
    {
      modal: true,
      detail: `The file exports other records, so this row and any companion sys_update_version / sys_metadata_delete / delete_multiple rows for the same update name are removed. ${result.remaining} record${result.remaining === 1 ? '' : 's'} remain in the file.`
    },
    'Remove Record'
  );
  if (confirm !== 'Remove Record') {
    return;
  }

  try {
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length)
    );
    edit.replace(record.uri, fullRange, result.text);
    if (!(await vscode.workspace.applyEdit(edit))) {
      void vscode.window.showErrorMessage(
        `Could not remove "${record.displayName}" from ${relative}.`
      );
      return;
    }
    await document.save();
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Could not remove "${record.displayName}" from ${relative}: ${describe(error)}`
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
