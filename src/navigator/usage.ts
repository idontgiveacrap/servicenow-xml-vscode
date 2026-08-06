import * as vscode from 'vscode';

/** Persisted open stats for one catalog record identity. */
export interface RecordUsage {
  openCount: number;
  lastOpenedAt: number;
}

type UsageMap = Record<string, RecordUsage>;

const STATE_KEY = 'servicenowXml.navigator.usage';

/**
 * Build a stable usage key for a catalog row (URI + optional sys_id).
 */
export function usageKey(uri: vscode.Uri, sysId?: string): string {
  return `${uri.toString()}::${sysId ?? ''}`;
}

/**
 * Workspace-scoped open-count / last-opened store for navigator sort modes.
 */
export class RecordUsageStore implements vscode.Disposable {
  private usage: UsageMap;
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(private readonly workspaceState: vscode.Memento) {
    this.usage = this.workspaceState.get<UsageMap>(STATE_KEY, {});
  }

  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    void this.workspaceState.update(STATE_KEY, this.usage);
  }

  get(uri: vscode.Uri, sysId?: string): RecordUsage | undefined {
    return this.usage[usageKey(uri, sysId)];
  }

  /**
   * Increment open count and set last-opened for one record identity.
   */
  recordOpen(uri: vscode.Uri, sysId?: string): void {
    const key = usageKey(uri, sysId);
    const prev = this.usage[key];
    this.usage[key] = {
      openCount: (prev?.openCount ?? 0) + 1,
      lastOpenedAt: Date.now()
    };
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.workspaceState.update(STATE_KEY, this.usage);
    }, 250);
  }
}
