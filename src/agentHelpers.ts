import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sncCliExists } from './snc/cli';

interface CursorMcpApi {
  registerServer: (config: {
    name: string;
    server:
      | { command: string; args: string[]; env: Record<string, string> }
      | { url: string; headers?: Record<string, string> };
  }) => void;
  unregisterServer?: (serverName: string) => void;
}

interface CursorPluginConfig {
  path: string;
}

interface CursorPluginsApi {
  addPlugin?: (config: CursorPluginConfig) => void | Thenable<void>;
  removePlugin?: (config: CursorPluginConfig) => void | Thenable<void>;
  /** @deprecated Stale docs API; prefer addPlugin/removePlugin. */
  registerPath?: (path: string) => void;
  /** @deprecated Stale docs API; prefer addPlugin/removePlugin. */
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
 * Stable identity for helpers this extension installs for agents and MCP hosts.
 * MCP server ids, rule filenames, Cursor plugin name, and managed-by markers all use this.
 */
export const PLUGIN_ID = 'servicenow-xml';

/**
 * Tool-agnostic install root for MCP scripts, schema packs, and canonical rules.
 * Host-specific adapters (Cursor plugin, per-agent rule files) read from here.
 */
export const HELPERS_HOME = path.join(os.homedir(), `.${PLUGIN_ID}`);

/** Prior Cursor-only install root; migrated once into HELPERS_HOME when present. */
const LEGACY_CURSOR_HELPERS_HOME = path.join(os.homedir(), '.cursor', PLUGIN_ID);

/** MCP server ids (prefixed with PLUGIN_ID). */
export const MCP_SERVERS = {
  docs: `${PLUGIN_ID}-docs`,
  uiExamples: `${PLUGIN_ID}-ui-examples`,
  liveInstance: `${PLUGIN_ID}-instance`,
  registry: `${PLUGIN_ID}-registry`
} as const;

const MANIFEST_NAME = 'install-manifest.json';
/** Embedded in synced agent rules so we can update/remove only our files. */
export const USER_RULES_MARKER = `managed-by: ${PLUGIN_ID}`;
/** Filename prefix for managed user/plugin rules. */
const USER_RULES_PREFIX = `${PLUGIN_ID}-`;
/** Dedicated rule filename stem (`servicenow-xml-standards.*`). */
const STANDARDS_RULE_STEM = `${PLUGIN_ID}-standards`;
/** Prior managed-by text from older installs. */
const LEGACY_RULES_MARKER = 'managed-by: servicenow-xml-extension';
const RULE_MARKER_BEGIN = `<!-- begin ${USER_RULES_MARKER} -->`;
const RULE_MARKER_END = `<!-- end ${USER_RULES_MARKER} -->`;
/** Aider global config value. Tilde form matches `~/.aider.conf.yml` `read:` entries. */
const AIDER_RULE_READ = `~/.ai-rules/${STANDARDS_RULE_STEM}.md`;

export const REMOTE_MCP: Array<{ name: string; url: string }> = [
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

export interface AgentHelpersResult {
  installed: boolean;
  skippedReason?: string;
  syncedFiles: number;
  mcpRegistered: string[];
  mcpUnregistered: string[];
  rulesSynced: string[];
  pluginPath?: string;
  messages: string[];
}

/**
 * True when helper install wrote files or agent rules that hosts may not pick up until reload.
 */
export function agentHelpersNeedReload(result: AgentHelpersResult): boolean {
  return (
    result.installed &&
    (result.syncedFiles > 0 || result.rulesSynced.length > 0)
  );
}

/**
 * Suggest Developer: Reload Window so MCP servers and rules take effect.
 */
export async function suggestReloadAfterAgentHelpers(
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
  return Boolean(
    cursor?.mcp?.registerServer ||
      cursor?.plugins?.addPlugin ||
      cursor?.plugins?.registerPath
  );
}

/**
 * Absolute path to the bundled helpers directory (rules + Cursor plugin manifest).
 */
export function bundledHelpersRoot(context: vscode.ExtensionContext): string {
  return path.join(context.extensionPath, 'helpers');
}

/** Serialize overlapping installAgentHelpers calls (activate + config + command). */
let installAgentHelpersInFlight: Promise<AgentHelpersResult> | undefined;

/**
 * Idempotently install ServiceNow agent helpers: scripts, data, rules, and host MCP.
 * Runs in VS Code and Cursor. Cursor also registers its plugin path and MCP API.
 * Registry and instance MCP are Node. Instance MCP needs snc.
 * Never throws to the caller.
 */
export async function installAgentHelpers(
  context: vscode.ExtensionContext,
  options?: { force?: boolean; showProgress?: boolean }
): Promise<AgentHelpersResult> {
  // A forced install (manual command) bypasses the in-flight guard so that
  // a user-initiated reinstall is never blocked by a skipped activation install.
  if (!options?.force && installAgentHelpersInFlight) {
    return installAgentHelpersInFlight;
  }

  const messages: string[] = [];
  const empty: AgentHelpersResult = {
    installed: false,
    syncedFiles: 0,
    mcpRegistered: [],
    mcpUnregistered: [],
    rulesSynced: [],
    messages
  };

  const cfg = vscode.workspace.getConfiguration('servicenowXml');
  if (!cfg.get<boolean>('mcp.enable', true) && !options?.force) {
    empty.skippedReason = 'disabled';
    messages.push('Agent helpers disabled (servicenowXml.mcp.enable).');
    return empty;
  }

  const run = async (): Promise<AgentHelpersResult> => {
    try {
      return await installAgentHelpersCore(context, cfg, messages, options);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      messages.push(`Agent helpers aborted (non-fatal): ${detail}`);
      console.error('[servicenow-xml] agent helpers aborted:', detail);
      return { ...empty, messages };
    }
  };

  const work = Promise.resolve(
    options?.showProgress === false
      ? run()
      : vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Window,
            title: 'ServiceNow XML: installing agent helpers'
          },
          () => run()
        )
  );

  installAgentHelpersInFlight = work.finally(() => {
    installAgentHelpersInFlight = undefined;
  });
  return installAgentHelpersInFlight;
}

/**
 * Read the install manifest, if present. Used to skip re-installation when
 * helpers are already current for this extension version.
 */
function readManifest(): InstallManifest | undefined {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(HELPERS_HOME, MANIFEST_NAME), 'utf8')
    ) as InstallManifest;
  } catch {
    return undefined;
  }
}

/**
 * True when the manifest records files that all still exist on disk with
 * matching SHAs. Falls back to a lighter check when the manifest is missing.
 */
function manifestMatchesDisk(manifest: InstallManifest): boolean {
  for (const [filePath, sha] of Object.entries(manifest.files)) {
    if (!fs.existsSync(filePath)) {
      return false;
    }
    if (sha256File(filePath) !== sha) {
      return false;
    }
  }
  return true;
}

/**
 * Move a prior Cursor-only helpers tree into HELPERS_HOME when the new root is empty.
 * Fresh installs skip this. Failures are non-fatal; a normal sync from the bundle follows.
 */
function migrateLegacyCursorHelpersHome(messages: string[]): void {
  if (fs.existsSync(HELPERS_HOME) || !fs.existsSync(LEGACY_CURSOR_HELPERS_HOME)) {
    return;
  }
  try {
    ensureDir(path.dirname(HELPERS_HOME));
    fs.renameSync(LEGACY_CURSOR_HELPERS_HOME, HELPERS_HOME);
    messages.push(
      `Migrated helpers from ${LEGACY_CURSOR_HELPERS_HOME} to ${HELPERS_HOME}`
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    messages.push(
      `Could not migrate ${LEGACY_CURSOR_HELPERS_HOME} (${detail}); installing into ${HELPERS_HOME}`
    );
  }
}

/**
 * Core helper install. Isolated so MCP/network failures cannot unwind activation.
 */
async function installAgentHelpersCore(
  context: vscode.ExtensionContext,
  cfg: vscode.WorkspaceConfiguration,
  messages: string[],
  options?: { force?: boolean }
): Promise<AgentHelpersResult> {
  const empty: AgentHelpersResult = {
    installed: false,
    syncedFiles: 0,
    mcpRegistered: [],
    mcpUnregistered: [],
    rulesSynced: [],
    messages
  };

  migrateLegacyCursorHelpersHome(messages);

  // Skip the file copy when helpers are already installed for this extension
  // version and the tracked files are intact. Cursor plugin path and MCP server
  // registration are per window: deactivate unregisters the plugin path, and
  // Cursor does not keep registerServer / addPlugin across reloads. Skipping
  // them here leaves Plugins and MCP empty while the Records navigator (a
  // normal view) still appears. The force flag always recopies.
  if (!options?.force) {
    const manifest = readManifest();
    const extVersion = context.extension.packageJSON.version ?? '0.0.0';
    const pluginManifest = path.join(
      HELPERS_HOME,
      'plugin',
      '.cursor-plugin',
      'plugin.json'
    );
    if (
      manifest &&
      manifest.version === extVersion &&
      manifestMatchesDisk(manifest) &&
      fs.existsSync(pluginManifest)
    ) {
      const session = await registerSessionHelpers(cfg, messages);
      messages.push(
        'Agent helpers up to date; re-registered host adapters for this window.',
        `MCP: ${session.registered.join(', ') || '(none)'}`,
        session.pluginPath
          ? `Cursor plugin path: ${session.pluginPath}`
          : isCursorHost()
            ? 'Cursor plugin path registration unavailable'
            : 'Cursor plugin skipped (not Cursor)'
      );
      return {
        installed: true,
        syncedFiles: 0,
        mcpRegistered: session.registered,
        mcpUnregistered: session.unregistered,
        rulesSynced: [],
        pluginPath: session.pluginPath,
        messages
      };
    }
  }

  const bundleRoot = bundledHelpersRoot(context);
  if (!fs.existsSync(bundleRoot)) {
    messages.push(`Bundled helpers missing at ${bundleRoot}`);
    return empty;
  }

  ensureDir(HELPERS_HOME);
  const scriptsDest = path.join(HELPERS_HOME, 'scripts');
  const dataDest = path.join(HELPERS_HOME, 'data');
  const pluginDest = path.join(HELPERS_HOME, 'plugin');
  ensureDir(scriptsDest);
  ensureDir(dataDest);
  ensureDir(pluginDest);

  const extensionDist = path.join(context.extensionPath, 'dist');
  let syncedFiles = 0;

  // Instance MCP (Node) — read-only snc queries. Skipped when snc is missing.
  const instanceMcpSrc = path.join(extensionDist, 'instanceMcp.js');
  const instanceMcpDest = path.join(scriptsDest, 'instanceMcp.js');
  if (fs.existsSync(instanceMcpSrc)) {
    syncedFiles += syncFile(instanceMcpSrc, instanceMcpDest);
  }

  // Registry MCP (Node) — schema, scripting/performance, workspace discovery.
  const registryMcpSrc = path.join(extensionDist, 'registryMcp.js');
  const registryMcpDest = path.join(scriptsDest, 'registryMcp.js');
  let includeRegistry = false;
  if (fs.existsSync(registryMcpSrc)) {
    syncedFiles += syncFile(registryMcpSrc, registryMcpDest);
    const distData = path.join(extensionDist, 'data');
    for (const name of [
      'dictionaryTables.json',
      'dictionaryFields.json.gz',
      'fieldKinds.json',
      'platformGlobals.json',
      'scriptIncludes.json',
      'scopes.json',
      'scripting_reference.json.gz',
      'js_performance.json'
    ]) {
      const from = path.join(distData, name);
      if (fs.existsSync(from)) {
        syncedFiles += syncFile(from, path.join(dataDest, name));
      }
    }
    includeRegistry =
      cfg.get<boolean>('mcp.registry', true) &&
      fs.existsSync(registryMcpDest) &&
      fs.existsSync(path.join(dataDest, 'dictionaryTables.json'));
    if (includeRegistry && !fs.existsSync(path.join(dataDest, 'scripting_reference.json.gz'))) {
      messages.push(
        'scripting_reference.json.gz missing under helpers data; Registry scripting tools will be empty.'
      );
    }
  } else {
    messages.push(
      'Registry MCP bundle missing (dist/registryMcp.js); Node Registry MCP skipped.'
    );
  }

  const canonicalRules = path.join(HELPERS_HOME, 'rules', 'standards.md');
  syncedFiles += syncFile(
    path.join(bundleRoot, 'rules', 'standards.md'),
    canonicalRules
  );
  syncedFiles += syncDir(
    path.join(bundleRoot, '.cursor-plugin'),
    path.join(pluginDest, '.cursor-plugin')
  );

  const rulesSynced = syncAgentRules(canonicalRules, messages);
  const session = await registerSessionHelpers(cfg, messages);
  const { registered, unregistered } = session;
  const pluginPath = session.pluginPath;

  writeManifest(context, {
    dataDest,
    scriptsDest,
    pluginDest
  });

  messages.push(
    `Synced ${syncedFiles} file(s) under ${HELPERS_HOME}`,
    `MCP: ${registered.join(', ') || '(none)'}`,
    rulesSynced.length
      ? `Agent rules: ${rulesSynced.join(', ')}`
      : 'Agent rules unchanged',
    pluginPath
      ? `Cursor plugin path: ${pluginPath}`
      : isCursorHost()
        ? 'Cursor plugin path registration unavailable'
        : 'Cursor plugin skipped (not Cursor)'
  );

  return {
    installed: true,
    syncedFiles,
    mcpRegistered: registered,
    mcpUnregistered: unregistered,
    rulesSynced,
    pluginPath,
    messages
  };
}

/**
 * Register dispose handler that unregisters the Cursor plugin path on deactivate.
 * Replaces any prior handler so activate/config/command installs do not stack.
 */
let agentHelpersDisposeHandler: (() => void) | undefined;
let agentHelpersDisposalRegistered = false;

export function registerAgentHelpersDisposal(
  context: vscode.ExtensionContext,
  pluginPath: string | undefined
): void {
  if (!pluginPath) {
    return;
  }
  const cursor = getCursorApi();
  const remove =
    cursor?.plugins?.removePlugin ||
    (cursor?.plugins?.unregisterPath
      ? (config: CursorPluginConfig) => cursor.plugins?.unregisterPath?.(config.path)
      : undefined);
  if (!remove) {
    return;
  }
  agentHelpersDisposeHandler = () => {
    try {
      void remove({ path: pluginPath });
    } catch {
      // Host may already be shutting down.
    }
  };
  if (agentHelpersDisposalRegistered) {
    return;
  }
  agentHelpersDisposalRegistered = true;
  context.subscriptions.push({
    dispose: () => {
      agentHelpersDisposeHandler?.();
      agentHelpersDisposeHandler = undefined;
    }
  });
}

/**
 * Register this window's Cursor plugin path and Cursor MCP servers from the
 * already-copied helpers under HELPERS_HOME. Does not write files.
 * No-op on plain VS Code (Copilot MCP is registered separately via vscodeMcp).
 * Returns the plugin path only when registration succeeded, so dispose does
 * not unregister a path this window never registered.
 */
async function registerSessionHelpers(
  cfg: vscode.WorkspaceConfiguration,
  messages: string[]
): Promise<{ registered: string[]; unregistered: string[]; pluginPath?: string }> {
  if (!isCursorHost()) {
    return { registered: [], unregistered: [] };
  }

  const scriptsDest = path.join(HELPERS_HOME, 'scripts');
  const dataDest = path.join(HELPERS_HOME, 'data');
  const pluginDest = path.join(HELPERS_HOME, 'plugin');
  const instanceMcpDest = path.join(scriptsDest, 'instanceMcp.js');
  const registryMcpDest = path.join(scriptsDest, 'registryMcp.js');

  const sncPath = cfg.get<string>('snc.path', 'snc') || 'snc';
  const sncOk = await sncCliExists(sncPath);
  if (!sncOk) {
    messages.push(
      `snc not available (${sncPath}); skipping ${MCP_SERVERS.liveInstance}. Registry MCP still installs.`
    );
  }

  const includeRemote = cfg.get<boolean>('mcp.remote', true);
  const includeInstance =
    sncOk &&
    fs.existsSync(instanceMcpDest) &&
    cfg.get<boolean>('mcp.instance', true);
  if (sncOk && !fs.existsSync(instanceMcpDest) && cfg.get<boolean>('mcp.instance', true)) {
    messages.push(
      'Instance MCP bundle missing (dist/instanceMcp.js); Node instance MCP skipped.'
    );
  }

  const includeRegistry =
    cfg.get<boolean>('mcp.registry', true) &&
    fs.existsSync(registryMcpDest) &&
    fs.existsSync(path.join(dataDest, 'dictionaryTables.json'));

  const { registered, unregistered } = registerMcpServers({
    includeRemote,
    instanceServerScript: instanceMcpDest,
    sncPath,
    sncProfileAllowlist: JSON.stringify(
      (cfg.get<string[]>('snc.mcpProfiles', []) || [])
        .map((name) => name.trim())
        .filter(Boolean)
    ),
    includeInstance,
    registryServerScript: registryMcpDest,
    registryDataDir: dataDest,
    includeRegistry
  });

  return {
    registered,
    unregistered,
    pluginPath: registerPluginPath(pluginDest)
  };
}

/**
 * Runtime command for bundled MCP scripts, plus env the host must apply.
 * Uses an absolute Node path when the extension host PATH contains one, so
 * the MCP process does not depend on `node` being resolvable later.
 * Without Node, uses the editor executable and ELECTRON_RUN_AS_NODE so the
 * script still runs (same mechanism as the VS Code MCP provider).
 */
function bundledMcpLaunch(): { command: string; env: Record<string, string> } {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path');
  const entries = (pathKey ? process.env[pathKey] : '')?.split(path.delimiter) ?? [];
  const fileName = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of entries) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, fileName);
    // Windows app-execution aliases are zero-byte node.exe stubs on PATH.
    // Treating one as Node skips the editor-binary fallback and the MCP server never starts.
    if (/[\\/]WindowsApps[\\/]/i.test(candidate)) {
      continue;
    }
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && stat.size > 0) {
        return { command: candidate, env: {} };
      }
    } catch {
      // Missing or unreadable PATH entry.
    }
  }
  return {
    command: process.execPath,
    env: { ELECTRON_RUN_AS_NODE: '1' }
  };
}

function registerMcpServers(args: {
  includeRemote: boolean;
  instanceServerScript: string;
  sncPath: string;
  sncProfileAllowlist: string;
  includeInstance: boolean;
  registryServerScript: string;
  registryDataDir: string;
  includeRegistry: boolean;
}): { registered: string[]; unregistered: string[] } {
  const cursor = getCursorApi();
  const registered: string[] = [];
  const unregistered: string[] = [];
  if (!cursor?.mcp?.registerServer) {
    return { registered, unregistered };
  }
  const launch = bundledMcpLaunch();
  const usageLogPath = path.join(HELPERS_HOME, 'mcp-usage.log');

  // Retire any server this install is not currently registering. Deprecated
  // MCP ids (servicenow-xml-db-schema, servicenow-xml-scripting, and legacy
  // names without the servicenow-xml- prefix) are no longer auto-unregistered;
  // those must be removed manually from ~/.cursor/mcp.json if present.
  const retire = new Set<string>();
  if (!args.includeRemote) {
    retire.add(MCP_SERVERS.docs);
    retire.add(MCP_SERVERS.uiExamples);
  }
  if (!args.includeRegistry) {
    retire.add(MCP_SERVERS.registry);
  }
  if (!args.includeInstance) {
    retire.add(MCP_SERVERS.liveInstance);
  }
  if (cursor.mcp.unregisterServer) {
    for (const name of retire) {
      try {
        cursor.mcp.unregisterServer(name);
        unregistered.push(name);
      } catch {
        // Not registered yet.
      }
    }
  }

  if (args.includeRemote) {
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
  }

  if (args.includeRegistry) {
    try {
      const workspaceRoot =
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      cursor.mcp.registerServer({
        name: MCP_SERVERS.registry,
        server: {
          command: launch.command,
          args: [args.registryServerScript],
          env: {
            ...launch.env,
            MCP_USAGE_LOG_PATH: usageLogPath,
            REGISTRY_DATA_DIR: args.registryDataDir,
            ...(workspaceRoot
              ? {
                  REGISTRY_WORKSPACE: workspaceRoot,
                  REGISTRY_CACHE_PATH: path.join(
                    workspaceRoot,
                    '.servicenow-xml',
                    'registry-cache.json'
                  )
                }
              : {})
          }
        }
      });
      registered.push(MCP_SERVERS.registry);
    } catch (error) {
      console.warn(
        '[servicenow-xml] Registry MCP register failed (non-fatal):',
        error
      );
    }
  }

  if (args.includeInstance) {
    try {
      cursor.mcp.registerServer({
        name: MCP_SERVERS.liveInstance,
        server: {
          command: launch.command,
          args: [args.instanceServerScript],
          env: {
            ...launch.env,
            MCP_USAGE_LOG_PATH: usageLogPath,
            SNC_PATH: args.sncPath,
            SNC_PROFILE_ALLOWLIST: args.sncProfileAllowlist
          }
        }
      });
      registered.push(MCP_SERVERS.liveInstance);
    } catch (error) {
      console.warn(
        '[servicenow-xml] Instance MCP register failed (non-fatal):',
        error
      );
    }
  }

  return { registered, unregistered };
}

function registerPluginPath(pluginDest: string): string | undefined {
  const cursor = getCursorApi();
  if (cursor?.plugins?.addPlugin) {
    void cursor.plugins.addPlugin({ path: pluginDest });
    return pluginDest;
  }
  if (cursor?.plugins?.registerPath) {
    cursor.plugins.registerPath(pluginDest);
    return pluginDest;
  }
  return undefined;
}

/**
 * Install the canonical ServiceNow rules file for each supported agent.
 * Unix dedicated destinations are relative symlinks. Windows copies the file.
 * Single-file configs are updated only between begin/end markers.
 * Returns paths that changed, so an unchanged install does not prompt for reload.
 */
function syncAgentRules(canonicalPath: string, messages: string[]): string[] {
  if (!fs.existsSync(canonicalPath)) {
    messages.push(`Agent rules skipped (missing ${canonicalPath})`);
    return [];
  }
  const changed: string[] = [];
  let body = fs.readFileSync(canonicalPath, 'utf8');
  if (!body.includes(USER_RULES_MARKER)) {
    // Keep the marker in the in-memory body for distribution to agent rule
    // files, but do NOT write it back to the canonical file. The canonical
    // file is the output of syncFile (which copies the unmarked bundled
    // source); mutating it here would make every subsequent syncFile see a
    // diff and re-copy, creating an infinite resync loop that triggers the
    // reload notification on every window activation.
    body = `<!-- ${USER_RULES_MARKER} -->\n${body}`;
  }

  pruneLegacyCursorRules(changed);
  pruneExtraPluginRules(changed);
  for (const dest of dedicatedRuleDestinations()) {
    installDedicatedRule(dest, canonicalPath, body, changed, messages);
  }
  const markedBody = stripRuleFrontmatter(body).trim();
  for (const dest of markerRuleDestinations()) {
    spliceMarkedRules(dest, markedBody, changed, messages);
  }
  ensureAiderRead(changed, messages);
  return changed;
}

/**
 * Home-directory files that should contain only these rules.
 * The Cursor plugin copy stays under HELPERS_HOME/plugin for addPlugin.
 */
function dedicatedRuleDestinations(): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.cursor', 'rules', `${STANDARDS_RULE_STEM}.mdc`),
    path.join(
      HELPERS_HOME,
      'plugin',
      'rules',
      `${STANDARDS_RULE_STEM}.mdc`
    ),
    path.join(home, '.claude', 'rules', `${STANDARDS_RULE_STEM}.md`),
    path.join(home, '.clinerules', `${STANDARDS_RULE_STEM}.md`),
    path.join(home, '.pearai', 'rules', `${STANDARDS_RULE_STEM}.md`),
    path.join(home, '.ai-rules', `${STANDARDS_RULE_STEM}.md`),
    path.join(home, '.copilot', 'instructions', `${STANDARDS_RULE_STEM}.instructions.md`)
  ];
}

/**
 * Shared instruction files. The standards body is spliced between markers
 * so other user text in the same file is left in place.
 */
function markerRuleDestinations(): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.codeium', 'windsurf', 'memories', 'global_rules.md'),
    path.join(home, 'copilot-instructions.md'),
    path.join(home, '.copilot', 'copilot-instructions.md')
  ];
}

/**
 * Remove per-topic Cursor user rules from older installs.
 * Keeps `servicenow-xml-standards.mdc` and any file that is not ours.
 */
function pruneLegacyCursorRules(changed: string[]): void {
  const userRulesDir = path.join(os.homedir(), '.cursor', 'rules');
  if (!fs.existsSync(userRulesDir)) {
    return;
  }
  const keep = `${STANDARDS_RULE_STEM}.mdc`;
  for (const name of fs.readdirSync(userRulesDir)) {
    if (!name.endsWith('.mdc') || !name.startsWith(USER_RULES_PREFIX) || name === keep) {
      continue;
    }
    const destPath = path.join(userRulesDir, name);
    if (!isManagedRulePath(destPath)) {
      continue;
    }
    try {
      fs.unlinkSync(destPath);
      changed.push(`removed:${name}`);
    } catch {
      // Leave the file if locked.
    }
  }
}

/**
 * Drop retired files in the Cursor plugin rules directory.
 * That directory is extension-owned; the named standards rule is the only file kept.
 */
function pruneExtraPluginRules(changed: string[]): void {
  const dir = path.join(HELPERS_HOME, 'plugin', 'rules');
  if (!fs.existsSync(dir)) {
    return;
  }
  const keep = `${STANDARDS_RULE_STEM}.mdc`;
  for (const name of fs.readdirSync(dir)) {
    if (name === keep) {
      continue;
    }
    const target = path.join(dir, name);
    try {
      const st = fs.lstatSync(target);
      if (!st.isFile() && !st.isSymbolicLink()) {
        continue;
      }
      fs.unlinkSync(target);
      changed.push(`removed:${name}`);
    } catch {
      // Leave the file if locked.
    }
  }
}

/**
 * True when this path is a rule file or symlink this extension installed.
 */
function isManagedRulePath(destPath: string): boolean {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(destPath);
  } catch {
    return false;
  }
  if (st.isSymbolicLink()) {
    try {
      return symlinkPointsAtOurRules(fs.readlinkSync(destPath), destPath);
    } catch {
      return false;
    }
  }
  if (!st.isFile()) {
    return false;
  }
  try {
    const text = fs.readFileSync(destPath, 'utf8');
    return text.includes(USER_RULES_MARKER) || text.includes(LEGACY_RULES_MARKER);
  } catch {
    return false;
  }
}

/**
 * True when a symlink target resolves inside the installed rules directory
 * or is the canonical standards file.
 */
function symlinkPointsAtOurRules(link: string, destPath: string): boolean {
  const resolved = path.resolve(path.dirname(destPath), link);
  const rulesDir = path.join(HELPERS_HOME, 'rules');
  if (samePath(resolved, path.join(rulesDir, 'standards.md'))) {
    return true;
  }
  const resolvedNorm = path.normalize(resolved);
  const rulesNorm = path.normalize(rulesDir);
  const prefix = rulesNorm.endsWith(path.sep) ? rulesNorm : rulesNorm + path.sep;
  return process.platform === 'win32'
    ? resolvedNorm.toLowerCase().startsWith(prefix.toLowerCase())
    : resolvedNorm.startsWith(prefix);
}

/** Path equality. Windows compares case-insensitively. */
function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/**
 * Install one dedicated rules file: relative symlink on Unix, file copy on Windows.
 * Skips an existing file that does not carry the managed marker.
 */
function installDedicatedRule(
  dest: string,
  canonicalPath: string,
  body: string,
  changed: string[],
  messages: string[]
): void {
  try {
    ensureDir(path.dirname(dest));
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(dest);
    } catch {
      st = undefined;
    }
    if (!st) {
      writeDedicatedRule(dest, canonicalPath, body);
      changed.push(dest);
      return;
    }
    if (st.isSymbolicLink()) {
      const link = fs.readlinkSync(dest);
      if (!symlinkPointsAtOurRules(link, dest)) {
        messages.push(`Skipped ${dest} (symlink is not managed by ${PLUGIN_ID})`);
        return;
      }
      if (process.platform !== 'win32') {
        const desired = path.relative(path.dirname(dest), canonicalPath);
        if (normalizeLink(link) === normalizeLink(desired)) {
          return;
        }
        replaceWithSymlink(dest, desired, link);
        changed.push(dest);
        return;
      }
      fs.unlinkSync(dest);
      fs.writeFileSync(dest, body, 'utf8');
      changed.push(dest);
      return;
    }
    if (!st.isFile()) {
      messages.push(`Skipped ${dest} (not a file)`);
      return;
    }
    const existing = fs.readFileSync(dest, 'utf8');
    const managed =
      existing.includes(USER_RULES_MARKER) || existing.includes(LEGACY_RULES_MARKER);
    if (!managed) {
      messages.push(`Skipped ${dest} (unmarked existing file)`);
      return;
    }
    if (process.platform !== 'win32') {
      const desired = path.relative(path.dirname(dest), canonicalPath);
      fs.unlinkSync(dest);
      try {
        fs.symlinkSync(desired, dest);
      } catch (error) {
        fs.writeFileSync(dest, existing, 'utf8');
        throw error;
      }
      changed.push(dest);
      return;
    }
    if (existing === body) {
      return;
    }
    fs.writeFileSync(dest, body, 'utf8');
    changed.push(dest);
  } catch (error) {
    messages.push(
      `Agent rule skipped ${dest}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Create a relative symlink on Unix, or write the canonical bytes on Windows. */
function writeDedicatedRule(dest: string, canonicalPath: string, body: string): void {
  if (process.platform === 'win32') {
    fs.writeFileSync(dest, body, 'utf8');
    return;
  }
  fs.symlinkSync(path.relative(path.dirname(dest), canonicalPath), dest);
}

/**
 * Replace a symlink this extension owns. Restores the previous link if creation fails.
 */
function replaceWithSymlink(dest: string, desired: string, previousLink: string): void {
  fs.unlinkSync(dest);
  try {
    fs.symlinkSync(desired, dest);
  } catch (error) {
    try {
      fs.symlinkSync(previousLink, dest);
    } catch {
      // The original link could not be restored.
    }
    throw error;
  }
}

/** Compare symlink targets without treating slash direction as a difference. */
function normalizeLink(link: string): string {
  return link.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Drop a leading YAML frontmatter block so marker splices stay tool-neutral. */
function stripRuleFrontmatter(text: string): string {
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? text.slice(match[0].length) : text;
}

/**
 * Insert or replace the managed block in a shared instructions file.
 * Creates the file when it is missing. Does not rewrite text outside the markers.
 */
function spliceMarkedRules(
  dest: string,
  markedBody: string,
  changed: string[],
  messages: string[]
): void {
  const block = `${RULE_MARKER_BEGIN}\n${markedBody}\n${RULE_MARKER_END}\n`;
  try {
    let existing: string | undefined;
    try {
      existing = fs.readFileSync(dest, 'utf8');
    } catch {
      existing = undefined;
    }
    if (existing === undefined) {
      ensureDir(path.dirname(dest));
      fs.writeFileSync(dest, block, 'utf8');
      changed.push(dest);
      return;
    }
    const begin = existing.indexOf(RULE_MARKER_BEGIN);
    const end = existing.indexOf(RULE_MARKER_END);
    if (begin === -1 && end === -1) {
      const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
      const next = `${existing}${sep}${block}`;
      if (next !== existing) {
        fs.writeFileSync(dest, next, 'utf8');
        changed.push(dest);
      }
      return;
    }
    if (begin === -1 || end < begin) {
      messages.push(`Skipped ${dest} (unbalanced ${PLUGIN_ID} rule markers)`);
      return;
    }
    const after = existing.slice(end + RULE_MARKER_END.length).replace(/^\r?\n/, '');
    const next = existing.slice(0, begin) + block + after;
    if (next !== existing) {
      fs.writeFileSync(dest, next, 'utf8');
      changed.push(dest);
    }
  } catch (error) {
    messages.push(
      `Agent rule skipped ${dest}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Ensure `~/.aider.conf.yml` reads the Aider rules file.
 * Adds a `read:` entry without changing other keys. Creates the file when missing.
 */
function ensureAiderRead(changed: string[], messages: string[]): void {
  const confPath = path.join(os.homedir(), '.aider.conf.yml');
  let existing = '';
  try {
    existing = fs.readFileSync(confPath, 'utf8');
  } catch {
    existing = '';
  }
  if (existing.includes(AIDER_RULE_READ)) {
    return;
  }
  try {
    const next = upsertAiderRead(existing, AIDER_RULE_READ);
    if (next === existing) {
      return;
    }
    ensureDir(path.dirname(confPath));
    fs.writeFileSync(confPath, next, 'utf8');
    changed.push(confPath);
  } catch (error) {
    messages.push(
      `Aider config skipped: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Add `readPath` to an Aider YAML config. A scalar `read:` becomes a list
 * that still contains the previous value.
 */
function upsertAiderRead(existing: string, readPath: string): string {
  if (!existing.trim()) {
    return `read: ${readPath}\n`;
  }
  const nl = existing.includes('\r\n') ? '\r\n' : '\n';
  const lines = existing.split(/\r?\n/);
  const readIndex = lines.findIndex((line) => /^read:\s*/.test(line));
  if (readIndex === -1) {
    const suffix = existing.endsWith('\n') ? '' : nl;
    return `${existing}${suffix}read: ${readPath}${nl}`;
  }
  const scalar = lines[readIndex].match(/^read:\s+(\S.*?)\s*$/);
  if (scalar) {
    lines.splice(readIndex, 1, 'read:', `  - ${scalar[1].trim()}`, `  - ${readPath}`);
    return joinConfigLines(lines, existing, nl);
  }
  let insertAt = readIndex + 1;
  while (insertAt < lines.length) {
    const line = lines[insertAt];
    if (line.includes(readPath)) {
      return existing;
    }
    if (line.trim() === '') {
      const next = lines[insertAt + 1];
      if (next === undefined || !/^\s/.test(next)) {
        break;
      }
      insertAt++;
      continue;
    }
    if (/^\s/.test(line)) {
      insertAt++;
      continue;
    }
    break;
  }
  lines.splice(insertAt, 0, `  - ${readPath}`);
  return joinConfigLines(lines, existing, nl);
}

/** Join YAML lines with the source newline style and trailing newline. */
function joinConfigLines(lines: string[], original: string, nl: string): string {
  let text = lines.join(nl);
  const ended = original.endsWith('\n');
  if (ended && !text.endsWith('\n')) {
    text += nl;
  }
  if (!ended && text.endsWith('\n')) {
    text = text.replace(/\r?\n$/, '');
  }
  return text;
}

function writeManifest(
  context: vscode.ExtensionContext,
  paths: {
    dataDest: string;
    scriptsDest: string;
    pluginDest: string;
  }
): void {
  const files: Record<string, string> = {};
  for (const file of [
    path.join(paths.scriptsDest, 'instanceMcp.js'),
    path.join(paths.scriptsDest, 'registryMcp.js'),
    path.join(paths.dataDest, 'dictionaryTables.json'),
    path.join(paths.dataDest, 'dictionaryFields.json.gz'),
    path.join(paths.dataDest, 'fieldKinds.json'),
    path.join(paths.dataDest, 'scripting_reference.json.gz'),
    path.join(paths.dataDest, 'js_performance.json'),
    path.join(paths.dataDest, 'platformGlobals.json'),
    path.join(paths.dataDest, 'scriptIncludes.json'),
    path.join(paths.dataDest, 'scopes.json')
  ]) {
    if (fs.existsSync(file)) {
      files[file] = sha256File(file);
    }
  }
  const manifest: InstallManifest = {
    version: context.extension.packageJSON.version ?? '0.0.0',
    files
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
