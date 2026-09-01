import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  detectJsonStringAtOffset,
  makeDraftKey,
  type JsonStringHit
} from './detect';
import {
  scriptAt,
  type ScriptHit
} from '../scriptHits';
import {
  deleteDraft,
  draftsDirsForWindow,
  ensureDraftsDir,
  listDrafts,
  loadDraft,
  promptDraftOpenChoice,
  resolveDraftsDir
} from './drafts';
import { JsonStringSessionManager } from './session';
import { onHostDocumentSaved, writeBackJsonString } from './writeBack';

/**
 * Register embedded JSON string editor commands and listeners.
 */
export function registerJsonStringEditor(
  context: vscode.ExtensionContext
): void {
  const sessions = new JsonStringSessionManager();
  context.subscriptions.push({ dispose: () => sessions.dispose() });

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'servicenowXml.editJsonStringCode',
      async () => {
        await openFromActiveEditor(context, sessions);
      }
    ),
    vscode.commands.registerCommand(
      'servicenowXml.loadJsonStringDraft',
      async () => {
        await loadDraftIntoSession(context, sessions);
      }
    ),
    vscode.commands.registerCommand(
      'servicenowXml.manageJsonStringDrafts',
      async () => {
        await manageDrafts(context);
      }
    ),
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      const session = sessions.getSessionForTempDocument(document);
      if (session) {
        await handleTempSave(context, session, document);
        return;
      }
      if (document.languageId === 'xml' || document.uri.fsPath.endsWith('.xml')) {
        onHostDocumentSaved(document, context.globalStorageUri);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      sessions.onTempClosed(document);
    })
  );
}

async function openFromActiveEditor(
  context: vscode.ExtensionContext,
  sessions: JsonStringSessionManager
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'xml') {
    void vscode.window.showInformationMessage(
      'Open a ServiceNow XML file and place the caret in an embedded script.'
    );
    return;
  }

  const hit = detectAtCaret(editor);
  if (!hit) {
    void vscode.window.showInformationMessage(
      'No script found at the caret. The value there does not read as JavaScript.'
    );
    return;
  }

  const { dir, usedGlobalStorage, workspaceRoot } = resolveDraftsDir(
    editor.document.uri,
    context.globalStorageUri
  );
  ensureDraftsDir(dir, workspaceRoot);

  let code = hit.editorCode;
  const existing = loadDraft(dir, hit.draftKey);
  // A draft holding what the XML already holds represents no unsaved work, so
  // there is nothing to choose between. Compared with line endings normalized
  // because the temp editor may have saved CRLF over an LF export. The draft
  // file is left in place: while it is pending a host save it is still the only
  // copy outside the buffer.
  const draftMatchesXml =
    existing !== null &&
    existing.code.replace(/\r\n/g, '\n') ===
      hit.editorCode.replace(/\r\n/g, '\n');
  if (existing && !draftMatchesXml) {
    const choice = await promptDraftOpenChoice(hit.keyPath);
    if (choice === 'cancel') {
      return;
    }
    if (choice === 'reset') {
      deleteDraft(dir, hit.draftKey);
      code = hit.editorCode;
    } else {
      code = existing.code;
    }
  }

  await sessions.openSession(hit, editor.document.uri, code);
  if (usedGlobalStorage) {
    void vscode.window.showInformationMessage(
      'No workspace folder: drafts are stored in extension global storage.'
    );
  }
}

/**
 * List every embedded-script draft in the window and delete the selected ones.
 *
 * Drafts are written whenever a write-back is refused or is waiting on a host
 * save, so they can outlive the edit that produced them; this is the only way to
 * see them without going digging in `.servicenow-xml/`.
 */
async function manageDrafts(context: vscode.ExtensionContext): Promise<void> {
  interface DraftPick extends vscode.QuickPickItem {
    dir: string;
    draftKey: string;
  }

  const picks: DraftPick[] = [];
  for (const { dir, label } of draftsDirsForWindow(context.globalStorageUri)) {
    for (const draft of listDrafts(dir)) {
      const status = draft.meta.pendingHostSave
        ? 'waiting for the XML file to be saved'
        : draft.meta.lastError
          ? `write-back failed: ${draft.meta.lastError}`
          : 'saved';
      picks.push({
        label: draft.meta.keyPath || draft.meta.fieldName,
        description: `${draft.meta.hostPath} · ${label}`,
        detail: `${status} · ${draft.meta.savedAt} · ${draft.code.length} chars`,
        dir,
        draftKey: draft.meta.draftKey
      });
    }
  }

  if (picks.length === 0) {
    void vscode.window.showInformationMessage(
      'No embedded-script drafts are stored for this window.'
    );
    return;
  }

  const selected = await vscode.window.showQuickPick(picks, {
    canPickMany: true,
    title: `Embedded script drafts (${picks.length})`,
    placeHolder: 'Select drafts to delete, or press Escape to just look'
  });
  if (!selected || selected.length === 0) {
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Delete ${selected.length} draft${selected.length === 1 ? '' : 's'}? The edited script in each is discarded.`,
    { modal: true },
    'Delete'
  );
  if (confirm !== 'Delete') {
    return;
  }

  for (const pick of selected) {
    deleteDraft(pick.dir, pick.draftKey);
  }
  void vscode.window.showInformationMessage(
    `Deleted ${selected.length} draft${selected.length === 1 ? '' : 's'}.`
  );
}

async function loadDraftIntoSession(
  context: vscode.ExtensionContext,
  sessions: JsonStringSessionManager
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'xml') {
    void vscode.window.showInformationMessage(
      'Place the caret on an embedded JSON script string in an XML file.'
    );
    return;
  }
  const hit = detectAtCaret(editor);
  if (!hit) {
    void vscode.window.showInformationMessage(
      'No eligible JSON script string at the caret.'
    );
    return;
  }
  const { dir, workspaceRoot } = resolveDraftsDir(
    editor.document.uri,
    context.globalStorageUri
  );
  ensureDraftsDir(dir, workspaceRoot);
  const draft = loadDraft(dir, hit.draftKey);
  if (!draft) {
    void vscode.window.showInformationMessage('No draft for this JSON string.');
    return;
  }
  await sessions.openSession(hit, editor.document.uri, draft.code);
}

function detectAtCaret(editor: vscode.TextEditor): JsonStringHit | null {
  const doc = editor.document;
  let offset = doc.offsetAt(editor.selection.active);
  if (!editor.selection.isEmpty) {
    offset = doc.offsetAt(editor.selection.start);
  }
  const text = doc.getText();
  const stableId = stableIdForUri(doc.uri);

  const hit = scriptAt(text, offset, {
    hostPath: doc.uri.fsPath,
    hostVersion: doc.version,
    stableHostId: stableId
  });
  if (hit) {
    return scriptHitToJsonStringHit(hit, doc.uri.fsPath, doc.version, stableId);
  }

  return detectJsonStringAtOffset(
    text,
    offset,
    doc.uri.fsPath,
    doc.version,
    stableId
  );
}

/**
 * Adapt a shared script hit to the session, draft, and write-back shape.
 */
function scriptHitToJsonStringHit(
  hit: ScriptHit,
  hostPath: string,
  hostVersion: number,
  stableHostId: string
): JsonStringHit {
  const keyPath = hit.keyPath || `${hit.tableName}.${hit.fieldName}`;
  return {
    hostPath,
    stableHostId,
    fieldName: hit.fieldName,
    keyPath,
    draftKey: makeDraftKey(stableHostId, hit.fieldName, keyPath),
    absoluteStart: hit.hostStart,
    absoluteEnd: hit.hostEnd,
    unescapedValue: hit.code,
    editorCode: hit.code,
    hadJavascriptWrapper: hit.layers.some((l) => l.kind === 'jsWrapper'),
    hostVersion,
    tableName: hit.tableName,
    layers: hit.layers
  };
}

function stableIdForUri(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (folder) {
    return path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, '/');
  }
  return uri.fsPath;
}

async function handleTempSave(
  context: vscode.ExtensionContext,
  session: NonNullable<
    ReturnType<JsonStringSessionManager['getSessionForTempDocument']>
  >,
  document: vscode.TextDocument
): Promise<void> {
  const code = document.getText();
  const result = await writeBackJsonString(
    session.binding,
    code,
    context.globalStorageUri
  );
  if (result.ok) {
    void vscode.window.setStatusBarMessage(
      'Embedded JSON script written to XML (save the XML file to clear the draft).',
      5000
    );
    return;
  }

  const picked = await vscode.window.showErrorMessage(
    `Write-back failed: ${result.error}${
      result.usedGlobalStorage ? ' (draft in global storage)' : ''
    }`,
    'Open Draft',
    'Dismiss'
  );
  if (picked === 'Open Draft') {
    const { dir, workspaceRoot } = resolveDraftsDir(
      session.binding.hostUri,
      context.globalStorageUri
    );
    ensureDraftsDir(dir, workspaceRoot);
    const draftPath = path.join(dir, `${session.hit.draftKey}.js`);
    const draftDoc = await vscode.workspace.openTextDocument(
      vscode.Uri.file(draftPath)
    );
    await vscode.window.showTextDocument(draftDoc, { preview: false });
  }
}
