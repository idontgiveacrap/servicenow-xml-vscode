/**
 * Install ServiceNow MCP server entries into other agents' user config files,
 * mirroring the Cursor API / VS Code provider registration in agentHelpers.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
const PLUGIN_ID = 'servicenow-xml';

const MCP_SERVERS = {
  docs: `${PLUGIN_ID}-docs`,
  uiExamples: `${PLUGIN_ID}-ui-examples`,
  liveInstance: `${PLUGIN_ID}-instance`,
  registry: `${PLUGIN_ID}-registry`
} as const;

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

const MCP_MARKER_BEGIN = `# begin managed-by: ${PLUGIN_ID}-mcp`;
const MCP_MARKER_END = `# end managed-by: ${PLUGIN_ID}-mcp`;

/** One MCP server to write into agent config files. */
export interface AgentMcpServerSpec {
  id: string;
  kind: 'stdio' | 'remote';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

/**
 * Build the MCP server list from extension settings and installed helper scripts.
 */
export function buildAgentMcpServerSpecs(options: {
  mcpEnable: boolean;
  includeRemote: boolean;
  includeRegistry: boolean;
  includeInstance: boolean;
  registryScript: string;
  registryDataDir: string;
  instanceScript: string;
  sncPath: string;
  sncProfileAllowlist: string;
  usageLogPath: string;
  launch: { command: string; env: Record<string, string> };
}): AgentMcpServerSpec[] {
  if (!options.mcpEnable) {
    return [];
  }
  const usageLogPath = options.usageLogPath;
  const servers: AgentMcpServerSpec[] = [];
  if (options.includeRemote) {
    for (const remote of REMOTE_MCP) {
      servers.push({ id: remote.name, kind: 'remote', url: remote.url });
    }
  }
  if (
    options.includeRegistry &&
    fs.existsSync(options.registryScript) &&
    fs.existsSync(path.join(options.registryDataDir, 'dictionaryTables.json'))
  ) {
    servers.push({
      id: MCP_SERVERS.registry,
      kind: 'stdio',
      command: options.launch.command,
      args: [options.registryScript],
      env: {
        ...options.launch.env,
        MCP_USAGE_LOG_PATH: usageLogPath,
        REGISTRY_DATA_DIR: options.registryDataDir
      }
    });
  }
  if (options.includeInstance && fs.existsSync(options.instanceScript)) {
    servers.push({
      id: MCP_SERVERS.liveInstance,
      kind: 'stdio',
      command: options.launch.command,
      args: [options.instanceScript],
      env: {
        ...options.launch.env,
        MCP_USAGE_LOG_PATH: usageLogPath,
        SNC_PATH: options.sncPath,
        SNC_PROFILE_ALLOWLIST: options.sncProfileAllowlist
      }
    });
  }
  return servers;
}

/**
 * Merge MCP specs into each supported agent's user config. Returns paths that changed.
 */
export function syncAgentMcpConfigs(
  servers: AgentMcpServerSpec[],
  messages: string[]
): string[] {
  const changed: string[] = [];
  const ourIds = new Set<string>([
    ...Object.values(MCP_SERVERS),
    ...REMOTE_MCP.map((remote) => remote.name)
  ]);

  for (const dest of jsonMcpDestinations()) {
    if (mergeJsonMcpFile(dest.path, dest.format, servers, ourIds, messages)) {
      changed.push(dest.path);
    }
  }

  for (const dest of clineGlobalStoragePaths()) {
    if (fs.existsSync(path.dirname(dest))) {
      if (mergeJsonMcpFile(dest, 'cline', servers, ourIds, messages)) {
        changed.push(dest);
      }
    }
  }

  const codexPath = codexConfigPath();
  if (mergeCodexToml(codexPath, servers, ourIds, messages)) {
    changed.push(codexPath);
  }

  return changed;
}

type JsonMcpFormat =
  | 'claude'
  | 'cline'
  | 'windsurf'
  | 'copilot-cli'
  | 'gemini';

function jsonMcpDestinations(): Array<{ path: string; format: JsonMcpFormat }> {
  const home = os.homedir();
  const configDir = process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
    : path.join(home, '.claude.json');
  const windsurfLegacy = path.join(home, '.codeium', 'windsurf', 'mcp_config.json');
  const devinWin = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'devin', 'mcp_config.json')
    : '';
  const devinUnix = path.join(home, '.config', 'devin', 'mcp_config.json');
  const out: Array<{ path: string; format: JsonMcpFormat }> = [
    { path: configDir, format: 'claude' },
    { path: windsurfLegacy, format: 'windsurf' },
    { path: path.join(home, '.copilot', 'mcp-config.json'), format: 'copilot-cli' },
    { path: path.join(home, '.gemini', 'settings.json'), format: 'gemini' },
    { path: path.join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json'), format: 'cline' }
  ];
  if (devinWin) {
    out.push({ path: devinWin, format: 'windsurf' });
  }
  if (fs.existsSync(path.dirname(devinUnix))) {
    out.push({ path: devinUnix, format: 'windsurf' });
  }
  return out;
}

function clineGlobalStoragePaths(): string[] {
  const home = os.homedir();
  const roots = [
    path.join(home, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage'),
    path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage'),
    path.join(home, '.config', 'Cursor', 'User', 'globalStorage'),
    path.join(home, '.config', 'Code', 'User', 'globalStorage'),
    path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage'),
    path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage')
  ];
  const paths: string[] = [];
  for (const root of roots) {
    const cline = path.join(
      root,
      'saoudrizwan.claude-dev',
      'settings',
      'cline_mcp_settings.json'
    );
    if (fs.existsSync(path.dirname(cline))) {
      paths.push(cline);
    }
  }
  return paths;
}

function codexConfigPath(): string {
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  return path.join(home, 'config.toml');
}

/** Merge MCP specs into one JSON config file (exported for smoke tests). */
export function mergeJsonMcpFile(
  filePath: string,
  format: JsonMcpFormat,
  servers: AgentMcpServerSpec[],
  ourIds: Set<string>,
  messages: string[]
): boolean {
  let root: Record<string, unknown> = {};
  try {
    if (fs.existsSync(filePath)) {
      root = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    }
  } catch (error) {
    messages.push(
      `MCP config skipped ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }

  const key = format === 'gemini' ? 'mcpServers' : 'mcpServers';
  const existing =
    (root[key] as Record<string, unknown> | undefined) ?? {};
  const next: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(existing)) {
    if (!ourIds.has(name)) {
      next[name] = value;
    }
  }
  for (const server of servers) {
    next[server.id] = jsonServerEntry(server, format);
  }

  if (Object.keys(next).length === 0) {
    delete root[key];
  } else {
    root[key] = next;
  }

  const serialized = `${JSON.stringify(root, null, 2)}\n`;
  let prior = '';
  try {
    prior = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  } catch {
    prior = '';
  }
  if (prior === serialized) {
    return false;
  }
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, serialized, 'utf8');
    return true;
  } catch (error) {
    messages.push(
      `MCP config skipped ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

function jsonServerEntry(
  server: AgentMcpServerSpec,
  format: JsonMcpFormat
): Record<string, unknown> {
  if (server.kind === 'remote') {
    switch (format) {
      case 'claude':
        return { type: 'http', url: server.url };
      case 'cline':
        return { type: 'streamableHttp', url: server.url, disabled: false, autoApprove: [] };
      case 'windsurf':
        return { serverUrl: server.url };
      case 'gemini':
        return { httpUrl: server.url };
      default:
        return { url: server.url };
    }
  }
  const entry: Record<string, unknown> = {
    command: server.command,
    args: server.args ?? [],
    env: server.env ?? {}
  };
  if (format === 'claude') {
    entry.type = 'stdio';
  }
  if (format === 'cline') {
    entry.disabled = false;
    entry.autoApprove = [];
  }
  return entry;
}

/** Merge MCP specs into one Codex TOML file (exported for smoke tests). */
export function mergeCodexToml(
  filePath: string,
  servers: AgentMcpServerSpec[],
  ourIds: Set<string>,
  messages: string[]
): boolean {
  let existing = '';
  try {
    existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  } catch (error) {
    messages.push(
      `MCP config skipped ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }

  const stripped = stripCodexManagedBlock(existing, ourIds);
  const block = buildCodexManagedBlock(servers);
  const next =
    block.length > 0
      ? `${stripped.trimEnd()}${stripped.length > 0 && !stripped.endsWith('\n') ? '\n' : ''}${stripped.endsWith('\n') || stripped.length === 0 ? '' : '\n'}${block}`
      : stripped;

  const normalized = next.endsWith('\n') ? next : `${next}\n`;
  if (normalized === (existing.endsWith('\n') ? existing : `${existing}\n`)) {
    return false;
  }
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, normalized, 'utf8');
    return true;
  } catch (error) {
    messages.push(
      `MCP config skipped ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

function stripCodexManagedBlock(text: string, ourIds: Set<string>): string {
  const begin = text.indexOf(MCP_MARKER_BEGIN);
  const end = text.indexOf(MCP_MARKER_END);
  if (begin !== -1 && end !== -1 && end > begin) {
    return text.slice(0, begin) + text.slice(end + MCP_MARKER_END.length);
  }
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const header = /^\[mcp_servers\.([^\]]+)\]\s*$/.exec(lines[i]);
    if (header && ourIds.has(header[1])) {
      i++;
      while (i < lines.length && !/^\[/.test(lines[i])) {
        i++;
      }
      i--;
      continue;
    }
    kept.push(lines[i]);
  }
  return kept.join('\n');
}

function buildCodexManagedBlock(servers: AgentMcpServerSpec[]): string {
  if (servers.length === 0) {
    return '';
  }
  const lines = [MCP_MARKER_BEGIN];
  for (const server of servers) {
    lines.push(`[mcp_servers.${server.id}]`);
    if (server.kind === 'remote') {
      lines.push(`url = ${tomlString(server.url ?? '')}`);
    } else {
      lines.push(`command = ${tomlString(server.command ?? '')}`);
      if (server.args && server.args.length > 0) {
        lines.push('args = [');
        for (const arg of server.args) {
          lines.push(`  ${tomlString(arg)},`);
        }
        lines.push(']');
      }
      if (server.env) {
        for (const [key, value] of Object.entries(server.env)) {
          lines.push(`${key} = ${tomlString(value)}`);
        }
      }
    }
    lines.push('');
  }
  lines.push(MCP_MARKER_END);
  lines.push('');
  return lines.join('\n');
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
