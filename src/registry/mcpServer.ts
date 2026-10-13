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
import { CachedApp } from './cache';
import { runMcpStdio } from './mcpStdio';
import { queryDependencies } from './dependencies';
import { outlineScriptMethods, methodSourceExcerpt } from './lazyParse';
import {
  aggregateRecords,
  pickCanonicalRecord,
  readExportRecord,
  workspaceFilePath
} from './recordDetail';
import {
  McpWorkspaceState,
  syncWorkspaceCache
} from './workspaceCache';
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

function loadJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function bootRegistry(): {
  registry: Registry;
  fieldIndex: DictionaryFieldIndex;
  scripting: ScriptingKnowledge;
  workspace: McpWorkspaceState;
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
  const workspace: McpWorkspaceState = { duplicateSysIds: [], cacheMtimeMs: 0 };
  syncWorkspaceCache(registry, workspace);
  if (!workspace.app) {
    workspace.app = appFromSysAppRecords(registry);
  }
  return { registry, fieldIndex, scripting, workspace };
}

/**
 * Script body from a workspace Script Include or UI Script export.
 */
function scriptBodyForSymbol(symbol: {
  uri?: string;
  relativePath?: string;
}): string {
  const filePath = workspaceFilePath(symbol);
  if (!filePath || !fs.existsSync(filePath)) {
    return '';
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const match =
    /<(?:script|client_script)[^>]*>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/(?:script|client_script)>/i.exec(
      text
    );
  return match?.[1] ?? match?.[2] ?? '';
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
  workspace: McpWorkspaceState
): unknown {
  const app = workspace.app;
  const duplicateSysIds = workspace.duplicateSysIds;
  const limit = Math.min(Number(args.limit) || 50, 100);
  switch (name) {
    case 'list_tables': {
      const q = String(args.query ?? '')
        .toLowerCase()
        .trim();
      const source = args.source ? String(args.source) : '';
      let tables = registry.listTables();
      if (source === 'project' || source === 'platform') {
        tables = tables.filter((table) =>
          source === 'project' ? table.fromWorkspace : !table.fromWorkspace
        );
      }
      if (q) {
        tables = tables.filter(
          (t) =>
            t.name.toLowerCase().includes(q) ||
            (t.label ?? '').toLowerCase().includes(q)
        );
      }
      tables.sort((a, b) => {
        const rank = (table: { fromWorkspace?: boolean }) =>
          table.fromWorkspace ? 0 : 1;
        const bySource = rank(a) - rank(b);
        return bySource || a.name.localeCompare(b.name);
      });
      return {
        tables: tables.slice(0, limit).map((t) => ({
          name: t.name,
          label: t.label,
          source: t.fromWorkspace ? 'project' : 'platform'
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
      const parent = registry.projectTableExtends(table);
      return {
        table,
        label: registry.projectTableLabel(table) ?? info?.label,
        known: !!(info || fields.length || fieldIndex.hasTable(table)),
        ...(parent ? { extends: parent } : {}),
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
    case 'list_diagnostics': {
      const ctx = registry.getDiagnosticsContext();
      const targetState = referenceTargetIndex(registry.listRecords());
      const refEdgeCount = registry.listReferenceEdges().filter(
        (e) => targetState(e.toSysId) === 'deleted'
      ).length;
      return {
        counts: ctx,
        duplicateSysIds: duplicateSysIds.slice(0, limit),
        duplicateSysIdCount: duplicateSysIds.length,
        referenceIssuesCount: refEdgeCount
      };
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
      if (args.aggregate === true) {
        return { aggregate: true, ...aggregateRecords(records) };
      }
      // Sort by sys_updated_on descending so the canonical (latest) source appears first.
      const sorted = [...records].sort((a, b) => {
        const ta = a.sysUpdatedOn ?? '';
        const tb = b.sysUpdatedOn ?? '';
        return tb < ta ? -1 : tb > ta ? 1 : 0;
      });
      return {
        records: sorted.slice(0, limit).map((r) => ({
          table: r.table,
          displayName: r.displayName,
          sysId: r.sysId,
          action: r.action,
          apiName: r.apiName,
          sysUpdatedOn: r.sysUpdatedOn,
          uri: r.uri,
          relativePath: r.relativePath
        })),
        total: sorted.length
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
      const sortedRecords = [...records].sort((a, b) => {
        const ta = a.sysUpdatedOn ?? '';
        const tb = b.sysUpdatedOn ?? '';
        return tb < ta ? -1 : tb > ta ? 1 : 0;
      });
      return {
        query: args.name ?? args.query,
        records: sortedRecords.slice(0, limit),
        declarations: decls.slice(0, limit)
      };
    }
    case 'lookup_script_include': {
      const siName = String(args.name ?? '');
      const scope = args.scope ? String(args.scope) : undefined;
      const includeOutline = args.includeOutline === true;
      const method = args.method ? String(args.method) : '';
      const matches = registry.lookup(siName).filter((s) => {
        if (s.kind !== 'ScriptInclude' && s.kind !== 'UiScript') {
          return false;
        }
        if (scope && s.scope !== scope) {
          return false;
        }
        return true;
      });
      if (!includeOutline && !method) {
        return { matches };
      }
      return {
        matches: matches.map((symbol) => {
          const script = scriptBodyForSymbol(symbol);
          const outlined =
            script && (includeOutline || method)
              ? outlineScriptMethods(script)
              : [];
          const excerpt = script && method ? methodSourceExcerpt(script, method) : undefined;
          return {
            ...symbol,
            ...(includeOutline
              ? {
                  methods: outlined.map((item) => ({
                    name: item.name,
                    params: item.params,
                    line: item.line
                  }))
                }
              : {}),
            ...(method ? { excerpt: excerpt ?? null } : {})
          };
        })
      };
    }
    case 'get_record': {
      const record = pickCanonicalRecord(registry.listRecords(), {
        sysId: args.sys_id ? String(args.sys_id) : undefined,
        table: args.table ? String(args.table) : undefined,
        name: args.name ? String(args.name) : undefined
      });
      if (!record) {
        throw new Error('record not found');
      }
      const includeEmbedded = args.includeEmbedded === true;
      const duplicate = duplicateSysIds.find(
        (row) => row.sysId.toLowerCase() === (record.sysId ?? '').toLowerCase()
      );
      return {
        table: record.table,
        displayName: record.displayName,
        sysId: record.sysId,
        action: record.action,
        apiName: record.apiName,
        sysUpdatedOn: record.sysUpdatedOn,
        relativePath: record.relativePath,
        uri: record.uri,
        ...(duplicate && duplicate.count > 1 ? { duplicateCount: duplicate.count } : {}),
        fields: readExportRecord(record, includeEmbedded)
      };
    }
    case 'query_dependencies':
      return queryDependencies({
        kind: args.kind ? String(args.kind) : undefined,
        from: args.from ? String(args.from) : undefined,
        to: args.to ? String(args.to) : undefined,
        limit,
        references: registry.listReferenceEdges(),
        dependencies: registry.listDependencyEdges()
      });
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

const { registry, fieldIndex, scripting, workspace } = bootRegistry();

const tools = [
  {
    name: 'list_tables',
    description:
      'List tables from the platform dictionary and project dictionary exports, as one set. Project tables are first. Pass source "project" or "platform" to keep one side.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        source: { type: 'string', enum: ['project', 'platform'] },
        limit: { type: 'number' }
      }
    }
  },
  {
    name: 'get_table',
    description:
      'Get one table and its fields (name, label, type, reference, source). Project columns override the platform pack. extends is the parent table name when the export has one; call get_table on that name for inherited columns.',
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
      'Search workspace export records from the Registry cache (agent discovery). Results sorted by sysUpdatedOn descending so canonical sources appear first. aggregate:true returns counts by table and action instead of row bodies.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        table: { type: 'string' },
        limit: { type: 'number' },
        aggregate: { type: 'boolean' }
      }
    }
  },
  {
    name: 'lookup_by_name',
    description:
      'Exact name / api_name lookup for workspace records and script declarations. Records sorted by sysUpdatedOn descending so canonical sources appear first.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, limit: { type: 'number' } },
      required: ['name']
    }
  },
  {
    name: 'lookup_script_include',
    description:
      'Lookup Script Include / UI Script declarations (bundled + workspace). includeOutline adds method name, params, and line. method adds a capped source excerpt for that method.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        scope: { type: 'string' },
        includeOutline: { type: 'boolean' },
        method: { type: 'string' }
      },
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
      'Workspace sys_app metadata from Registry cache (scope, jsLevel, supportsES12, restrictTableAccess, version, shortDescription).',
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
  },
  {
    name: 'list_diagnostics',
    description:
      'Workspace diagnostic summary: symbol counts, duplicate sys_id count, and reference issue count. Duplicate sys_ids indicate multiple active rows for one sys_id; agents should use sys_updated_on to pick the canonical file. projectFieldCount is workspace dictionary columns; platform fields stay in the packed dictionary.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number' } }
    }
  },
  {
    name: 'get_record',
    description:
      'Parsed fields for one workspace export row (sys_id, or table plus exact name). Newest sysUpdatedOn wins when the sys_id is duplicated. Embedded script, JSON, XML, and CSS are lengths unless includeEmbedded is true, then a 2000-character excerpt. This is the export, not the live instance.',
    inputSchema: {
      type: 'object',
      properties: {
        sys_id: { type: 'string' },
        table: { type: 'string' },
        name: { type: 'string' },
        includeEmbedded: { type: 'boolean' }
      }
    }
  },
  {
    name: 'query_dependencies',
    description:
      'Filtered dependency edges. kind is sys_id_ref, calls, or extends. from and to match a sys_id, declaration name, or table name. Not a dump of the whole graph.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['sys_id_ref', 'calls', 'extends'] },
        from: { type: 'string' },
        to: { type: 'string' },
        limit: { type: 'number' }
      }
    }
  }
];

runMcpStdio({
  name: 'servicenow-xml-registry',
  version: '1.0.0',
  tools,
  callTool: async (name, args) => {
    syncWorkspaceCache(registry, workspace);
    if (!workspace.app) {
      workspace.app = appFromSysAppRecords(registry);
    }
    return dispatch(name, args, registry, fieldIndex, scripting, workspace);
  }
});
