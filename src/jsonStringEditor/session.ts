import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { JsonStringHit } from './detect';
import type { WriteBackBinding } from './writeBack';

const TEMP_ROOT = path.join(os.tmpdir(), 'servicenow-xml-json-string-editor');

export interface EditorSession {
  draftKey: string;
  safeFileName: string;
  tempUri: vscode.Uri;
  binding: WriteBackBinding;
  hit: JsonStringHit;
}

/**
 * Manages temp JS editors bound to host JSON string ranges.
 */
export class JsonStringSessionManager {
  private readonly byDraftKey = new Map<string, EditorSession>();
  private readonly byTempBase = new Map<string, EditorSession>();

  /**
   * Open or focus a temp editor for the given hit with the provided code body.
   */
  async openSession(
    hit: JsonStringHit,
    hostUri: vscode.Uri,
    code: string
  ): Promise<EditorSession> {
    const existing = this.byDraftKey.get(hit.draftKey);
    if (existing && !this.isClosed(existing)) {
      existing.hit = hit;
      existing.binding = {
        hit,
        hostUri,
        hostVersion: hit.hostVersion,
        absoluteStart: hit.absoluteStart,
        absoluteEnd: hit.absoluteEnd
      };
      await this.replaceTempContent(existing, code);
      await vscode.window.showTextDocument(existing.tempUri, {
        viewColumn: vscode.ViewColumn.Beside,
        preview: false,
        preserveFocus: false
      });
      return existing;
    }

    fs.mkdirSync(TEMP_ROOT, { recursive: true });
    const safeFileName = this.makeSafeFileName(hit);
    const tempPath = path.join(TEMP_ROOT, `${safeFileName}.js`);
    fs.writeFileSync(tempPath, code, 'utf8');
    const tempUri = vscode.Uri.file(tempPath);
    const doc = await vscode.workspace.openTextDocument(tempUri);
    await vscode.languages.setTextDocumentLanguage(doc, 'javascript');
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: false
    });

    const session: EditorSession = {
      draftKey: hit.draftKey,
      safeFileName,
      tempUri,
      hit,
      binding: {
        hit,
        hostUri,
        hostVersion: hit.hostVersion,
        absoluteStart: hit.absoluteStart,
        absoluteEnd: hit.absoluteEnd
      }
    };
    this.byDraftKey.set(hit.draftKey, session);
    this.byTempBase.set(safeFileName, session);
    return session;
  }

  /**
   * Resolve a session from a saved temp document.
   */
  getSessionForTempDocument(
    document: vscode.TextDocument
  ): EditorSession | undefined {
    if (!document.uri.fsPath.includes('servicenow-xml-json-string-editor')) {
      return undefined;
    }
    const base = path.parse(document.uri.fsPath).name;
    return this.byTempBase.get(base);
  }

  /**
   * Resolve session by draft key.
   */
  getSessionByDraftKey(draftKey: string): EditorSession | undefined {
    return this.byDraftKey.get(draftKey);
  }

  /**
   * Drop session when temp editor closes; delete temp file.
   */
  onTempClosed(document: vscode.TextDocument): void {
    const session = this.getSessionForTempDocument(document);
    if (!session) {
      return;
    }
    this.byDraftKey.delete(session.draftKey);
    this.byTempBase.delete(session.safeFileName);
    try {
      if (fs.existsSync(session.tempUri.fsPath)) {
        fs.unlinkSync(session.tempUri.fsPath);
      }
    } catch {
      // ignore cleanup errors
    }
  }

  /**
   * Dispose all sessions and temp files.
   */
  dispose(): void {
    for (const session of this.byDraftKey.values()) {
      try {
        if (fs.existsSync(session.tempUri.fsPath)) {
          fs.unlinkSync(session.tempUri.fsPath);
        }
      } catch {
        // ignore
      }
    }
    this.byDraftKey.clear();
    this.byTempBase.clear();
  }

  private isClosed(session: EditorSession): boolean {
    const open = vscode.workspace.textDocuments.some(
      (d) => d.uri.toString() === session.tempUri.toString()
    );
    return !open;
  }

  private async replaceTempContent(
    session: EditorSession,
    code: string
  ): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(session.tempUri);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      doc.uri,
      new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
      code
    );
    await vscode.workspace.applyEdit(edit);
  }

  private makeSafeFileName(hit: JsonStringHit): string {
    const last = hit.keyPath.split('.').pop() || 'script';
    const safe = last.replace(/\W/g, '_').slice(0, 30);
    const hash = crypto
      .createHash('md5')
      .update(hit.draftKey)
      .digest('hex')
      .slice(0, 8);
    return `${safe}_${hash}`;
  }
}
