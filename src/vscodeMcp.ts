/**
 * Register ServiceNow MCP servers with VS Code's Copilot MCP API.
 * Cursor uses cursor.mcp.registerServer instead, so this is a no-op there.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { HELPERS_HOME, isCursorHost, MCP_SERVERS, REMOTE_MCP } from './agentHelpers';
import { sncCliExists } from './snc/cli';

const MCP_PROVIDER_ID = 'servicenow-xml';

interface StdioServerCtor {
  new (
    label: string,
    command: string,
    args?: string[],
    env?: Record<string, string | number | null>,
    version?: string
  ): object;
}

interface HttpServerCtor {
  new (
    label: string,
    uri: vscode.Uri,
    headers?: Record<string, string>,
    version?: string
  ): object;
}

interface VsCodeMcpApi {
  McpStdioServerDefinition: StdioServerCtor;
  McpHttpServerDefinition: HttpServerCtor;
  lm: {
    registerMcpServerDefinitionProvider(
      id: string,
      provider: {
        onDidChangeMcpServerDefinitions?: vscode.Event<void>;
        provideMcpServerDefinitions(): Promise<object[]>;
      }
    ): vscode.Disposable;
  };
}

/**
 * VS Code MCP classes when this host exposes them. Absent on older VS Code and unused in Cursor.
 */
function vscodeMcpApi(): VsCodeMcpApi | undefined {
  const vs = vscode as unknown as {
    McpStdioServerDefinition?: StdioServerCtor;
    McpHttpServerDefinition?: HttpServerCtor;
    lm?: {
      registerMcpServerDefinitionProvider?: VsCodeMcpApi['lm']['registerMcpServerDefinitionProvider'];
    };
  };
  if (
    !vs.McpStdioServerDefinition ||
    !vs.McpHttpServerDefinition ||
    !vs.lm?.registerMcpServerDefinitionProvider
  ) {
    return undefined;
  }
  return vs as VsCodeMcpApi;
}

/**
 * Publish Registry, instance, and remote docs MCP servers to VS Code.
 * `servicenowXml.mcp.enable` turns the set on or off. Per-tool toggles
 * (mcp.registry, mcp.instance, mcp.remote) skip individual servers.
 */
export function registerVsCodeMcp(context: vscode.ExtensionContext): void {
  if (isCursorHost()) {
    return;
  }
  const api = vscodeMcpApi();
  if (!api) {
    return;
  }

  const changes = new vscode.EventEmitter<void>();
  context.subscriptions.push(changes);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('servicenowXml.mcp.enable') ||
        event.affectsConfiguration('servicenowXml.mcp.registry') ||
        event.affectsConfiguration('servicenowXml.mcp.instance') ||
        event.affectsConfiguration('servicenowXml.mcp.remote') ||
        event.affectsConfiguration('servicenowXml.snc.path') ||
        event.affectsConfiguration('servicenowXml.snc.mcpProfiles')
      ) {
        changes.fire();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      changes.fire();
    }),
    api.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, {
      onDidChangeMcpServerDefinitions: changes.event,
      provideMcpServerDefinitions: () =>
        provideMcpServers(context, api, extensionVersion(context))
    })
  );
}

/**
 * Server definitions for the current workspace and snc settings.
 */
async function provideMcpServers(
  context: vscode.ExtensionContext,
  api: VsCodeMcpApi,
  version: string
): Promise<object[]> {
  const cfg = vscode.workspace.getConfiguration('servicenowXml');
  if (!cfg.get<boolean>('mcp.enable', true)) {
    return [];
  }

  const servers: object[] = [];
  if (cfg.get<boolean>('mcp.remote', true)) {
    for (const remote of REMOTE_MCP) {
      servers.push(
        new api.McpHttpServerDefinition(
          remote.name,
          vscode.Uri.parse(remote.url),
          {},
          version
        )
      );
    }
  }

  const dist = path.join(context.extensionPath, 'dist');
  const registryScript = path.join(dist, 'registryMcp.js');
  const registryData = path.join(dist, 'data');
  if (
    cfg.get<boolean>('mcp.registry', true) &&
    fs.existsSync(registryScript) &&
    fs.existsSync(path.join(registryData, 'dictionaryTables.json'))
  ) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    servers.push(
      new api.McpStdioServerDefinition(
        MCP_SERVERS.registry,
        process.execPath,
        [registryScript],
        {
          // execPath is the editor binary. This makes it run the script as Node.
          ELECTRON_RUN_AS_NODE: '1',
          MCP_USAGE_LOG_PATH: path.join(HELPERS_HOME, 'mcp-usage.log'),
          REGISTRY_DATA_DIR: registryData,
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
        },
        version
      )
    );
  }

  const instanceScript = path.join(dist, 'instanceMcp.js');
  const sncPath = cfg.get<string>('snc.path', 'snc') || 'snc';
  if (
    cfg.get<boolean>('mcp.instance', true) &&
    fs.existsSync(instanceScript) &&
    (await sncCliExists(sncPath))
  ) {
    const allowlist = JSON.stringify(
      (cfg.get<string[]>('snc.mcpProfiles', []) || [])
        .map((name) => name.trim())
        .filter(Boolean)
    );
    servers.push(
      new api.McpStdioServerDefinition(
        MCP_SERVERS.liveInstance,
        process.execPath,
        [instanceScript],
        {
          ELECTRON_RUN_AS_NODE: '1',
          MCP_USAGE_LOG_PATH: path.join(HELPERS_HOME, 'mcp-usage.log'),
          SNC_PATH: sncPath,
          SNC_PROFILE_ALLOWLIST: allowlist
        },
        version
      )
    );
  }

  return servers;
}

/**
 * Extension version stamped on MCP definitions so an upgrade can refresh tool lists.
 */
function extensionVersion(context: vscode.ExtensionContext): string {
  const version = context.extension.packageJSON.version;
  return typeof version === 'string' && version ? version : '0.0.0';
}
