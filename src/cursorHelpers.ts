import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

interface CursorMcpApi {
  registerServer: (config: {
    name: string;
    server:
      | { command: string; args: string[]; env: Record<string, string> }
      | { url: string; headers?: Record<string, string> };
  }) => void;
  unregisterServer?: (serverName: string) => void;
}

interface CursorPluginsApi {
  registerPath: (path: string) => void;
  unregisterPath?: (path: string) => void;
}

interface CursorApi {
  mcp?: CursorMcpApi;
  plugins?: CursorPluginsApi;
}

/**
 * Cursor host APIs when present; undefined in plain VS Code.
 */
function getCursorApi(): CursorApi | undefined {
  return (vscode as typeof vscode & { cursor?: CursorApi }).cursor;
}

/**
 * Stable identity for everything this extension installs into Cursor.
 * MCP server ids, rule filenames, plugin name, and managed-by markers all use this.
 */
export const PLUGIN_ID = 'servicenow-xml';

/** Stable install root for scripts/schema used by MCP + hooks + rules. */
export const HELPERS_HOME = path.join(os.homedir(), '.cursor', PLUGIN_ID);

/** MCP server ids registered by this extension (all prefixed with PLUGIN_ID). */
export const MCP_SERVERS = {
  docs: `${PLUGIN_ID}-docs`,
  uiExamples: `${PLUGIN_ID}-ui-examples`,
  dbSchema: `${PLUGIN_ID}-db-schema`,
  scripting: `${PLUGIN_ID}-scripting`
} as const;

/** Prior MCP ids / display names — unregistered and removed from mcp.json on install. */
const LEGACY_MCP_NAMES = [
  'servicenow-docs',
  'servicenow-ui-examples',
  'servicenow-db-schema',
  'ServiceNowDocs Docs',
  'ServiceNow UI Component Examples',
  'ServiceNow DB Schema',
  'ServiceNow NowComponents'
] as const;

const MANIFEST_NAME = 'install-manifest.json';
/** hooks.json sessionStart entries that mention this script are owned by this extension. */
const HOOK_MARKER = 'session_start_index.py';
/** Embedded in synced user rules so we can update/remove only our files. */
export const USER_RULES_MARKER = `managed-by: ${PLUGIN_ID}`;
/** Filename prefix for managed user/plugin rules. */
const USER_RULES_PREFIX = `${PLUGIN_ID}-`;

const REMOTE_MCP: Array<{ name: string; url: string }> = [
  {
    name: MCP_SERVERS.docs,
    url: 'https://gitmcp.io/ServiceNow/ServiceNowDocs'
  },
  {
    name: MCP_SERVERS.uiExamples,
    url: 'https://gitmcp.io/ServiceNowDevProgram/now-experience-component-examples'
  }
];

interface InstallManifest {
  version: string;
  files: Record<string, string>;
  schemaSha256?: string;
}

export interface CursorHelpersResult {
  installed: boolean;
  skippedReason?: string;
  syncedFiles: number;
  mcpRegistered: string[];
  mcpUnregistered: string[];
  rulesSynced: string[];
  hookInstalled: boolean;
  pluginPath?: string;
  messages: string[];
}

/**
 * True when helper install wrote files or user rules that Cursor may not pick up until reload.
 */
export function cursorHelpersNeedReload(result: CursorHelpersResult): boolean {
  return (
    result.installed &&
    (result.syncedFiles > 0 || result.rulesSynced.length > 0)
  );
}

/**
 * Suggest Developer: Reload Window so Cursor picks up MCP servers, rules, and hooks.
 */
export async function suggestReloadAfterCursorHelpers(
  summary: string
): Promise<void> {
  const reload = 'Reload Window';
  const choice = await vscode.window.showInformationMessage(
    `${summary} Reload the window (Ctrl+Shift+P → Developer: Reload Window) so MCP servers and rules take effect.`,
    reload
  );
  if (choice === reload) {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

/**
 * True when the Cursor extension APIs are present (not plain VS Code).
 */
export function isCursorHost(): boolean {
  const cursor = getCursorApi();
  return Boolean(cursor?.mcp?.registerServer || cursor?.plugins?.registerPath);
}

/**
 * Absolute path to the bundled cursor-plugins/servicenow-xml directory.
 */
export function bundledHelpersRoot(context: vscode.ExtensionContext): string {
  return path.join(context.extensionPath, 'cursor-plugins', PLUGIN_ID);
}

/** Serialize overlapping installCursorHelpers calls (activate + config + command). */
let installCursorHelpersInFlight: Promise<CursorHelpersResult> | undefined;

/**
 * Idempotently install ServiceNow Cursor helpers: scripts, schema, rules, MCP, optional hook.
 * No-ops on VS Code (or when disabled) without throwing.
 * Python absence only skips Python-dependent pieces (db-schema MCP, pip, index hook);
 * rules and remote MCPs still install. Never throws to the caller.
 */
export async function installCursorHelpers(
  context: vscode.ExtensionContext,
  options?: { force?: boolean; showProgress?: boolean }
): Promise<CursorHelpersResult> {
  if (installCursorHelpersInFlight) {
    return installCursorHelpersInFlight;
  }

  const messages: string[] = [];
  const empty: CursorHelpersResult = {
    installed: false,
    syncedFiles: 0,
    mcpRegistered: [],
    mcpUnregistered: [],
    rulesSynced: [],
    hookInstalled: false,
    messages
  };

  if (!isCursorHost()) {
    empty.skippedReason = 'not-cursor';
    messages.push('Cursor helpers skipped (not running in Cursor).');
    return empty;
  }

  const cfg = vscode.workspace.getConfiguration('servicenowXml');
  if (!cfg.get<boolean>('cursorHelpers.enable', true) && !options?.force) {
    empty.skippedReason = 'disabled';
    messages.push('Cursor helpers disabled (servicenowXml.cursorHelpers.enable).');
    return empty;
  }

  const run = async (): Promise<CursorHelpersResult> => {
    try {
      return await installCursorHelpersCore(context, cfg, messages, options);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      messages.push(`Cursor helpers aborted (non-fatal): ${detail}`);
      console.error('[servicenow-xml] cursor helpers aborted:', detail);
      return { ...empty, messages };
    }
  };

  const work = Promise.resolve(
    options?.showProgress === false
      ? run()
      : vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Window,
            title: 'ServiceNow XML: installing Cursor helpers'
          },
          () => run()
        )
  );

  installCursorHelpersInFlight = work.finally(() => {
    installCursorHelpersInFlight = undefined;
  });
  return installCursorHelpersInFlight;
}

/**
 * Core helper install. Isolated so Python/MCP failures cannot unwind activation.
 */
async function installCursorHelpersCore(
  context: vscode.ExtensionContext,
  cfg: vscode.WorkspaceConfiguration,
  messages: string[],
  options?: { force?: boolean }
): Promise<CursorHelpersResult> {
  const empty: CursorHelpersResult = {
    installed: false,
    syncedFiles: 0,
    mcpRegistered: [],
    mcpUnregistered: [],
    rulesSynced: [],
    hookInstalled: false,
    messages
  };

  const bundleRoot = bundledHelpersRoot(context);
  if (!fs.existsSync(bundleRoot)) {
    messages.push(`Bundled helpers missing at ${bundleRoot}`);
    return empty;
  }

  ensureDir(HELPERS_HOME);
  const scriptsDest = path.join(HELPERS_HOME, 'scripts');
  const hooksDest = path.join(HELPERS_HOME, 'hooks');
  const dataDest = path.join(HELPERS_HOME, 'data');
  const pluginDest = path.join(HELPERS_HOME, 'plugin');
  ensureDir(scriptsDest);
  ensureDir(hooksDest);
  ensureDir(dataDest);
  ensureDir(pluginDest);

  let syncedFiles = 0;
  syncedFiles += syncFile(
    path.join(bundleRoot, 'scripts', 'servicenow_repo_index.py'),
    path.join(scriptsDest, 'servicenow_repo_index.py')
  );
  syncedFiles += syncFile(
    path.join(bundleRoot, 'scripts', 'db_schema_mcp_server.py'),
    path.join(scriptsDest, 'db_schema_mcp_server.py')
  );
  syncedFiles += syncFile(
    path.join(bundleRoot, 'scripts', 'scripting_mcp_server.py'),
    path.join(scriptsDest, 'scripting_mcp_server.py')
  );
  syncedFiles += syncFile(
    path.join(bundleRoot, 'hooks', 'session_start_index.py'),
    path.join(hooksDest, 'session_start_index.py')
  );

  const schemaGz = path.join(bundleRoot, 'data', 'sys_dictionary.csv.gz');
  const schemaCsvGz = path.join(dataDest, 'sys_dictionary.csv.gz');
  if (fs.existsSync(schemaGz)) {
    syncedFiles += syncFile(schemaGz, schemaCsvGz);
  } else {
    messages.push(
      'Bundled schema CSV gzip missing; DB schema MCP needs SCHEMA_CSV_PATH.'
    );
  }

  const scriptingGz = path.join(bundleRoot, 'data', 'scripting_reference.json.gz');
  const scriptingRefGz = path.join(dataDest, 'scripting_reference.json.gz');
  if (fs.existsSync(scriptingGz)) {
    syncedFiles += syncFile(scriptingGz, scriptingRefGz);
  } else {
    messages.push(
      'Bundled scripting reference gzip missing; scripting MCP needs SCRIPTING_REF_PATH.'
    );
  }

  const jsPerformance = path.join(bundleRoot, 'data', 'js_performance.json');
  const jsPerformanceRef = path.join(dataDest, 'js_performance.json');
  if (fs.existsSync(jsPerformance)) {
    syncedFiles += syncFile(jsPerformance, jsPerformanceRef);
  } else {
    messages.push(
      'Bundled JavaScript performance data missing; scripting MCP performance tools will be unavailable.'
    );
  }

  syncedFiles += syncDir(
    path.join(bundleRoot, 'rules'),
    path.join(pluginDest, 'rules')
  );
  pruneExtraFiles(
    path.join(pluginDest, 'rules'),
    path.join(bundleRoot, 'rules')
  );
  syncedFiles += syncDir(
    path.join(bundleRoot, '.cursor-plugin'),
    path.join(pluginDest, '.cursor-plugin')
  );

  const rulesSynced = syncUserRules(path.join(bundleRoot, 'rules'));

  const pythonPath = cfg.get<string>('cursorHelpers.pythonPath', 'python') || 'python';
  const pythonOk = await pythonIsAvailable(pythonPath);
  let mcpPkgOk = false;

  if (!pythonOk) {
    messages.push(
      `Python not available (${pythonPath}); skipping local MCP servers, pip install, and index hook. Lint/navigator unaffected.`
    );
    if (options?.force) {
      void vscode.window.showWarningMessage(
        `ServiceNow Cursor helpers: Python not found (${pythonPath}). Indexer and local MCP servers were skipped; other features still work.`
      );
    }
  } else {
    const mcpPkg = await ensurePythonMcpPackage(pythonPath, {
      interactive: Boolean(options?.force)
    });
    messages.push(...mcpPkg.messages);
    mcpPkgOk = mcpPkg.ok;
  }

  // Only install the sessionStart indexer hook when Python can run it.
  const wantHook = cfg.get<boolean>('cursorHelpers.installIndexHook', true);
  const hookInstalled =
    wantHook && pythonOk
      ? installSessionStartHook(path.join(hooksDest, 'session_start_index.py'))
      : false;
  if (wantHook && !pythonOk) {
    messages.push('sessionStart index hook skipped (no Python)');
  }

  const { registered, unregistered } = registerMcpServers({
    pythonPath,
    schemaServerScript: path.join(scriptsDest, 'db_schema_mcp_server.py'),
    schemaCsvPath: schemaCsvGz,
    includeDbSchema: pythonOk && mcpPkgOk && fs.existsSync(schemaCsvGz),
    scriptingServerScript: path.join(scriptsDest, 'scripting_mcp_server.py'),
    scriptingRefPath: scriptingRefGz,
    jsPerformancePath: fs.existsSync(jsPerformanceRef) ? jsPerformanceRef : '',
    includeScripting: pythonOk && mcpPkgOk && fs.existsSync(scriptingRefGz)
  });

  const pluginPath = registerPluginPath(pluginDest);

  writeManifest(context, {
    schemaCsvGz,
    scriptingRefGz,
    jsPerformanceRef,
    scriptsDest,
    hooksDest,
    pluginDest
  });

  messages.push(
    `Synced ${syncedFiles} file(s) under ${HELPERS_HOME}`,
    `MCP: ${registered.join(', ') || '(none)'}`,
    rulesSynced.length
      ? `User rules: ${rulesSynced.join(', ')}`
      : 'User rules unchanged',
    hookInstalled
      ? 'sessionStart index hook installed/updated'
      : 'sessionStart index hook skipped',
    pluginPath ? `Plugin path: ${pluginPath}` : 'Plugin path registration unavailable'
  );

  return {
    installed: true,
    syncedFiles,
    mcpRegistered: registered,
    mcpUnregistered: unregistered,
    rulesSynced,
    hookInstalled,
    pluginPath,
    messages
  };
}

/**
 * Run the bundled repo indexer against a workspace folder.
 * Requires Python; failure here does not affect lint/navigator.
 */
export async function runRepoIndexer(
  context: vscode.ExtensionContext,
  repoRoot?: string
): Promise<void> {
  const root =
    repoRoot ||
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    void vscode.window.showErrorMessage('No workspace folder to index.');
    return;
  }

  const pythonPath =
    vscode.workspace
      .getConfiguration('servicenowXml')
      .get<string>('cursorHelpers.pythonPath', 'python') || 'python';

  if (!(await pythonIsAvailable(pythonPath))) {
    void vscode.window.showErrorMessage(
      `Python not found (${pythonPath}). Install Python or set servicenowXml.cursorHelpers.pythonPath. Lint and navigator do not need Python.`
    );
    return;
  }

  await installCursorHelpers(context, { force: true, showProgress: false });
  const indexer = path.join(HELPERS_HOME, 'scripts', 'servicenow_repo_index.py');
  if (!fs.existsSync(indexer)) {
    void vscode.window.showErrorMessage(`Indexer not found at ${indexer}`);
    return;
  }

  const terminal = vscode.window.createTerminal({
    name: 'ServiceNow Repo Index',
    cwd: root
  });
  terminal.show();
  const quotedPython = quoteForShell(pythonPath);
  const quotedIndexer = quoteForShell(indexer);
  const quotedRoot = quoteForShell(root);
  terminal.sendText(`${quotedPython} ${quotedIndexer} ${quotedRoot}`);
}

/**
 * Register dispose handler that unregisters the plugin path on deactivate.
 * Replaces any prior handler so activate/config/command installs do not stack.
 */
let cursorHelpersDisposeHandler: (() => void) | undefined;
let cursorHelpersDisposalRegistered = false;

export function registerCursorHelpersDisposal(
  context: vscode.ExtensionContext,
  pluginPath: string | undefined
): void {
  if (!pluginPath) {
    return;
  }
  const cursor = getCursorApi();
  if (!cursor?.plugins?.unregisterPath) {
    return;
  }
  cursorHelpersDisposeHandler = () => {
    try {
      cursor.plugins?.unregisterPath?.(pluginPath);
    } catch {
      // Host may already be shutting down.
    }
  };
  if (cursorHelpersDisposalRegistered) {
    return;
  }
  cursorHelpersDisposalRegistered = true;
  context.subscriptions.push({
    dispose: () => {
      cursorHelpersDisposeHandler?.();
      cursorHelpersDisposeHandler = undefined;
    }
  });
}

/**
 * Probe for `mcp.server.fastmcp`; if missing, install via pip (idempotent).
 * On automatic activate, installs without prompting and never blocks the UI with
 * errors (console only). On force (command), offers Install / Skip and may warn.
 */
async function ensurePythonMcpPackage(
  pythonPath: string,
  options: { interactive: boolean }
): Promise<{ ok: boolean; messages: string[] }> {
  const messages: string[] = [];
  if (await pythonHasMcp(pythonPath)) {
    messages.push(`Python mcp package OK (${pythonPath})`);
    return { ok: true, messages };
  }

  if (options.interactive) {
    const choice = await vscode.window.showInformationMessage(
      `Python package "mcp" is required for local MCP servers (${MCP_SERVERS.dbSchema}, ${MCP_SERVERS.scripting}). Install with ${pythonPath} -m pip install mcp?`,
      'Install',
      'Skip'
    );
    if (choice !== 'Install') {
      messages.push('Skipped pip install mcp');
      return { ok: false, messages };
    }
  }

  try {
    await execFileAsync(
      pythonPath,
      ['-m', 'pip', 'install', '--user', 'mcp'],
      { timeout: 180_000, windowsHide: true }
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    messages.push(`pip install mcp failed: ${detail}`);
    if (options.interactive) {
      void vscode.window.showWarningMessage(
        `Could not install Python mcp for ServiceNow DB schema. Run: ${pythonPath} -m pip install mcp`
      );
    } else {
      console.warn(
        '[servicenow-xml] pip install mcp failed (non-fatal):',
        detail
      );
    }
    return { ok: false, messages };
  }

  if (await pythonHasMcp(pythonPath)) {
    messages.push('Installed Python mcp package');
    return { ok: true, messages };
  }

  messages.push('pip install mcp finished but import still fails');
  if (options.interactive) {
    void vscode.window.showWarningMessage(
      `Python mcp install did not take effect for ${pythonPath}. Try: ${pythonPath} -m pip install mcp`
    );
  }
  return { ok: false, messages };
}

/**
 * Fast check that the configured Python executable runs at all.
 * Keeps a short timeout so Windows Store stubs cannot hang activation work.
 */
async function pythonIsAvailable(pythonPath: string): Promise<boolean> {
  try {
    await execFileAsync(pythonPath, ['--version'], {
      timeout: 5_000,
      windowsHide: true
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the configured Python can import mcp.server.fastmcp.
 */
async function pythonHasMcp(pythonPath: string): Promise<boolean> {
  try {
    await execFileAsync(
      pythonPath,
      ['-c', 'from mcp.server.fastmcp import FastMCP'],
      { timeout: 15_000, windowsHide: true }
    );
    return true;
  } catch {
    return false;
  }
}

function registerMcpServers(args: {
  pythonPath: string;
  schemaServerScript: string;
  schemaCsvPath: string;
  includeDbSchema: boolean;
  scriptingServerScript: string;
  scriptingRefPath: string;
  jsPerformancePath: string;
  includeScripting: boolean;
}): { registered: string[]; unregistered: string[] } {
  const cursor = getCursorApi();
  const registered: string[] = [];
  const unregistered: string[] = [];
  if (!cursor?.mcp?.registerServer) {
    return { registered, unregistered };
  }

  const allNames = [
    ...Object.values(MCP_SERVERS),
    ...LEGACY_MCP_NAMES
  ];
  if (cursor.mcp.unregisterServer) {
    for (const name of allNames) {
      try {
        cursor.mcp.unregisterServer(name);
        unregistered.push(name);
      } catch {
        // Not registered yet.
      }
    }
  }

  for (const remote of REMOTE_MCP) {
    try {
      cursor.mcp.registerServer({
        name: remote.name,
        server: { url: remote.url }
      });
      registered.push(remote.name);
    } catch (error) {
      console.warn(
        '[servicenow-xml] MCP register failed (non-fatal):',
        remote.name,
        error
      );
    }
  }

  if (args.includeDbSchema) {
    try {
      cursor.mcp.registerServer({
        name: MCP_SERVERS.dbSchema,
        server: {
          command: args.pythonPath,
          args: [args.schemaServerScript],
          env: {
            SCHEMA_CSV_PATH: args.schemaCsvPath
          }
        }
      });
      registered.push(MCP_SERVERS.dbSchema);
    } catch (error) {
      console.warn(
        '[servicenow-xml] DB schema MCP register failed (non-fatal):',
        error
      );
    }
  }

  if (args.includeScripting) {
    try {
      cursor.mcp.registerServer({
        name: MCP_SERVERS.scripting,
        server: {
          command: args.pythonPath,
          args: [args.scriptingServerScript],
          env: {
            SCRIPTING_REF_PATH: args.scriptingRefPath,
            JS_PERFORMANCE_PATH: args.jsPerformancePath
          }
        }
      });
      registered.push(MCP_SERVERS.scripting);
    } catch (error) {
      console.warn(
        '[servicenow-xml] Scripting MCP register failed (non-fatal):',
        error
      );
    }
  }

  return { registered, unregistered };
}

function registerPluginPath(pluginDest: string): string | undefined {
  const cursor = getCursorApi();
  if (!cursor?.plugins?.registerPath) {
    return undefined;
  }
  cursor.plugins.registerPath(pluginDest);
  return pluginDest;
}

/**
 * Sync extension-managed user rules under ~/.cursor/rules to the bundled set.
 * Only touches files that carry the managed marker (or the current prefix + marker
 * after write). Unrelated and unmarked user rules are left alone.
 *
 * Returns only the files that actually changed on disk: callers use a non-empty
 * result to prompt for a window reload, so an unchanged install must report none.
 */
function syncUserRules(rulesSrc: string): string[] {
  if (!fs.existsSync(rulesSrc)) {
    return [];
  }
  const userRulesDir = path.join(os.homedir(), '.cursor', 'rules');
  ensureDir(userRulesDir);
  const changed: string[] = [];

  const desired = new Map<string, string>();
  for (const name of fs.readdirSync(rulesSrc)) {
    if (!name.endsWith('.mdc') || !name.startsWith(USER_RULES_PREFIX)) {
      continue;
    }
    let body = fs.readFileSync(path.join(rulesSrc, name), 'utf8');
    if (!body.includes(USER_RULES_MARKER)) {
      body = `<!-- ${USER_RULES_MARKER} -->\n${body}`;
    }
    desired.set(name, body);
  }

  // Drop managed rules that are no longer bundled (e.g. renamed rule files).
  for (const name of fs.readdirSync(userRulesDir)) {
    if (!name.endsWith('.mdc') || desired.has(name)) {
      continue;
    }
    const destPath = path.join(userRulesDir, name);
    let body = '';
    try {
      body = fs.readFileSync(destPath, 'utf8');
    } catch {
      continue;
    }
    const managed =
      body.includes(USER_RULES_MARKER) ||
      body.includes('managed-by: servicenow-xml-extension');
    if (!managed) {
      continue;
    }
    try {
      fs.unlinkSync(destPath);
      changed.push(`removed:${name}`);
    } catch {
      // Leave the file if locked.
    }
  }

  for (const [name, body] of desired) {
    const destPath = path.join(userRulesDir, name);
    let existing: string | undefined;
    try {
      existing = fs.readFileSync(destPath, 'utf8');
    } catch {
      existing = undefined;
    }
    if (existing === body) {
      continue;
    }
    fs.writeFileSync(destPath, body, 'utf8');
    changed.push(name);
  }
  return changed;
}

/**
 * Merge sessionStart indexer hook into ~/.cursor/hooks.json without duplicating.
 */
function installSessionStartHook(hookScript: string): boolean {
  const hooksJsonPath = path.join(os.homedir(), '.cursor', 'hooks.json');
  ensureDir(path.dirname(hooksJsonPath));

  let doc: { version?: number; hooks?: Record<string, unknown[]> } = {
    version: 1,
    hooks: {}
  };
  if (fs.existsSync(hooksJsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8')) as typeof doc;
      if (parsed && typeof parsed === 'object') {
        doc = parsed;
      }
    } catch {
      // Keep default empty doc; do not destroy a corrupt file blindly.
      return false;
    }
  }
  doc.version = doc.version ?? 1;
  doc.hooks = doc.hooks ?? {};

  const pythonPath =
    vscode.workspace
      .getConfiguration('servicenowXml')
      .get<string>('cursorHelpers.pythonPath', 'python') || 'python';
  const command = `${quoteForShell(pythonPath)} ${quoteForShell(hookScript)}`;
  const entry = { command, timeout: 180 };

  const existing = Array.isArray(doc.hooks.sessionStart)
    ? [...doc.hooks.sessionStart]
    : [];
  const filtered = existing.filter((item) => {
    if (!item || typeof item !== 'object') {
      return true;
    }
    const cmd = (item as { command?: string }).command;
    return !(typeof cmd === 'string' && cmd.includes(HOOK_MARKER));
  });
  filtered.push(entry);
  doc.hooks.sessionStart = filtered;

  const next = `${JSON.stringify(doc, null, 2)}\n`;
  const prev = fs.existsSync(hooksJsonPath)
    ? fs.readFileSync(hooksJsonPath, 'utf8')
    : '';
  if (prev === next) {
    return true;
  }
  fs.writeFileSync(hooksJsonPath, next, 'utf8');
  return true;
}

function writeManifest(
  context: vscode.ExtensionContext,
  paths: {
    schemaCsvGz: string;
    scriptingRefGz: string;
    jsPerformanceRef: string;
    scriptsDest: string;
    hooksDest: string;
    pluginDest: string;
  }
): void {
  const files: Record<string, string> = {};
  for (const file of [
    path.join(paths.scriptsDest, 'servicenow_repo_index.py'),
    path.join(paths.scriptsDest, 'db_schema_mcp_server.py'),
    path.join(paths.scriptsDest, 'scripting_mcp_server.py'),
    path.join(paths.hooksDest, 'session_start_index.py'),
    paths.schemaCsvGz,
    paths.scriptingRefGz,
    paths.jsPerformanceRef
  ]) {
    if (fs.existsSync(file)) {
      files[file] = sha256File(file);
    }
  }
  const manifest: InstallManifest = {
    version: context.extension.packageJSON.version ?? '0.0.0',
    files,
    schemaSha256: files[paths.schemaCsvGz]
  };
  fs.writeFileSync(
    path.join(HELPERS_HOME, MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  );
}

function syncFile(src: string, dest: string): number {
  if (!fs.existsSync(src)) {
    return 0;
  }
  if (fs.existsSync(dest) && sameFileContent(src, dest)) {
    return 0;
  }
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
  return 1;
}

function syncDir(src: string, dest: string): number {
  if (!fs.existsSync(src)) {
    return 0;
  }
  ensureDir(dest);
  let count = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      count += syncDir(from, to);
    } else if (entry.isFile()) {
      count += syncFile(from, to);
    }
  }
  return count;
}

/**
 * Delete files under dest that are not present under src (same relative names).
 * Used so renamed rules (servicenow-* → servicenow-xml-*) do not linger in the plugin tree.
 */
function pruneExtraFiles(dest: string, src: string): void {
  if (!fs.existsSync(dest) || !fs.existsSync(src)) {
    return;
  }
  const keep = new Set(fs.readdirSync(src));
  for (const name of fs.readdirSync(dest)) {
    if (keep.has(name)) {
      continue;
    }
    const target = path.join(dest, name);
    try {
      if (fs.statSync(target).isFile()) {
        fs.unlinkSync(target);
      }
    } catch {
      // Ignore locked/missing files.
    }
  }
}

function sameFileContent(a: string, b: string): boolean {
  const aStat = fs.statSync(a);
  const bStat = fs.statSync(b);
  if (aStat.size !== bStat.size) {
    return false;
  }
  return sha256File(a) === sha256File(b);
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function quoteForShell(value: string): string {
  if (process.platform === 'win32') {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
