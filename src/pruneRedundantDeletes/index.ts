import * as vscode from 'vscode';
import { getIgnoreGlobs } from '../ignorePaths';
import { RecordCatalog } from '../navigator/catalog';
import {
  RecordsTreeProvider,
  TreeNode
} from '../navigator/tree';
import { scanExportRecords, type ExportRecord } from '../navigator/scanExports';
import { removeDeleteRows } from './removeRows';
import {
  getSncPath,
  listSncProfiles,
  querySysIdsOnTable,
  sncIsAvailable
} from '../snc/cli';
import {
  confirmedMissingByFile,
  selectDeleteQueryCandidates,
  type DeleteFileCandidate,
  type IndexedExport,
  type PruneTarget
} from '../snc/parse';

const AUTHOR_ELECTIVE_GLOB = '**/author_elective_update/**';
const HAS_SNC_CONTEXT = 'servicenowXml.hasSnc';

const WARNING_BODY = [
  'Existence is checked only against the ServiceNow instance and user on the selected snc profile (host / username). Default (no --profile) uses the CLI default profile. A record can still exist on other instances or under other logins.',
  'Tests suggest snc may bypass ACLs. A miss is not proof the record is gone from ServiceNow. If this profile’s query cannot see a row that still exists, pruning would drop a tombstone that install still needs.',
  'This command only removes repo XML with action="DELETE" when that profile’s query does not return the sys_id, and the record is not a live export in the repo. If the query does return the row, the DELETE file is kept so install can still remove it on that instance.',
  'Files whose rows are all pruned are deleted; files that mix DELETE with other actions keep the file and lose only the pruned DELETE rows. Nothing is removed from the instance.'
].join('\n\n');

let output: vscode.OutputChannel | undefined;

/**
 * Probe snc and publish `servicenowXml.hasSnc` for menu when-clauses.
 */
export async function refreshSncContext(): Promise<boolean> {
  const available = await sncIsAvailable();
  void vscode.commands.executeCommand('setContext', HAS_SNC_CONTEXT, available);
  return available;
}

/**
 * Register the prune-redundant-DELETE command and snc availability probe.
 */
export function registerPruneRedundantDeletes(
  context: vscode.ExtensionContext,
  catalog: RecordCatalog,
  treeView: vscode.TreeView<TreeNode>,
  treeProvider: RecordsTreeProvider
): void {
  void refreshSncContext();
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'servicenowXml.pruneRedundantDeletes',
      async (element?: unknown) => {
        const available = await refreshSncContext();
        if (!available) {
          void vscode.window.showErrorMessage(
            `ServiceNow CLI (snc) was not found (${getSncPath()}). Install snc or set servicenowXml.snc.path.`
          );
          return;
        }
        const scope = collectScope(element, treeView, treeProvider);
        await openPruneModal(context, catalog, scope);
      }
    )
  );
}

/**
 * Navigator selection sys_ids, or undefined for a full-workspace prune.
 */
function collectScope(
  element: unknown,
  treeView: vscode.TreeView<TreeNode>,
  treeProvider: RecordsTreeProvider
): Set<string> | undefined {
  const selected = [...treeView.selection].filter(isTreeNode);
  if (isTreeNode(element) && !selected.some((node) => node.id === element.id)) {
    selected.push(element);
  }
  if (selected.length === 0) {
    return undefined;
  }
  const ids = new Set<string>();
  for (const node of selected) {
    for (const record of treeProvider.getRecordsForNode(node)) {
      if (record.sysId) {
        ids.add(record.sysId.toLowerCase());
      }
    }
  }
  return ids.size > 0 ? ids : undefined;
}

function isTreeNode(
  value: unknown
): value is Extract<TreeNode, { kind: 'record' | 'table' }> {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'kind' in value &&
      ((value as TreeNode).kind === 'record' ||
        (value as TreeNode).kind === 'table')
  );
}

/**
 * Open the warning webview, index DELETE exports in the background, then query on Run.
 */
async function openPruneModal(
  context: vscode.ExtensionContext,
  catalog: RecordCatalog,
  scopeSysIds: Set<string> | undefined
): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    'servicenowXml.pruneRedundantDeletes',
    'Prune redundant DELETE files',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  const nonce = String(Date.now());
  panel.webview.html = pruneWebviewHtml(panel.webview, nonce);

  const cancel = new vscode.CancellationTokenSource();
  let candidates: DeleteFileCandidate[] = [];
  let indexError: string | undefined;
  let indexCount: number | undefined;
  let profiles: { name: string; host?: string; username?: string }[] | undefined;
  let closed = false;

  const send = (message: Record<string, unknown>): void => {
    if (!closed) {
      void panel.webview.postMessage(message);
    }
  };

  const pushState = (): void => {
    if (profiles) {
      send({ type: 'profiles', profiles });
    }
    if (indexError) {
      send({ type: 'indexError', message: indexError });
    } else if (indexCount !== undefined) {
      send({ type: 'indexDone', count: indexCount });
    }
  };

  panel.onDidDispose(() => {
    closed = true;
    cancel.cancel();
    cancel.dispose();
  });

  const indexPromise = (async () => {
    const ignoreGlobs = getIgnoreGlobs().filter(
      (glob) => glob.replace(/\\/g, '/') !== AUTHOR_ELECTIVE_GLOB
    );
    const records = await scanExportRecords({
      ignoreGlobs,
      excludeDelete: false,
      token: cancel.token
    });
    const indexed = toIndexed(records, scopeSysIds);
    const selected = selectDeleteQueryCandidates(indexed);
    candidates = selected.candidates;
    indexCount = candidates.length;
    const channel = getOutput();
    for (const note of selected.skipped) {
      channel.appendLine(`Skip ${note.relativePath}: ${note.reason}`);
    }
    send({
      type: 'indexDone',
      count: candidates.length
    });
  })().catch((error: unknown) => {
    if (error instanceof vscode.CancellationError || cancel.token.isCancellationRequested) {
      return;
    }
    indexError = error instanceof Error ? error.message : String(error);
    send({ type: 'indexError', message: indexError });
  });

  void listSncProfiles().then((listed) => {
    profiles = listed ?? [];
    send({ type: 'profiles', profiles });
  });

  panel.webview.onDidReceiveMessage(async (message: { type?: string; profile?: string }) => {
    if (message.type === 'ready') {
      pushState();
      return;
    }
    if (message.type === 'cancel') {
      panel.dispose();
      return;
    }
    if (message.type !== 'run') {
      return;
    }
    await indexPromise;
    if (closed || indexError) {
      return;
    }
    panel.dispose();
    await runQueriesAndDelete(catalog, candidates, message.profile || undefined);
  });
}

/**
 * Restrict queried DELETE files to navigator selection without dropping live twins.
 */
function toIndexed(
  records: ExportRecord[],
  scopeSysIds: Set<string> | undefined
): IndexedExport[] {
  // Rows stay in the index either way so live twins and file row totals are
  // still seen repo-wide; selection only decides which DELETEs may be queried.
  return records.map((record) => ({
    table: record.table,
    sysId: record.sysId,
    action: record.action,
    uriString: record.uri.toString(),
    relativePath: record.relativePath,
    displayName: record.displayName,
    queryable:
      !scopeSysIds ||
      record.action !== 'DELETE' ||
      Boolean(record.sysId && scopeSysIds.has(record.sysId.toLowerCase()))
  }));
}

/**
 * Query grouped tables, preview misses, then prune confirmed rows.
 */
async function runQueriesAndDelete(
  catalog: RecordCatalog,
  candidates: DeleteFileCandidate[],
  profile: string | undefined
): Promise<void> {
  const channel = getOutput();
  channel.show(true);
  if (candidates.length === 0) {
    void vscode.window.showInformationMessage(
      'No redundant DELETE rows to check (none found, or each still has a live export in the repo).'
    );
    return;
  }

  const byTable = new Map<string, string[]>();
  for (const file of candidates) {
    for (const row of file.rows) {
      const ids = byTable.get(row.table) ?? [];
      if (!ids.includes(row.sysId)) {
        ids.push(row.sysId);
      }
      byTable.set(row.table, ids);
    }
  }

  const presentByTable = new Map<string, Set<string>>();
  let failedTables = 0;
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Querying instance for DELETE records',
      cancellable: false
    },
    async (progress) => {
      const tables = [...byTable.keys()];
      let done = 0;
      for (const table of tables) {
        progress.report({
          message: table,
          increment: tables.length ? 100 / tables.length : 0
        });
        const queried = byTable.get(table) ?? [];
        const outcome = await querySysIdsOnTable({
          table,
          sysIds: queried,
          profile
        });
        done += 1;
        if (!outcome.ok) {
          failedTables += 1;
          channel.appendLine(
            `Skip table ${table} (${done}/${tables.length}): ${outcome.reason}`
          );
          continue;
        }
        presentByTable.set(table, outcome.present);
        channel.appendLine(
          `Table ${table} (${done}/${tables.length}): ${outcome.present.size} of ${queried.length} queried sys_ids still on instance`
        );
      }
    }
  );

  const targets = confirmedMissingByFile(candidates, presentByTable);
  if (targets.length === 0) {
    void vscode.window.showInformationMessage(
      failedTables > 0
        ? 'No DELETE rows were pruned. Instance queries failed or every queried record still exists.'
        : 'Every queried DELETE record still exists on the instance. Nothing removed.'
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    targets.map((target) => ({
      label: target.file.displayName,
      description: target.removesWholeFile
        ? 'remove file'
        : `remove ${target.sysIds.length} DELETE row${target.sysIds.length === 1 ? '' : 's'}`,
      detail: target.file.relativePath,
      picked: true,
      target
    })),
    {
      title: 'Prune DELETE records that were not found on the instance',
      canPickMany: true,
      ignoreFocusOut: true,
      placeHolder: 'Deselect anything to keep'
    }
  );
  if (!picked || picked.length === 0) {
    return;
  }

  let deleted = 0;
  let rewritten = 0;
  for (const item of picked) {
    const applied = await applyPruneTarget(item.target, channel);
    if (applied === 'deleted') {
      deleted += 1;
    } else if (applied === 'rewritten') {
      rewritten += 1;
    }
  }

  if (catalog.isEnabled()) {
    try {
      await catalog.refresh({ showProgress: false });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      channel.appendLine(`Navigator refresh failed: ${detail}`);
    }
  }

  void vscode.window.showInformationMessage(
    `Pruned redundant DELETEs: ${deleted} file${deleted === 1 ? '' : 's'} removed, ${rewritten} file${rewritten === 1 ? '' : 's'} rewritten.`
  );
}

/**
 * Remove one file's confirmed DELETE rows, deleting the file when nothing else
 * remains in it.
 *
 * Offsets are recomputed from the file on disk rather than reused from the
 * index, so an export edited since the scan is skipped instead of rewritten
 * against stale bounds.
 */
async function applyPruneTarget(
  target: PruneTarget,
  channel: vscode.OutputChannel
): Promise<'deleted' | 'rewritten' | 'skipped'> {
  const uri = vscode.Uri.parse(target.file.uriString);
  const relativePath = target.file.relativePath;
  try {
    const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    const result = removeDeleteRows(text, uri.fsPath, target.sysIds);

    if (result.outcome === 'mismatch') {
      channel.appendLine(
        `Skip ${relativePath}: expected ${result.expected} DELETE row(s) on disk, found ${result.removed}`
      );
      return 'skipped';
    }
    if (result.outcome === 'delete-file') {
      await vscode.workspace.fs.delete(uri);
      channel.appendLine(`Deleted ${relativePath}`);
      return 'deleted';
    }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(result.text, 'utf8'));
    channel.appendLine(
      `Rewrote ${relativePath}: removed ${result.removed} DELETE row(s)`
    );
    return 'rewritten';
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    channel.appendLine(`Failed to prune ${relativePath}: ${detail}`);
    return 'skipped';
  }
}

function getOutput(): vscode.OutputChannel {
  if (!output) {
    output = vscode.window.createOutputChannel('ServiceNow XML: prune DELETE');
  }
  return output;
}

/**
 * Warning dialog HTML: profile select and Run disabled until the index finishes.
 */
function pruneWebviewHtml(webview: vscode.Webview, nonce: string): string {
  const csp = webview.cspSource;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <title>Prune redundant DELETE files</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; max-width: 52em; }
    p { white-space: pre-wrap; line-height: 1.45; }
    label { display: block; margin: 12px 0 6px; }
    select { width: 100%; padding: 4px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); }
    .status { margin: 12px 0; color: var(--vscode-descriptionForeground); }
    .error { color: var(--vscode-errorForeground); }
    .actions { margin-top: 16px; display: flex; gap: 8px; }
    button { padding: 6px 14px; }
    button:disabled { opacity: 0.5; }
  </style>
</head>
<body>
  <h2>Prune redundant DELETE files</h2>
  <p>${escapeHtml(WARNING_BODY)}</p>
  <label for="profile">snc profile</label>
  <select id="profile">
    <option value="">Default (no --profile)</option>
  </select>
  <div id="status" class="status">Indexing export XML…</div>
  <div class="actions">
    <button id="run" disabled>Run</button>
    <button id="cancel">Cancel</button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const profileEl = document.getElementById('profile');
    const statusEl = document.getElementById('status');
    const runEl = document.getElementById('run');
    vscode.postMessage({ type: 'ready' });
    document.getElementById('cancel').addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel' });
    });
    runEl.addEventListener('click', () => {
      vscode.postMessage({ type: 'run', profile: profileEl.value });
    });
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'profiles') {
        const current = profileEl.value;
        while (profileEl.options.length > 1) {
          profileEl.remove(1);
        }
        for (const p of msg.profiles) {
          const opt = document.createElement('option');
          opt.value = p.name;
          opt.textContent = p.name + (p.username || p.host ? ' — ' + [p.username, p.host].filter(Boolean).join(' @ ') : '');
          profileEl.appendChild(opt);
        }
        profileEl.value = current;
      }
      if (msg.type === 'indexDone') {
        statusEl.textContent = 'Indexed ' + msg.count + ' DELETE file(s) to query. Run uses the selected profile.';
        statusEl.classList.remove('error');
        runEl.disabled = false;
      }
      if (msg.type === 'indexError') {
        statusEl.textContent = 'Index failed: ' + msg.message;
        statusEl.classList.add('error');
        runEl.disabled = true;
      }
    });
  </script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
