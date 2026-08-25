/** Workspace-state key for the persisted Records navigator catalog. */
export const CATALOG_CACHE_STATE_KEY = 'servicenowXml.navigator.catalogCache';

const CATALOG_CACHE_VERSION = 1;

/** Record metadata persisted between extension-host sessions. */
export interface PersistedCatalogRecord {
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

/** Versioned catalog snapshot scoped to one workspace and indexing configuration. */
export interface PersistedCatalog {
  version: number;
  workspaceKey: string;
  configKey: string;
  records: PersistedCatalogRecord[];
}

/**
 * Build a versioned snapshot suitable for VS Code workspaceState.
 */
export function createCatalogCache(
  workspaceKey: string,
  configKey: string,
  records: PersistedCatalogRecord[]
): PersistedCatalog {
  return {
    version: CATALOG_CACHE_VERSION,
    workspaceKey,
    configKey,
    records
  };
}

/**
 * Return records from a compatible snapshot, or undefined for stale/malformed data.
 */
export function readCatalogCache(
  value: unknown,
  workspaceKey: string,
  configKey: string
): PersistedCatalogRecord[] | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const cache = value as Partial<PersistedCatalog>;
  if (
    cache.version !== CATALOG_CACHE_VERSION ||
    cache.workspaceKey !== workspaceKey ||
    cache.configKey !== configKey ||
    !Array.isArray(cache.records)
  ) {
    return undefined;
  }
  if (!cache.records.every(isPersistedCatalogRecord)) {
    return undefined;
  }
  return cache.records;
}

/**
 * Validate one persisted row before it can reach the tree or URI parser.
 */
function isPersistedCatalogRecord(value: unknown): value is PersistedCatalogRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Partial<PersistedCatalogRecord>;
  return (
    typeof record.table === 'string' &&
    typeof record.displayName === 'string' &&
    optionalString(record.sysId) &&
    optionalString(record.action) &&
    optionalString(record.apiName) &&
    optionalFiniteNumber(record.sysModCount) &&
    typeof record.startOffset === 'number' &&
    Number.isFinite(record.startOffset) &&
    record.startOffset >= 0 &&
    optionalFiniteNumber(record.mtimeMs) &&
    typeof record.uri === 'string' &&
    record.uri.length > 0 &&
    typeof record.relativePath === 'string'
  );
}

/** Whether a cache field is absent or a string. */
function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

/** Whether a cache field is absent or a finite number. */
function optionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}
