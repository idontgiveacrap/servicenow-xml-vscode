/**
 * Load and refresh the workspace snapshot inside the Registry MCP process.
 * The platform dictionary pack stays loaded across reloads.
 */

import * as fs from 'fs';
import type {
  CachedApp,
  CachedDeclaration,
  CachedDependency,
  CachedRecord,
  CachedReference,
  CachedSchemaField
} from './cache';
import {
  cachedDeclarationsToSymbols,
  cachedRecordsToSymbols,
  computeDuplicateSysIds,
  readRegistryCache,
  registryCachePath
} from './cache';
import { mergeDependencyEdges } from './dependencies';
import { Registry } from './Registry';

/** Workspace slice the MCP tools read. Replaced when the cache file changes. */
export interface McpWorkspaceState {
  app?: CachedApp;
  duplicateSysIds: Array<{ sysId: string; table: string; count: number }>;
  cacheMtimeMs: number;
}

/**
 * Cache path from REGISTRY_CACHE_PATH or REGISTRY_WORKSPACE. Undefined when the file is absent.
 */
export function resolveWorkspaceCachePath(): string | undefined {
  if (process.env.REGISTRY_CACHE_PATH) {
    return fs.existsSync(process.env.REGISTRY_CACHE_PATH)
      ? process.env.REGISTRY_CACHE_PATH
      : undefined;
  }
  const workspace = process.env.REGISTRY_WORKSPACE || process.cwd();
  const candidate = registryCachePath(workspace);
  return fs.existsSync(candidate) ? candidate : undefined;
}

/**
 * Reload records, schema, references, and dependencies when the cache mtime changes.
 * Returns true when a new snapshot was applied.
 */
export function syncWorkspaceCache(
  registry: Registry,
  state: McpWorkspaceState
): boolean {
  const cachePath = resolveWorkspaceCachePath();
  if (!cachePath) {
    return false;
  }
  let mtime = 0;
  try {
    mtime = fs.statSync(cachePath).mtimeMs;
  } catch {
    return false;
  }
  if (mtime === state.cacheMtimeMs) {
    return false;
  }
  const loaded = loadWorkspaceSnapshot(registry, cachePath);
  if (!loaded) {
    return false;
  }
  state.app = loaded.app;
  state.duplicateSysIds = loaded.duplicateSysIds;
  state.cacheMtimeMs = mtime;
  return true;
}

/**
 * Replace workspace symbols from one cache file.
 * Duplicate sys_ids are recomputed from active rows, matching the extension.
 */
export function loadWorkspaceSnapshot(
  registry: Registry,
  cachePath: string
): { app?: CachedApp; duplicateSysIds: McpWorkspaceState['duplicateSysIds'] } | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    console.error('[registry-mcp] cache load failed:', error);
    return undefined;
  }
  const cache = readRegistryCache(
    parsed,
    typeof parsed.workspaceKey === 'string' ? parsed.workspaceKey : '',
    typeof parsed.configKey === 'string' ? parsed.configKey : ''
  );
  if (!cache) {
    console.error('[registry-mcp] cache is incompatible');
    return undefined;
  }
  const records = asRecords(cache.records);
  if (!records) {
    console.error('[registry-mcp] cache has no records array');
    return undefined;
  }
  const declarations = asArray<CachedDeclaration>(cache.declarations);
  const schemaFields = asArray<CachedSchemaField>(cache.schemaFields) ?? [];
  const references = asArray<CachedReference>(cache.references) ?? [];
  const dependencies = asArray<CachedDependency>(cache.dependencies);
  const app = cache.app;

  registry.clearWorkspaceSymbols();
  registry.upsertMany(cachedRecordsToSymbols(records));
  if (declarations) {
    registry.upsertMany(cachedDeclarationsToSymbols(declarations));
  }
  registry.setProjectOverlay(schemaFields, references);
  registry.setDependencyEdges(mergeDependencyEdges(dependencies, schemaFields));
  return {
    app,
    duplicateSysIds: computeDuplicateSysIds(records)
  };
}

function asRecords(value: unknown): CachedRecord[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value as CachedRecord[];
}

function asArray<T>(value: unknown): T[] | undefined {
  return Array.isArray(value) ? (value as T[]) : undefined;
}
