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
}

export interface DraftRecord {
  code: string;
  meta: DraftMeta;
}

/**
 * Resolve the directory that stores JSON-string drafts for a host file.
 */
export function resolveDraftsDir(
  hostUri: vscode.Uri,
  globalStorageUri: vscode.Uri
): { dir: string; usedGlobalStorage: boolean } {
  const folder = vscode.workspace.getWorkspaceFolder(hostUri);
  if (folder) {
    return {
      dir: path.join(folder.uri.fsPath, DRAFTS_DIR_NAME, DRAFTS_SUBDIR),
      usedGlobalStorage: false
    };
  }
  return {
    dir: path.join(globalStorageUri.fsPath, DRAFTS_SUBDIR),
    usedGlobalStorage: true
  };
}

/**
 * Ensure drafts directory exists and workspace .gitignore lists .servicenow-xml/.
 */
export function ensureDraftsDir(dir: string, usedGlobalStorage: boolean): void {
  fs.mkdirSync(dir, { recursive: true });
  if (usedGlobalStorage) {
    return;
  }
  const workspaceRoot = path.dirname(path.dirname(dir));
  ensureGitignoreEntry(workspaceRoot);
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
