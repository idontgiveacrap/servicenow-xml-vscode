import type { ScriptDeclaration } from './scriptDeclarations';

/** Workspace-state key for the persisted declaration index. */
export const DECLARATION_CACHE_STATE_KEY =
  'servicenowXml.scriptDeclarations.cache';

const DECLARATION_CACHE_VERSION = 1;

/** One indexed declaration plus the export URI it came from. */
export interface PersistedScriptDeclaration extends ScriptDeclaration {
  uri: string;
}

/** Versioned declaration snapshot scoped to one workspace and ignore config. */
export interface PersistedDeclarationCache {
  version: number;
  workspaceKey: string;
  configKey: string;
  declarations: PersistedScriptDeclaration[];
}

/**
 * Build a versioned snapshot suitable for VS Code workspaceState.
 */
export function createDeclarationCache(
  workspaceKey: string,
  configKey: string,
  declarations: PersistedScriptDeclaration[]
): PersistedDeclarationCache {
  return {
    version: DECLARATION_CACHE_VERSION,
    workspaceKey,
    configKey,
    declarations
  };
}

/**
 * Return declarations from a compatible snapshot, or undefined for stale data.
 */
export function readDeclarationCache(
  value: unknown,
  workspaceKey: string,
  configKey: string
): PersistedScriptDeclaration[] | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const cache = value as Partial<PersistedDeclarationCache>;
  if (
    cache.version !== DECLARATION_CACHE_VERSION ||
    cache.workspaceKey !== workspaceKey ||
    cache.configKey !== configKey ||
    !Array.isArray(cache.declarations)
  ) {
    return undefined;
  }
  if (!cache.declarations.every(isPersistedDeclaration)) {
    return undefined;
  }
  return cache.declarations;
}

/**
 * Validate one persisted declaration before it can reach the linter.
 */
function isPersistedDeclaration(
  value: unknown
): value is PersistedScriptDeclaration {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Partial<PersistedScriptDeclaration>;
  return (
    (record.table === 'sys_script_include' ||
      record.table === 'sys_ui_script' ||
      record.table === 'sys_ux_client_script_include') &&
    (record.profile === 'server' || record.profile === 'client') &&
    typeof record.scope === 'string' &&
    record.scope.length > 0 &&
    typeof record.name === 'string' &&
    record.name.length > 0 &&
    typeof record.uri === 'string' &&
    record.uri.length > 0
  );
}
