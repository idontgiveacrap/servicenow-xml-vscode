import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

const DRAFTS_DIR_NAME = '.servicenow-xml';
const DRAFTS_SUBDIR = 'json-string-drafts';
const GITIGNORE_ENTRY = '.servicenow-xml/';

export interface DraftMeta {
  hostPath: string;
  fieldName: string;
  keyPath: string;
  hadJavascriptWrapper: boolean;
  savedAt: string;
  lastError?: string;
  pendingHostSave?: boolean;
  draftKey: string;
  /** Absolute token range in host after a successful buffer write-back. */
  absoluteStart?: number;
  absoluteEnd?: number;
  /**
   * SHA-256 of the exact text written into that range. The draft is the only
   * copy of the user's edit, so it is discarded only when the host still holds
   * this content — a range that merely exists is not evidence of the write.
   */
  writtenSha256?: string;
}

export interface DraftRecord {
  code: string;
  meta: DraftMeta;
}

/**
 * Resolve the directory that stores JSON-string drafts for a host file.
 *
 * Returns the workspace root alongside it so callers never have to recover it by
 * walking back up from `dir` — that derivation silently pointed the `.gitignore`
 * write at whatever sat two levels above the drafts directory.
 */
export function resolveDraftsDir(
  hostUri: vscode.Uri,
  globalStorageUri: vscode.Uri
): { dir: string; usedGlobalStorage: boolean; workspaceRoot?: string } {
  const folder = vscode.workspace.getWorkspaceFolder(hostUri);
  if (folder) {
    return {
      dir: path.join(folder.uri.fsPath, DRAFTS_DIR_NAME, DRAFTS_SUBDIR),
      usedGlobalStorage: false,
      workspaceRoot: folder.uri.fsPath
    };
  }
  return {
    dir: path.join(globalStorageUri.fsPath, DRAFTS_SUBDIR),
    usedGlobalStorage: true
  };
}

/**
 * Ensure the drafts directory exists. When a workspace root is given, its
 * `.gitignore` is also updated to list the drafts root; global-storage drafts
 * live outside any repository and pass no root.
 */
export function ensureDraftsDir(dir: string, workspaceRoot?: string): void {
  fs.mkdirSync(dir, { recursive: true });
  if (workspaceRoot) {
    ensureGitignoreEntry(workspaceRoot);
  }
}

/**
 * Append .servicenow-xml/ to .gitignore when missing.
 */
export function ensureGitignoreEntry(workspaceRoot: string): void {
  const gitignorePath = path.join(workspaceRoot, '.gitignore');
  let existing = '';
  if (fs.existsSync(gitignorePath)) {
    existing = fs.readFileSync(gitignorePath, 'utf8');
    if (gitignoreHasEntry(existing, GITIGNORE_ENTRY)) {
      return;
    }
    const sep = existing.endsWith('\n') || existing.length === 0 ? '' : '\n';
    fs.writeFileSync(
      gitignorePath,
      `${existing}${sep}${GITIGNORE_ENTRY}\n`,
      'utf8'
    );
    return;
  }
  fs.writeFileSync(gitignorePath, `${GITIGNORE_ENTRY}\n`, 'utf8');
}

/**
 * True when .gitignore already ignores the drafts root.
 */
export function gitignoreHasEntry(content: string, entry: string): boolean {
  const normalized = entry.replace(/\\/g, '/').replace(/\/$/, '');
  return content.split(/\r?\n/).some((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) {
      return false;
    }
    const n = t.replace(/\\/g, '/').replace(/\/$/, '');
    return n === normalized || n === `${normalized}/`;
  });
}

/**
 * Save a draft for a failed or pending write-back.
 */
export function saveDraft(
  draftsDir: string,
  draftKey: string,
  code: string,
  meta: Omit<DraftMeta, 'draftKey' | 'savedAt'> & { savedAt?: string }
): DraftRecord {
  fs.mkdirSync(draftsDir, { recursive: true });
  const record: DraftRecord = {
    code,
    meta: {
      ...meta,
      draftKey,
      savedAt: meta.savedAt ?? new Date().toISOString()
    }
  };
  fs.writeFileSync(path.join(draftsDir, `${draftKey}.js`), code, 'utf8');
  fs.writeFileSync(
    path.join(draftsDir, `${draftKey}.json`),
    `${JSON.stringify(record.meta, null, 2)}\n`,
    'utf8'
  );
  return record;
}

/**
 * Load a draft by key, or null if missing.
 */
export function loadDraft(
  draftsDir: string,
  draftKey: string
): DraftRecord | null {
  const jsPath = path.join(draftsDir, `${draftKey}.js`);
  const metaPath = path.join(draftsDir, `${draftKey}.json`);
  if (!fs.existsSync(jsPath) || !fs.existsSync(metaPath)) {
    return null;
  }
  try {
    const code = fs.readFileSync(jsPath, 'utf8');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as DraftMeta;
    return { code, meta };
  } catch {
    return null;
  }
}

/**
 * Every drafts directory this window could have written to: one per workspace
 * folder, plus the global-storage fallback used for hosts outside any folder.
 */
export function draftsDirsForWindow(
  globalStorageUri: vscode.Uri
): Array<{ dir: string; label: string }> {
  const dirs = (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
    dir: path.join(folder.uri.fsPath, DRAFTS_DIR_NAME, DRAFTS_SUBDIR),
    label: folder.name
  }));
  dirs.push({
    dir: path.join(globalStorageUri.fsPath, DRAFTS_SUBDIR),
    label: 'no workspace folder'
  });
  return dirs;
}

/**
 * Drafts stored in one directory, most recently saved first.
 */
export function listDrafts(draftsDir: string): DraftRecord[] {
  if (!fs.existsSync(draftsDir)) {
    return [];
  }
  const out: DraftRecord[] = [];
  for (const name of fs.readdirSync(draftsDir)) {
    if (!name.endsWith('.json')) {
      continue;
    }
    const record = loadDraft(draftsDir, name.slice(0, -'.json'.length));
    if (record) {
      out.push(record);
    }
  }
  return out.sort((a, b) => b.meta.savedAt.localeCompare(a.meta.savedAt));
}

/**
 * Delete draft files for a key.
 */
export function deleteDraft(draftsDir: string, draftKey: string): void {
  for (const ext of ['.js', '.json']) {
    const p = path.join(draftsDir, `${draftKey}${ext}`);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
    }
  }
}

export type DraftOpenChoice = 'use' | 'reset' | 'cancel';

/**
 * Ask how to handle an existing draft when opening an editor.
 */
export async function promptDraftOpenChoice(
  keyPath: string
): Promise<DraftOpenChoice> {
  const picked = await vscode.window.showWarningMessage(
    `A draft exists for ${keyPath}. Use the draft, reset to XML (discard draft), or cancel?`,
    { modal: true },
    'Use Draft',
    'Reset to XML',
    'Cancel'
  );
  if (picked === 'Use Draft') {
    return 'use';
  }
  if (picked === 'Reset to XML') {
    return 'reset';
  }
  return 'cancel';
}
