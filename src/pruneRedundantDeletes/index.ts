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
  classifyDeleteRows,
  selectDeleteQueryCandidates,
  type DeleteFileCandidate,
  type IndexedExport,
  type PruneCandidateRow,
  type PruneTarget
} from '../snc/parse';

const AUTHOR_ELECTIVE_GLOB = '**/author_elective_update/**';
const HAS_SNC_CONTEXT = 'servicenowXml.hasSnc';

const WARNING_BODY = [
  'Existence is checked only against the ServiceNow instance and user on the selected snc profile (host / username). Default (no --profile) uses the CLI default profile. A record can still exist on other instances or under other logins.',
  'Tests suggest snc may bypass ACLs. A miss is not proof the record is gone from ServiceNow. If this profile’s query cannot see a row that still exists, pruning would drop a tombstone that install still needs.',
  'Nothing is removed until you check it in the table that follows. Only rows the query proved absent are checked for you; rows the instance still returns, and rows nothing was confirmed for, start unchecked so keeping the tombstone stays the default. You can review and prune without querying at all.',
  'Files whose rows are all checked are deleted; files that mix DELETE with other actions, or that keep an unchecked DELETE row, lose only the checked rows. Nothing is removed from the instance.'
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
        if (scope.kind === 'no-deletes') {
          void vscode.window.showInformationMessage(
            'Nothing to prune: the Records selection holds no action="DELETE" rows.'
          );
          return;
        }
        await openPruneModal(
          context,
          catalog,
          scope.kind === 'selection' ? scope.sysIds : undefined
        );
      }
    )
  );
}

/** What an invocation of the command is scoped to. */
type PruneScope =
  | { kind: 'workspace' }
  | { kind: 'selection'; sysIds: Set<string> }
  | { kind: 'no-deletes' };

/**
 * Resolve the prune scope from how the command was invoked.
 *
 * Only a context-menu invocation carries a tree node, and only then is the
 * navigator selection a statement about what to prune. From the command
 * palette that selection is whatever the active editor last synced, so reading
 * it there would silently narrow a whole-workspace prune to one open file.
 *
 * Live rows in the selection are ignored: a selection that resolves to no
 * DELETE rows is reported as such rather than widening to the workspace.
 */
function collectScope(
  element: unknown,
  treeView: vscode.TreeView<TreeNode>,
  treeProvider: RecordsTreeProvider
): PruneScope {
  if (!isTreeNode(element)) {
    return { kind: 'workspace' };
  }
  const selected = [...treeView.selection].filter(isTreeNode);
  if (!selected.some((node) => node.id === element.id)) {
    selected.push(element);
  }
  const ids = new Set<string>();
  for (const node of selected) {
    for (const record of treeProvider.getRecordsForNode(node)) {
      if (record.action === 'DELETE' && record.sysId) {
        ids.add(record.sysId.toLowerCase());
      }
    }
  }
  return ids.size > 0 ? { kind: 'selection', sysIds: ids } : { kind: 'no-deletes' };
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
  let running = false;
  const resultRows = new Map<number, PruneCandidateRow>();

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

  panel.webview.onDidReceiveMessage(
    async (message: {
      type?: string;
      profile?: string;
      rowId?: number;
      selectedRowIds?: number[];
    }) => {
      if (message.type === 'ready') {
        pushState();
        return;
      }
      if (message.type === 'cancel') {
        panel.dispose();
        return;
      }
      if (message.type === 'openRow' && typeof message.rowId === 'number') {
        const row = resultRows.get(message.rowId);
        if (row) {
          await vscode.commands.executeCommand('servicenowXml.navigator.openRecord', {
            table: row.table,
            displayName: row.displayName,
            sysId: row.sysId,
            action: 'DELETE',
            startOffset: row.startOffset,
            openCount: 0,
            uri: vscode.Uri.parse(row.file.uriString),
            relativePath: row.file.relativePath
          });
        }
        return;
      }
      if (message.type === 'apply' && Array.isArray(message.selectedRowIds)) {
        send({ type: 'applyStarted' });
        const selectedByFile = new Map<DeleteFileCandidate, string[]>();
        for (const rowId of message.selectedRowIds) {
          const row = resultRows.get(rowId);
          if (!row) {
            continue;
          }
          const ids = selectedByFile.get(row.file) ?? [];
          ids.push(row.sysId);
          selectedByFile.set(row.file, ids);
        }
        await applySelectedRows(catalog, selectedByFile);
        panel.dispose();
        return;
      }
      const querying = message.type === 'run';
      if ((!querying && message.type !== 'review') || running) {
        return;
      }
      running = true;
      send({ type: querying ? 'queryStarted' : 'reviewStarted' });
      await indexPromise;
      if (closed || indexError) {
        return;
      }

      // An empty map means nothing was confirmed either way, which is exactly
      // the state manual review starts from and the state a failed query
      // leaves a table in.
      let presentByTable = new Map<string, Set<string>>();
      if (querying) {
        try {
          presentByTable = await queryInstance(
            candidates,
            message.profile || undefined
          );
        } catch (error) {
          // The table is still worth showing with every row unconfirmed; the
          // alternative is a panel stuck on "querying" with no way forward.
          const detail = error instanceof Error ? error.message : String(error);
          getOutput().appendLine(`Instance query failed: ${detail}`);
        }
      }

      resultRows.clear();
      const rows = classifyDeleteRows(candidates, presentByTable).map((row, id) => {
        resultRows.set(id, row);
        return {
          id,
          displayName: row.displayName,
          table: row.table,
          sysId: row.sysId,
          relativePath: row.file.relativePath,
          status: row.status
        };
      });
      send({ type: 'results', rows, queried: querying });
    }
  );
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
    startOffset: record.startOffset,
    queryable:
      !scopeSysIds ||
      record.action !== 'DELETE' ||
      Boolean(record.sysId && scopeSysIds.has(record.sysId.toLowerCase()))
  }));
}

/**
 * Query the instance for every candidate sys_id, grouped by table.
 *
 * Tables whose query failed are left out of the result rather than recorded as
 * empty, so their rows stay unconfirmed instead of looking absent.
 */
async function queryInstance(
  candidates: DeleteFileCandidate[],
  profile: string | undefined
): Promise<Map<string, Set<string>>> {
  const channel = getOutput();
  channel.show(true);

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

  return presentByTable;
}

/**
 * Apply the checked result rows, grouping them by file before rewriting.
 */
async function applySelectedRows(
  catalog: RecordCatalog,
  selectedByFile: Map<DeleteFileCandidate, string[]>
): Promise<void> {
  const channel = getOutput();
  let deleted = 0;
  let rewritten = 0;
  for (const [file, sysIds] of selectedByFile) {
    const applied = await applyPruneTarget(
      {
        file,
        sysIds,
        removesWholeFile: sysIds.length === file.primaryRowCount
      },
      channel
    );
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
 * Warning, instance-query, and row-level prune UI.
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
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; }
    main { max-width: 90rem; }
    p { white-space: pre-wrap; line-height: 1.45; }
    label { display: block; margin: 12px 0 6px; }
    select { width: 100%; padding: 4px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); }
    .status { margin: 12px 0; color: var(--vscode-descriptionForeground); }
    .error { color: var(--vscode-errorForeground); }
    .warn { color: var(--vscode-editorWarning-foreground); }
    .actions { margin-top: 16px; display: flex; gap: 8px; }
    button { padding: 6px 14px; }
    button:disabled { opacity: 0.5; }
    [hidden] { display: none !important; }
    .table-wrap { overflow: auto; border: 1px solid var(--vscode-panel-border); }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 7px 9px; text-align: left; border-bottom: 1px solid var(--vscode-panel-border); white-space: nowrap; }
    th { position: sticky; top: 0; background: var(--vscode-editor-background); }
    tbody tr:hover { background: var(--vscode-list-hoverBackground); }
    .record-link { border: 0; padding: 0; color: var(--vscode-textLink-foreground); background: transparent; cursor: pointer; font: inherit; text-align: left; }
    .path { max-width: 32rem; overflow: hidden; text-overflow: ellipsis; }
    .row-status.present, .row-status.unchecked { color: var(--vscode-editorWarning-foreground); }
    code { font-family: var(--vscode-editor-font-family); }
  </style>
</head>
<body>
  <main>
    <h2>Prune redundant DELETE files</h2>
    <section id="setup">
      <p>${escapeHtml(WARNING_BODY)}</p>
      <label for="profile">snc profile</label>
      <select id="profile">
        <option value="">Default (no --profile)</option>
      </select>
    </section>
    <div id="status" class="status">Indexing export XML…</div>
    <section id="results" hidden>
      <p id="results-intro"></p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th><input id="select-all" type="checkbox" aria-label="Select all records for removal" /></th>
              <th>Name</th>
              <th>On instance</th>
              <th>Table</th>
              <th>sys_id</th>
              <th>File</th>
            </tr>
          </thead>
          <tbody id="result-rows"></tbody>
        </table>
      </div>
    </section>
    <div class="actions">
      <button id="run" disabled>Query instance</button>
      <button id="review" disabled>Review without querying</button>
      <button id="apply" hidden disabled>Remove checked records</button>
      <button id="cancel">Cancel</button>
    </div>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const setupEl = document.getElementById('setup');
    const profileEl = document.getElementById('profile');
    const statusEl = document.getElementById('status');
    const runEl = document.getElementById('run');
    const reviewEl = document.getElementById('review');
    const applyEl = document.getElementById('apply');
    const resultsEl = document.getElementById('results');
    const resultsIntroEl = document.getElementById('results-intro');
    const rowsEl = document.getElementById('result-rows');
    const selectAllEl = document.getElementById('select-all');
    const cancelEl = document.getElementById('cancel');
    const STATUS_LABELS = {
      absent: 'Not found',
      present: 'Still exists',
      unchecked: 'Not checked'
    };
    const selectedCheckboxes = () => [...rowsEl.querySelectorAll('input[data-row-id]:checked')];
    const syncSelection = () => {
      const all = [...rowsEl.querySelectorAll('input[data-row-id]')];
      const selected = selectedCheckboxes().length;
      const risky = selectedCheckboxes().filter((checkbox) => checkbox.dataset.status !== 'absent').length;
      applyEl.disabled = selected === 0;
      selectAllEl.checked = all.length > 0 && selected === all.length;
      selectAllEl.indeterminate = selected > 0 && selected < all.length;
      statusEl.textContent =
        selected + ' of ' + all.length + ' record(s) selected for removal.' +
        (risky ? ' Includes ' + risky + ' not confirmed gone from the instance.' : '');
      statusEl.classList.toggle('warn', risky > 0);
    };
    vscode.postMessage({ type: 'ready' });
    cancelEl.addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel' });
    });
    runEl.addEventListener('click', () => {
      vscode.postMessage({ type: 'run', profile: profileEl.value });
    });
    reviewEl.addEventListener('click', () => {
      vscode.postMessage({ type: 'review' });
    });
    applyEl.addEventListener('click', () => {
      vscode.postMessage({
        type: 'apply',
        selectedRowIds: selectedCheckboxes().map((checkbox) => Number(checkbox.dataset.rowId))
      });
    });
    selectAllEl.addEventListener('change', () => {
      for (const checkbox of rowsEl.querySelectorAll('input[data-row-id]')) {
        checkbox.checked = selectAllEl.checked;
      }
      syncSelection();
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
        statusEl.textContent = msg.count === 0
          ? 'No DELETE rows to review (none found, or each still has a live export in the repo).'
          : 'Indexed ' + msg.count + ' DELETE file(s). Query uses the selected profile, or review them without querying.';
        statusEl.classList.remove('error');
        runEl.disabled = msg.count === 0;
        reviewEl.disabled = msg.count === 0;
      }
      if (msg.type === 'indexError') {
        statusEl.textContent = 'Index failed: ' + msg.message;
        statusEl.classList.add('error');
        runEl.disabled = true;
        reviewEl.disabled = true;
      }
      if (msg.type === 'queryStarted' || msg.type === 'reviewStarted') {
        statusEl.textContent = msg.type === 'queryStarted'
          ? 'Querying the selected instance…'
          : 'Listing DELETE rows without querying the instance…';
        statusEl.classList.remove('error');
        profileEl.disabled = true;
        runEl.disabled = true;
        reviewEl.disabled = true;
      }
      if (msg.type === 'results') {
        setupEl.hidden = true;
        runEl.hidden = true;
        reviewEl.hidden = true;
        applyEl.hidden = false;
        resultsEl.hidden = msg.rows.length === 0;
        cancelEl.textContent = 'Close';
        resultsIntroEl.textContent = msg.queried
          ? 'Records the instance did not return are checked for removal. Records it still has, and records it could not be asked about, start unchecked. Select a record name to open its XML row.'
          : 'The instance was not queried, so nothing is confirmed and every record starts unchecked. Check what you want removed from the repository, and select a record name to open its XML row.';
        rowsEl.replaceChildren();
        for (const row of msg.rows) {
          const tr = document.createElement('tr');
          const checkCell = document.createElement('td');
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.checked = row.status === 'absent';
          checkbox.dataset.rowId = String(row.id);
          checkbox.dataset.status = row.status;
          checkbox.setAttribute('aria-label', 'Remove ' + row.displayName);
          checkbox.addEventListener('change', syncSelection);
          checkCell.appendChild(checkbox);

          const nameCell = document.createElement('td');
          const openButton = document.createElement('button');
          openButton.className = 'record-link';
          openButton.textContent = row.displayName;
          openButton.title = 'Open this record in its XML file';
          openButton.addEventListener('click', () => {
            vscode.postMessage({ type: 'openRow', rowId: row.id });
          });
          nameCell.appendChild(openButton);

          const statusCell = document.createElement('td');
          statusCell.textContent = STATUS_LABELS[row.status];
          statusCell.className = 'row-status ' + row.status;
          const tableCell = document.createElement('td');
          tableCell.textContent = row.table;
          const idCell = document.createElement('td');
          const idCode = document.createElement('code');
          idCode.textContent = row.sysId;
          idCell.appendChild(idCode);
          const pathCell = document.createElement('td');
          pathCell.className = 'path';
          pathCell.textContent = row.relativePath;
          pathCell.title = row.relativePath;
          tr.append(checkCell, nameCell, statusCell, tableCell, idCell, pathCell);
          rowsEl.appendChild(tr);
        }
        if (msg.rows.length === 0) {
          statusEl.textContent = 'No DELETE rows to review.';
          applyEl.disabled = true;
        } else {
          syncSelection();
        }
      }
      if (msg.type === 'applyStarted') {
        applyEl.disabled = true;
        cancelEl.disabled = true;
        statusEl.textContent = 'Removing checked records…';
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
