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
 * True when the filesystem path matches any ignore glob.
 */
export function isPathIgnored(fsPath: string, globs?: string[]): boolean {
  const patterns = globs ?? getIgnoreGlobs();
  const normalized = fsPath.replace(/\\/g, '/');
  return patterns.some((g) => minimatch(normalized, g, { dot: true }));
}
