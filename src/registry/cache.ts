/**
 * Workspace-folder Registry cache (JSON file, not vscode.Memento).
 * Rich enough for agent discovery / future MCP tools.
 */

import type { RegistryFileSystem } from './host';
import type {
  RecordSymbol,
  ScriptIncludeSymbol,
  UiScriptSymbol
} from './types';

export const REGISTRY_CACHE_VERSION = 2;
export const REGISTRY_CACHE_DIR = '.servicenow-xml';
export const REGISTRY_CACHE_FILE = 'registry-cache.json';

/** One workspace record row in the on-disk cache. */
export interface CachedRecord {
  table: string;
  displayName: string;
  sysId?: string;
  action?: string;
  apiName?: string;
  sysModCount?: number;
  startOffset: number;
  mtimeMs?: number;
  uri: string;
  relativePath: string;
}

/** Declaration script in the on-disk cache. */
export interface CachedDeclaration {
  table:
    | 'sys_script_include'
    | 'sys_ui_script'
    | 'sys_ux_client_script_include';
  profile: 'server' | 'client';
  scope: string;
  name: string;
  uri: string;
  relativePath?: string;
  sysId?: string;
}

/** Workspace app metadata for agent discovery (from sys_app / gate). */
export interface CachedApp {
  sysId?: string;
  scope?: string;
  /** Normalized lint target: ES5 or ES12. */
  jsLevel?: string;
  /** True when scoped app is on es_latest (ES12). */
  supportsES12?: boolean;
}

/** Versioned workspace snapshot for extension + MCP. */
export interface RegistryCacheFile {
  version: number;
  workspaceKey: string;
  configKey: string;
  updatedAt: number;
  records: CachedRecord[];
  declarations: CachedDeclaration[];
  app?: CachedApp;
}

/**
 * Absolute path to the cache file under a workspace root.
 */
export function registryCachePath(workspaceRoot: string): string {
  const sep = workspaceRoot.includes('\\') ? '\\' : '/';
  return `${workspaceRoot.replace(/[\\/]+$/, '')}${sep}${REGISTRY_CACHE_DIR}${sep}${REGISTRY_CACHE_FILE}`;
}

/**
 * Build a cache document from live workspace symbols.
 */
export function createRegistryCache(options: {
  workspaceKey: string;
  configKey: string;
  updatedAt: number;
  records: CachedRecord[];
  declarations: CachedDeclaration[];
  app?: CachedApp;
}): RegistryCacheFile {
  return {
    version: REGISTRY_CACHE_VERSION,
    workspaceKey: options.workspaceKey,
    configKey: options.configKey,
    updatedAt: options.updatedAt,
    records: options.records,
    declarations: options.declarations,
    ...(options.app ? { app: options.app } : {})
  };
}

/**
 * Validate and return a cache file, or undefined if incompatible.
 */
export function readRegistryCache(
  value: unknown,
  workspaceKey: string,
  configKey: string
): RegistryCacheFile | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const cache = value as Partial<RegistryCacheFile>;
  if (
    cache.version !== REGISTRY_CACHE_VERSION ||
    cache.workspaceKey !== workspaceKey ||
    cache.configKey !== configKey ||
    !Array.isArray(cache.records) ||
    !Array.isArray(cache.declarations)
  ) {
    return undefined;
  }
  return cache as RegistryCacheFile;
}

/**
 * Load cache JSON from disk.
 */
export async function loadRegistryCacheFile(
  fs: RegistryFileSystem,
  path: string,
  workspaceKey: string,
  configKey: string
): Promise<RegistryCacheFile | undefined> {
  if (!(await fs.exists(path))) {
    return undefined;
  }
  try {
    const text = await fs.readFile(path, 'utf8');
    return readRegistryCache(JSON.parse(text), workspaceKey, configKey);
  } catch {
    return undefined;
  }
}

/**
 * Persist cache JSON to disk (creates `.servicenow-xml` as needed).
 */
export async function saveRegistryCacheFile(
  fs: RegistryFileSystem,
  path: string,
  cache: RegistryCacheFile
): Promise<void> {
  const dir = path.replace(/[\\/][^\\/]+$/, '');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path, JSON.stringify(cache), 'utf8');
}

/**
 * Project cache rows into Registry record symbols.
 */
export function cachedRecordsToSymbols(records: CachedRecord[]): RecordSymbol[] {
  return records.map((record) => ({
    kind: 'Record' as const,
    name: record.displayName,
    table: record.table,
    displayName: record.displayName,
    sysId: record.sysId,
    action: record.action,
    apiName: record.apiName,
    sysModCount: record.sysModCount,
    startOffset: record.startOffset,
    mtimeMs: record.mtimeMs,
    uri: record.uri,
    relativePath: record.relativePath,
    scope: undefined
  }));
}

/**
 * Project cache declarations into Registry script symbols.
 */
export function cachedDeclarationsToSymbols(
  declarations: CachedDeclaration[]
): Array<ScriptIncludeSymbol | UiScriptSymbol> {
  return declarations.map((declaration) => {
    if (declaration.table === 'sys_script_include') {
      return {
        kind: 'ScriptInclude' as const,
        name: declaration.name,
        table: 'sys_script_include' as const,
        profile: declaration.profile,
        scope: declaration.scope,
        uri: declaration.uri,
        relativePath: declaration.relativePath,
        sysId: declaration.sysId,
        fromWorkspace: true
      };
    }
    return {
      kind: 'UiScript' as const,
      name: declaration.name,
      table: declaration.table,
      profile: 'client' as const,
      scope: declaration.scope,
      uri: declaration.uri,
      relativePath: declaration.relativePath,
      sysId: declaration.sysId,
      fromWorkspace: true
    };
  });
}
