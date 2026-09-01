import * as vscode from 'vscode';
import { matchesSnAppMarker, parseExportFileName } from './fileName';
import { getIgnoreGlobs, isPathIgnored } from './ignorePaths';
import { isEditableDocument, looksLikeSnExportDocument } from './snDocumentShape';
import {
  detectJavaScriptSupport,
  detectSysAppMetadata,
  JavaScriptSupport
} from './javascriptSupport';

/** Context key used by package.json `when` clauses for the Records view. */
export const SN_WORKSPACE_CONTEXT = 'servicenowXml.isSnWorkspace';

const PROBE_DEBOUNCE_MS = 300;
const STATE_KEY = 'servicenowXml.snWorkspaceGate';

/** 32 single-char wildcards — matches `sys_app_{32-hex}.xml` basename shape. */
const SYS_APP_FIND_GLOB =
  '**/sys_app_????????????????????????????????.xml';

export { matchesSnAppMarker };

type GateListener = () => void;

interface GateCache {
  isSnWorkspace: boolean;
  appSysId?: string;
  appScope?: string;
  appJavaScriptSupport?: JavaScriptSupport;
  markerWorkspaceFolder?: string;
}

/**
 * Detects a ServiceNow app workspace via `{sys_id}/sys_app_{sys_id}.xml`
 * and publishes `servicenowXml.isSnWorkspace` for view visibility.
 */
export class SnWorkspaceGate implements vscode.Disposable {
  private snWorkspace = false;
  private appSysId: string | undefined;
  private appScope: string | undefined;
  private appJavaScriptSupport: JavaScriptSupport | undefined;
  private markerWorkspaceFolder: string | undefined;
  private probeTimer: NodeJS.Timeout | undefined;
  private probeGeneration = 0;
  private readonly workspaceState: vscode.Memento;
  private readonly listeners = new Set<GateListener>();
  private readonly watchers: vscode.FileSystemWatcher[] = [];
  private readonly disposables: vscode.Disposable[] = [];

  constructor(workspaceState: vscode.Memento) {
    this.workspaceState = workspaceState;
    this.restoreFromCache();
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.restartWatchers();
        this.scheduleProbe();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('servicenowXml.ignoreGlobs') ||
          e.affectsConfiguration('servicenowXml.enabledForAllWindows')
        ) {
          this.scheduleProbe();
          this.notify();
        }
      })
    );
    this.restartWatchers();
    void this.probe();
  }

  dispose(): void {
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = undefined;
    }
    this.stopWatchers();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.listeners.clear();
  }

  /** True when `{sys_id}/sys_app_{sys_id}.xml` was found in the workspace. */
  isSnWorkspace(): boolean {
    return this.snWorkspace;
  }

  /**
   * Sys_id from the first matching `{sys_id}/sys_app_{sys_id}.xml` marker.
   * Undefined when no marker was found (including `enabledForAllWindows` bypass).
   */
  getWorkspaceAppSysId(): string | undefined {
    return this.appSysId;
  }

  /**
   * Technical scope from the workspace `sys_app` marker (`x_example`, `global`).
   * Undefined when no marker has been found.
   */
  getWorkspaceAppScope(): string | undefined {
    return this.appScope;
  }

  /**
   * JavaScript mode read from the workspace `sys_app` marker.
   * Undefined when no marker has been found; callers must default to ES5.
   */
  getWorkspaceJavaScriptSupport(): JavaScriptSupport | undefined {
    return this.appJavaScriptSupport;
  }

  /**
   * True when a document belongs to the workspace folder containing the
   * ServiceNow app marker. Tracked record rows in that folder require sys_ids;
   * standalone documents and unrelated folders in a multi-root window do not.
   */
  requiresRecordSysId(document: vscode.TextDocument): boolean {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    return (
      this.snWorkspace &&
      folder !== undefined &&
      folder.uri.toString() === this.markerWorkspaceFolder
    );
  }

  /**
   * Window-level gate: an SN app marker exists, or `enabledForAllWindows`
   * bypasses it so every XML document in the window is in scope.
   *
   * This is the gate for workspace-wide features (navigator indexing). Per-document
   * features should use {@link isValidationAllowed} so they also cover one-off
   * exports opened outside an app workspace.
   */
  isLintActive(): boolean {
    if (
      vscode.workspace
        .getConfiguration('servicenowXml')
        .get<boolean>('enabledForAllWindows', false)
    ) {
      return true;
    }
    return this.snWorkspace;
  }

  /**
   * Whether classification, structure diagnostics, and embedded lint may run for
   * one document: the window gate passes, or the document itself looks like a
   * ServiceNow export. The second path is what makes a one-off update set opened
   * in a folderless window work, where no marker can ever be found.
   *
   * Diff and review copies are excluded even in an SN workspace: the window gate
   * alone would otherwise let them through.
   */
  isValidationAllowed(document: vscode.TextDocument): boolean {
    if (!isEditableDocument(document)) {
      return false;
    }
    return this.isLintActive() || looksLikeSnExportDocument(document);
  }

  onDidChange(listener: GateListener): vscode.Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      }
    };
  }

  private restoreFromCache(): void {
    const cached = this.workspaceState.get<GateCache>(STATE_KEY);
    if (!cached?.isSnWorkspace) {
      return;
    }
    this.snWorkspace = true;
    this.appSysId = cached.appSysId;
    this.appScope = cached.appScope;
    this.appJavaScriptSupport = cached.appJavaScriptSupport;
    this.markerWorkspaceFolder = cached.markerWorkspaceFolder;
    // Publish immediately so the Records view `when` clause can show on reload
    // without waiting for findFiles.
    void this.publishContext();
  }

  private persistCache(): void {
    const value: GateCache = {
      isSnWorkspace: this.snWorkspace,
      appSysId: this.appSysId,
      appScope: this.appScope,
      appJavaScriptSupport: this.appJavaScriptSupport,
      markerWorkspaceFolder: this.markerWorkspaceFolder
    };
    void this.workspaceState.update(STATE_KEY, value);
  }

  private scheduleProbe(): void {
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
    }
    this.probeTimer = setTimeout(() => {
      this.probeTimer = undefined;
      void this.probe();
    }, PROBE_DEBOUNCE_MS);
  }

  private async probe(): Promise<void> {
    const generation = ++this.probeGeneration;
    const marker = await this.findSnAppMarker();
    if (generation !== this.probeGeneration) {
      return;
    }
    const found = marker !== undefined;
    const appSysId = marker?.sysId;
    const appMeta = marker ? await this.readMarkerMetadata(marker.uri) : undefined;
    const appScope = appMeta?.scope;
    const appJavaScriptSupport = appMeta?.javascriptSupport;
    const markerWorkspaceFolder = marker
      ? vscode.workspace.getWorkspaceFolder(marker.uri)?.uri.toString()
      : undefined;
    if (
      found === this.snWorkspace &&
      appSysId === this.appSysId &&
      appScope === this.appScope &&
      appJavaScriptSupport === this.appJavaScriptSupport &&
      markerWorkspaceFolder === this.markerWorkspaceFolder
    ) {
      await this.publishContext();
      this.persistCache();
      return;
    }
    this.snWorkspace = found;
    this.appSysId = appSysId;
    this.appScope = appScope;
    this.appJavaScriptSupport = appJavaScriptSupport;
    this.markerWorkspaceFolder = markerWorkspaceFolder;
    await this.publishContext();
    this.persistCache();
    this.notify();
  }

  private async findSnAppMarker(): Promise<
    { sysId: string; uri: vscode.Uri } | undefined
  > {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return undefined;
    }
    const ignoreGlobs = getIgnoreGlobs();
    const uris = await vscode.workspace.findFiles(
      SYS_APP_FIND_GLOB,
      '**/{node_modules,.git}/**'
    );
    for (const uri of uris) {
      if (isPathIgnored(uri.fsPath, ignoreGlobs)) {
        continue;
      }
      if (!matchesSnAppMarker(uri.fsPath)) {
        continue;
      }
      const parsed = parseExportFileName(uri.fsPath);
      if (parsed?.sysId) {
        return { sysId: parsed.sysId, uri };
      }
    }
    return undefined;
  }

  /**
   * Read `sys_app` scope and `js_level`; malformed or missing metadata is conservatively ES5.
   */
  private async readMarkerMetadata(
    uri: vscode.Uri
  ): Promise<{ scope?: string; javascriptSupport: JavaScriptSupport }> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const xml = Buffer.from(bytes).toString('utf8');
      const meta = detectSysAppMetadata(xml);
      return {
        scope: meta?.scope?.trim() || undefined,
        javascriptSupport: detectJavaScriptSupport(xml)
      };
    } catch {
      return { javascriptSupport: 'ES5' };
    }
  }

  private async publishContext(): Promise<void> {
    await vscode.commands.executeCommand(
      'setContext',
      SN_WORKSPACE_CONTEXT,
      this.snWorkspace
    );
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private restartWatchers(): void {
    this.stopWatchers();
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) {
      return;
    }
    for (const folder of folders) {
      const pattern = new vscode.RelativePattern(folder, SYS_APP_FIND_GLOB);
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidCreate(() => this.scheduleProbe());
      watcher.onDidChange(() => this.scheduleProbe());
      watcher.onDidDelete(() => this.scheduleProbe());
      this.watchers.push(watcher);
    }
  }

  private stopWatchers(): void {
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.watchers.length = 0;
  }
}
