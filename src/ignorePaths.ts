import { minimatch } from 'minimatch';
import * as vscode from 'vscode';

/**
 * Return configured ignore globs for ServiceNow XML paths.
 */
export function getIgnoreGlobs(): string[] {
  return (
    vscode.workspace
      .getConfiguration('servicenowXml')
      .get<string[]>('ignoreGlobs', ['**/author_elective_update/**']) ?? [
      '**/author_elective_update/**'
    ]
  );
}

/**
 * True when a URI lives on a workspace folder's own file system rather than in a
 * virtual mirror of it.
 *
 * Both workspace indexes are built from `findFiles`, which only ever returns
 * URIs in the folders' own scheme (`file`, or `vscode-vfs` in a virtual
 * workspace). File system watchers are not scheme-filtered, though: the Git
 * extension registers a provider for `git:` and fires change events whose path
 * is the working-tree path, so `**\/*.xml` matches and an unfiltered watcher
 * feeds the staged copy of a tracked export back into the index. That copy is
 * read-only, so it lands in the Records tree as a second, locked row for a
 * record that is already there.
 */
export function isWorkspaceSchemeUri(uri: vscode.Uri): boolean {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    return uri.scheme === 'file';
  }
  return folders.some((folder) => folder.uri.scheme === uri.scheme);
}

/**
 * True when the filesystem path matches any ignore glob.
 */
export function isPathIgnored(fsPath: string, globs?: string[]): boolean {
  const patterns = globs ?? getIgnoreGlobs();
  const normalized = fsPath.replace(/\\/g, '/');
  return patterns.some((g) => minimatch(normalized, g, { dot: true }));
}
