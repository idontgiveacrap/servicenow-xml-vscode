import * as vscode from 'vscode';
import { matchesSnAppMarker, parseExportFileName } from './fileName';
import { getIgnoreGlobs, isPathIgnored } from './ignorePaths';

/** Context key used by package.json `when` clauses for the Records view. */
export const SN_WORKSPACE_CONTEXT = 'servicenowXml.isSnWorkspace';

const PROBE_DEBOUNCE_MS = 300;

export { matchesSnAppMarker };

type GateListener = () => void;

/**
 * Detects a ServiceNow app workspace via `{sys_id}/sys_app_{sys_id}.xml`
 * and publishes `servicenowXml.isSnWorkspace` for view visibility.
 */
export class SnWorkspaceGate implements vscode.Disposable {
  private snWorkspace = false;
  private appSysId: string | undefined;
  private probeTimer: NodeJS.Timeout | undefined;
  private probeGeneration = 0;
  private readonly listeners = new Set<GateListener>();
  private readonly watchers: vscode.FileSystemWatcher[] = [];
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
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
   * Diagnostics/lint may run when an SN app marker exists or
   * `enabledForAllWindows` bypasses the gate (including single-file windows).
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

  onDidChange(listener: GateListener): vscode.Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      }
    };
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
    if (found === this.snWorkspace && appSysId === this.appSysId) {
      await this.publishContext();
      return;
    }
    this.snWorkspace = found;
    this.appSysId = appSysId;
    await this.publishContext();
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
      '**/sys_app_*.xml',
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
      const pattern = new vscode.RelativePattern(folder, '**/sys_app_*.xml');
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
