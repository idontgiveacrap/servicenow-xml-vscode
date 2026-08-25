import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  detectJsonStringAtOffset,
  makeDraftKey,
  type JsonStringHit
} from './detect';
import {
  detectEmbeddedScriptAtOffset,
  type EmbeddedScriptHit
} from '../embedded/layers';
import {
  deleteDraft,
  ensureDraftsDir,
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

  const { dir, usedGlobalStorage } = resolveDraftsDir(
    editor.document.uri,
    context.globalStorageUri
  );
  ensureDraftsDir(dir, usedGlobalStorage);

  let code = hit.editorCode;
  const existing = loadDraft(dir, hit.draftKey);
  if (existing) {
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
  const { dir, usedGlobalStorage } = resolveDraftsDir(
    editor.document.uri,
    context.globalStorageUri
  );
  ensureDraftsDir(dir, usedGlobalStorage);
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

  // The layer walk handles every encoding stack, including scripts nested in an
  // entity-encoded <payload>, so it goes first. The original JSON-string
  // detector stays as a fallback for values that are JSON but do not read as
  // code, which it still opens on the javascript(…) / *Script name rule.
  const layered = detectEmbeddedScriptAtOffset(text, offset);
  if (layered) {
    return toJsonStringHit(layered, doc.uri.fsPath, doc.version, stableId);
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
 * Adapt a layered hit to the shape the session, draft, and write-back code
 * already speak.
 */
function toJsonStringHit(
  hit: EmbeddedScriptHit,
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
    absoluteStart: hit.absoluteStart,
    absoluteEnd: hit.absoluteEnd,
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
    const { dir, usedGlobalStorage } = resolveDraftsDir(
      session.binding.hostUri,
      context.globalStorageUri
    );
    ensureDraftsDir(dir, usedGlobalStorage);
    const draftPath = path.join(dir, `${session.hit.draftKey}.js`);
    const draftDoc = await vscode.workspace.openTextDocument(
      vscode.Uri.file(draftPath)
    );
    await vscode.window.showTextDocument(draftDoc, { preview: false });
  }
}
