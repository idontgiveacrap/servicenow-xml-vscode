import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { CatalogRecord } from './catalog';
import {
  changeActionToDelete,
  electiveUpdatePathFor
} from './changeActionToDelete';
import { extractRecordIdentities } from './recordName';

const execFileAsync = promisify(execFile);

/** `git mv` only touches the local index; this trips when git itself hangs. */
const GIT_TIMEOUT_MS = 20_000;

/**
 * Author a deletion for one Records navigator row: rewrite `action` to DELETE
 * and file the export under the sibling `author_elective_update/` directory.
 *
 * Both halves matter. The DELETE row is what removes the record on install, and
 * `update/` is read as live source, so a DELETE left there makes later review
 * and indexing treat a deleted row as current config.
 *
 * The move is skipped, without complaint, when the file exports more than one
 * record: relocating it would drag the sibling rows out of `update/` while they
 * are still live. It is also skipped when the file has no `update/` ancestor to
 * swap. Either way the action flip still applies, so the deletion installs.
 */
export async function authorRecordDeletion(
  record: CatalogRecord
): Promise<void> {
  if (record.action !== 'INSERT_OR_UPDATE') {
    return;
  }

  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(record.uri);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Could not change action to DELETE: ${describe(error)}`
    );
    return;
  }

  const text = document.getText();
  const result = changeActionToDelete(text, record.uri.fsPath, record);
  if (!result.ok) {
    void vscode.window.showErrorMessage(
      `Could not change action to DELETE: ${result.reason}.`
    );
    return;
  }

  const destination =
    extractRecordIdentities(text, record.uri.fsPath).length === 1
      ? electiveUpdatePathFor(record.uri.fsPath)
      : undefined;

  const confirm = await vscode.window.showWarningMessage(
    `Change action of "${record.displayName}" (${record.table}) from INSERT_OR_UPDATE to DELETE?`,
    {
      modal: true,
      detail: destination
        ? `The file moves to ${vscode.workspace.asRelativePath(destination)}.`
        : undefined
    },
    'Change to DELETE'
  );
  if (confirm !== 'Change to DELETE') {
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
        'Could not apply action=DELETE change to the file.'
      );
      return;
    }
    await document.save();
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Could not change action to DELETE: ${describe(error)}`
    );
    return;
  }

  if (destination) {
    await moveToElectiveUpdate(record.uri, destination);
  }
}

/**
 * Move an export that is now a DELETE into `author_elective_update/`, carrying
 * any open editor on it across to the new path.
 *
 * Reports failures rather than throwing: the action flip has already been saved
 * by this point, so a failed move leaves a valid (if misfiled) deletion the user
 * can move by hand.
 */
async function moveToElectiveUpdate(
  source: vscode.Uri,
  destination: string
): Promise<void> {
  const target = vscode.Uri.file(destination);
  const relative = vscode.workspace.asRelativePath(target);

  let occupied = true;
  try {
    await vscode.workspace.fs.stat(target);
  } catch {
    occupied = false;
  }
  if (occupied) {
    void vscode.window.showErrorMessage(
      `Changed the action to DELETE but left the file in place: ${relative} already exists.`
    );
    return;
  }

  // A tab left on the old path would outlive the move as an editor over a file
  // that no longer exists, and saving it would recreate the record in update/.
  const staleTabs = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter(
      (tab) =>
        tab.input instanceof vscode.TabInputText &&
        tab.input.uri.toString() === source.toString()
    );
  const wasOpen = staleTabs.length > 0;
  if (wasOpen) {
    await vscode.window.tabGroups.close(staleTabs, true);
  }

  try {
    await vscode.workspace.fs.createDirectory(
      vscode.Uri.file(path.dirname(destination))
    );
    try {
      // Staging the rename keeps history on the record even though the DELETE
      // rewrite can drop content below git's rename-similarity threshold.
      await execFileAsync('git', ['mv', '--', source.fsPath, destination], {
        cwd: path.dirname(source.fsPath),
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true
      });
    } catch {
      // No repo, no git on PATH, or the file is untracked: a plain rename still
      // lands it in the right place, and git infers small renames on its own.
      await vscode.workspace.fs.rename(source, target, { overwrite: false });
    }
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Changed the action to DELETE but could not move the file to ${relative}: ${describe(error)}`
    );
    if (wasOpen) {
      await vscode.window.showTextDocument(source, { preview: false });
    }
    return;
  }

  if (wasOpen) {
    await vscode.window.showTextDocument(target, { preview: false });
  }
  // Worth saying: author_elective_update/ is ignored by default, so the row
  // simply disappears from the navigator once the catalog catches up.
  void vscode.window.showInformationMessage(`Moved the DELETE to ${relative}.`);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
