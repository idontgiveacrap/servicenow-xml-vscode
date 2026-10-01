/**
 * Node MCP server backed by the shared Registry (schema, APIs, scripting, workspace).
 * Stdio transport — no network listeners. No external MCP SDK dependency.
 *
 * Env:
 *   REGISTRY_DATA_DIR — directory with dictionary + static packs + scripting packs
 *   REGISTRY_CACHE_PATH — optional path to registry-cache.json
 *   REGISTRY_WORKSPACE — optional workspace root (searches for cache under it)
 */

import * as fs from 'fs';
import * as path from 'path';
import { Registry } from './Registry';
import {
  CachedApp,
  cachedDeclarationsToSymbols,
  cachedRecordsToSymbols,
  readRegistryCache,
  registryCachePath
} from './cache';
import { runMcpStdio } from './mcpStdio';
import {
  DictionaryFieldIndex,
  loadDictionaryTables,
  mergeSchemaFields,
  schemaAssetPaths,
  searchMergedSchema
} from './schemaLoader';
import { referenceTargetIndex } from './xmlReferences';
import {
  loadStaticPacks,
  PlatformGlobalsPack
} from './staticLoader';
import {
  loadScriptingKnowledge,
  scriptingLookupFromRegistry,
  ScriptingKnowledge
} from './scriptingKnowledge';
import type { ScriptIncludeWhitelist, ScopeList } from '../scriptDeclarations';

function dataDir(): string {
  if (process.env.REGISTRY_DATA_DIR) {
    return process.env.REGISTRY_DATA_DIR;
  }
  const nextToBundle = path.join(__dirname, 'data');
  if (fs.existsSync(path.join(nextToBundle, 'dictionaryTables.json'))) {
    return nextToBundle;
  }
  return path.join(__dirname, '..', 'src', 'data');
}

function resolveCachePath(): string | undefined {
  if (process.env.REGISTRY_CACHE_PATH) {
    return fs.existsSync(process.env.REGISTRY_CACHE_PATH)
      ? process.env.REGISTRY_CACHE_PATH
      : undefined;
  }
  const workspace = process.env.REGISTRY_WORKSPACE || process.cwd();
  const candidate = registryCachePath(workspace);
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  return undefined;
}

function loadJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function bootRegistry(): {
  registry: Registry;
  fieldIndex: DictionaryFieldIndex;
  scripting: ScriptingKnowledge;
  app?: CachedApp;
} {
  const registry = new Registry();
  const dir = dataDir();
  const paths = schemaAssetPaths(dir);

  loadStaticPacks(registry, {
    scriptIncludes: loadJson<ScriptIncludeWhitelist>(
      path.join(dir, 'scriptIncludes.json')
    ),
    scopes: loadJson<ScopeList>(path.join(dir, 'scopes.json')),
    platformGlobals: loadJson<PlatformGlobalsPack>(
      path.join(dir, 'platformGlobals.json')
    )
  });
  loadDictionaryTables(registry, paths.tables);
  const fieldIndex = new DictionaryFieldIndex(registry, paths.fieldsGz);
  const scripting = loadScriptingKnowledge(dir, registry);

  let app: CachedApp | undefined;
  const cachePath = resolveCachePath();
  if (cachePath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      const cache = readRegistryCache(
        parsed,
        parsed.workspaceKey ?? '',
        parsed.configKey ?? ''
      );
      const records = cache?.records ?? parsed.records ?? [];
      const declarations = cache?.declarations ?? parsed.declarations ?? [];
      app = cache?.app ?? parsed.app;
      if (Array.isArray(records)) {
        registry.upsertMany(cachedRecordsToSymbols(records));
      }
      if (Array.isArray(declarations)) {
        registry.upsertMany(cachedDeclarationsToSymbols(declarations));
      }
      const schemaFields = cache?.schemaFields ?? parsed.schemaFields ?? [];
      const references = cache?.references ?? parsed.references ?? [];
      if (Array.isArray(schemaFields) || Array.isArray(references)) {
        registry.setProjectOverlay(
          Array.isArray(schemaFields) ? schemaFields : [],
          Array.isArray(references) ? references : []
        );
      }
      if (!app) {
        app = appFromSysAppRecords(registry);
      }
    } catch (error) {
      console.error('[registry-mcp] cache load failed:', error);
    }
  }

  return { registry, fieldIndex, scripting, app };
}

function appFromSysAppRecords(registry: Registry): CachedApp | undefined {
  const apps = registry.listRecords().filter((r) => r.table === 'sys_app');
  if (apps.length === 0) {
    return undefined;
  }
  const row = apps[0];
  return {
    sysId: row.sysId,
    scope: row.apiName?.includes('.')
      ? row.apiName.slice(0, row.apiName.indexOf('.'))
      : undefined
  };
}

function dispatch(
  name: string,
  args: Record<string, unknown>,
  registry: Registry,
  fieldIndex: DictionaryFieldIndex,
  scripting: ScriptingKnowledge,
  app: CachedApp | undefined
): unknown {
  const limit = Math.min(Number(args.limit) || 50, 100);
  switch (name) {
    case 'list_tables': {
      const q = String(args.query ?? '')
        .toLowerCase()
        .trim();
      let tables = registry.listTables();
      if (q) {
        tables = tables.filter(
          (t) =>
            t.name.toLowerCase().includes(q) ||
            (t.label ?? '').toLowerCase().includes(q)
        );
      }
      return {
        tables: tables.slice(0, limit).map((t) => ({
          name: t.name,
          label: t.label
        })),
        total: tables.length
      };
    }
    case 'get_table':
    case 'list_columns': {
      const table = String(args.table ?? '');
      const info = registry.getTable(table);
      const fields = mergeSchemaFields(
        fieldIndex.fieldsFor(table),
        registry.listProjectFields(table)
      );
      return {
        table,
        label: registry.projectTableLabel(table) ?? info?.label,
        known: !!(info || fields.length || fieldIndex.hasTable(table)),
        fields
      };
    }
    case 'search_schema': {
      const q = String(args.query ?? '')
        .toLowerCase()
        .trim();
      const matches: unknown[] = [];
      if (q) {
        for (const table of registry.listTables()) {
          if (matches.length >= limit) {
            break;
          }
          if (
            table.name.toLowerCase().includes(q) ||
            (table.label ?? '').toLowerCase().includes(q)
          ) {
            matches.push({
              match: 'table',
              table: table.name,
              name: table.name,
              label: table.label
            });
          }
        }
      }
      if (matches.length < limit && q) {
        for (const field of searchMergedSchema(
          fieldIndex.searchFields(q, limit),
          registry.listProjectFields(),
          q,
          limit - matches.length
        )) {
          matches.push({ match: 'field', ...field });
        }
      }
      return { matches };
    }
    case 'references_to':
    case 'references_from': {
      const sysId = String(args.sys_id ?? '').toLowerCase();
      const records = registry.listRecords();
      const targetState = referenceTargetIndex(records);
      const edges = registry.listReferenceEdges().filter((edge) =>
        name === 'references_to'
          ? edge.toSysId === sysId
          : (edge.fromSysId ?? '').toLowerCase() === sysId
      );
      return {
        sys_id: sysId,
        total: edges.length,
        references: edges.slice(0, limit).map((edge) => ({
          ...edge,
          targetState: targetState(edge.toSysId)
        }))
      };
    }
    case 'list_reference_issues': {
      const includeNotInProject = args.includeNotInProject === true;
      const targetState = referenceTargetIndex(registry.listRecords());
      const issues: unknown[] = [];
      let matched = 0;
      for (const edge of registry.listReferenceEdges()) {
        const state = targetState(edge.toSysId);
        const include =
          state === 'deleted' || (includeNotInProject && state === 'not_in_project');
        if (!include) {
          continue;
        }
        matched += 1;
        if (issues.length < limit) {
          issues.push({
            ...edge,
            targetState: state,
            severity: state === 'deleted' ? 'error' : 'info'
          });
        }
      }
      return { issues, total: matched };
    }
    case 'lookup_platform_api': {
      const apiName = String(args.name ?? '');
      return {
        matches: registry
          .lookup(apiName)
          .filter((s) => s.kind === 'PlatformApi' || s.kind === 'Global')
      };
    }
    case 'search_records': {
      const q = String(args.query ?? '')
        .toLowerCase()
        .trim();
      const tableFilter = args.table ? String(args.table) : undefined;
      let records = registry.listRecords();
      if (tableFilter) {
        records = records.filter((r) => r.table === tableFilter);
      }
      if (q) {
        records = records.filter(
          (r) =>
            r.displayName.toLowerCase().includes(q) ||
            r.table.toLowerCase().includes(q) ||
            (r.sysId ?? '').includes(q) ||
            (r.apiName ?? '').toLowerCase().includes(q) ||
            (r.relativePath ?? '').toLowerCase().includes(q)
        );
      }
      return {
        records: records.slice(0, limit).map((r) => ({
          table: r.table,
          displayName: r.displayName,
          sysId: r.sysId,
          action: r.action,
          apiName: r.apiName,
          uri: r.uri,
          relativePath: r.relativePath
        })),
        total: records.length
      };
    }
    case 'lookup_by_name': {
      const q = String(args.name ?? args.query ?? '')
        .toLowerCase()
        .trim();
      if (!q) {
        throw new Error('name is required');
      }
      const records = registry.listRecords().filter(
        (r) =>
          r.displayName.toLowerCase() === q ||
          (r.apiName ?? '').toLowerCase() === q ||
          (r.apiName ?? '').toLowerCase().endsWith(`.${q}`)
      );
      const decls = registry.listWorkspaceDeclarations().filter(
        (d) => d.name.toLowerCase() === q
      );
      return {
        query: args.name ?? args.query,
        records: records.slice(0, limit),
        declarations: decls.slice(0, limit)
      };
    }
    case 'lookup_script_include': {
      const siName = String(args.name ?? '');
      const scope = args.scope ? String(args.scope) : undefined;
      const matches = registry.lookup(siName).filter((s) => {
        if (s.kind !== 'ScriptInclude' && s.kind !== 'UiScript') {
          return false;
        }
        if (scope && s.scope !== scope) {
          return false;
        }
        return true;
      });
      return { matches };
    }
    case 'get_workspace_app':
      return { app: app ?? null, source: app ? 'registry-cache' : 'none' };
    case 'registry_diagnostics_context':
      return { ...registry.getDiagnosticsContext(), app: app ?? null };
    case 'get_scripting_meta':
      return scripting.getMeta();
    case 'list_scripting_sections':
      return { sections: scripting.listSections() };
    case 'get_scripting_section':
      return {
        section: args.section,
        data: scripting.getSection(String(args.section ?? ''))
      };
    case 'lookup_scripting_name': {
      const meta = scripting.getMeta() as { available?: boolean };
      if (!meta.available) {
        throw new Error('scripting_reference pack not loaded');
      }
      return scriptingLookupFromRegistry(registry, String(args.name ?? ''));
    }
    case 'search_scripting_reference':
      return {
        matches: scripting.search(
          String(args.query ?? ''),
          args.section ? String(args.section) : undefined,
          limit
        )
      };
    case 'list_runtime_items':
      return { data: scripting.getSection('runtime_items') };
    case 'get_js_performance_meta':
      return scripting.performanceMeta();
    case 'lookup_js_performance':
      return {
        matches: scripting.performanceLookup(String(args.construct ?? args.name ?? ''))
      };
    case 'search_js_performance':
      return {
        matches: scripting.performanceSearch({
          query: args.query ? String(args.query) : '',
          javascriptSupport: args.javascript_support
            ? String(args.javascript_support)
            : args.javascriptSupport
              ? String(args.javascriptSupport)
              : '',
          runtime: args.runtime ? String(args.runtime) : '',
          maxMatches: limit
        })
      };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const { registry, fieldIndex, scripting, app } = bootRegistry();

const tools = [
  {
    name: 'list_tables',
    description:
      'List tables from the platform dictionary and project dictionary exports, as one set.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number' } }
    }
  },
  {
    name: 'get_table',
    description:
      'Get one table and its fields (name, label, type, reference, source). Project columns override the platform pack.',
    inputSchema: {
      type: 'object',
      properties: { table: { type: 'string' } },
      required: ['table']
    }
  },
  {
    name: 'list_columns',
    description:
      'List fields for one table (name, label, type, reference, source) from the combined dictionary.',
    inputSchema: {
      type: 'object',
      properties: { table: { type: 'string' } },
      required: ['table']
    }
  },
  {
    name: 'search_schema',
    description:
      'Search the combined platform and project dictionary by name, label, type, or reference.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number' } },
      required: ['query']
    }
  },
  {
    name: 'lookup_platform_api',
    description: 'Lookup a platform global / API name from the Registry.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name']
    }
  },
  {
    name: 'search_records',
    description:
      'Search workspace export records from the Registry cache (agent discovery).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        table: { type: 'string' },
        limit: { type: 'number' }
      }
    }
  },
  {
    name: 'lookup_by_name',
    description:
      'Exact name / api_name lookup for workspace records and script declarations.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, limit: { type: 'number' } },
      required: ['name']
    }
  },
  {
    name: 'lookup_script_include',
    description: 'Lookup Script Include / UI Script declarations (bundled + workspace).',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, scope: { type: 'string' } },
      required: ['name']
    }
  },
  {
    name: 'references_to',
    description:
      'Incoming sys_id references for one record. Each edge includes targetState: in_project, deleted, or not_in_project.',
    inputSchema: {
      type: 'object',
      properties: { sys_id: { type: 'string' }, limit: { type: 'number' } },
      required: ['sys_id']
    }
  },
  {
    name: 'references_from',
    description:
      'Outgoing sys_id references from one record. Each edge includes targetState.',
    inputSchema: {
      type: 'object',
      properties: { sys_id: { type: 'string' }, limit: { type: 'number' } },
      required: ['sys_id']
    }
  },
  {
    name: 'list_reference_issues',
    description:
      'Reference findings an agent can query. Default is deleted targets (editor errors). Set includeNotInProject to also list ids absent from the export; those are not editor diagnostics.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number' },
        includeNotInProject: { type: 'boolean' }
      }
    }
  },
  {
    name: 'get_workspace_app',
    description:
      'Workspace sys_app metadata from Registry cache (scope, jsLevel, supportsES12, restrictTableAccess).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'registry_diagnostics_context',
    description: 'Counts of symbols loaded in the Registry plus workspace app.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_scripting_meta',
    description: 'Metadata for the bundled ServiceNow scripting reference pack.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_scripting_sections',
    description: 'List scripting reference section keys.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_scripting_section',
    description: 'Get one scripting reference section by key.',
    inputSchema: {
      type: 'object',
      properties: { section: { type: 'string' } },
      required: ['section']
    }
  },
  {
    name: 'lookup_scripting_name',
    description:
      'Lookup a name on Registry platform symbols that carry scripting-reference doc payloads.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name']
    }
  },
  {
    name: 'search_scripting_reference',
    description: 'Substring search across scripting reference sections.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        section: { type: 'string' },
        limit: { type: 'number' }
      },
      required: ['query']
    }
  },
  {
    name: 'list_runtime_items',
    description: 'List runtime_items from the scripting reference pack.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_js_performance_meta',
    description: 'JavaScript performance dataset scope and methodology.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'lookup_js_performance',
    description: 'Exact lookup of a JS performance comparison by id/alias/label.',
    inputSchema: {
      type: 'object',
      properties: { construct: { type: 'string' }, name: { type: 'string' } }
    }
  },
  {
    name: 'search_js_performance',
    description: 'Search JS performance comparisons (scoped es_latest server evidence).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        javascript_support: { type: 'string' },
        runtime: { type: 'string' },
        limit: { type: 'number' }
      }
    }
  }
];

runMcpStdio({
  name: 'servicenow-xml-registry',
  version: '1.0.0',
  tools,
  callTool: async (name, args) =>
    dispatch(name, args, registry, fieldIndex, scripting, app)
});
