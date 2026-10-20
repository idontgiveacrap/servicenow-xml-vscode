/**
 * Load and query scripting_reference.json.gz + js_performance.json for Registry MCP.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { Registry } from './Registry';
import type { PlatformApiSymbol, ScriptingDocSection } from './types';

const SECTION_KEYS = [
  'runtime_catalog',
  'runtime_items',
  'server',
  'useful_scripts',
  'undocumented',
  'ui_builder',
  'documentation_workflow',
  'reference_sources'
] as const;

type SectionKey = (typeof SECTION_KEYS)[number];

const SECTION_ALIASES: Record<string, SectionKey> = {
  catalog: 'runtime_catalog',
  runtime: 'runtime_items',
  items: 'runtime_items',
  scripts: 'useful_scripts',
  useful: 'useful_scripts',
  misc: 'undocumented',
  undocumented_apis: 'undocumented',
  uib: 'ui_builder',
  ui_builder_workspace: 'ui_builder',
  workflow: 'documentation_workflow',
  sources: 'reference_sources'
};

export interface ScriptingKnowledge {
  getMeta(): unknown;
  getSection(section: string): unknown;
  listSections(): string[];
  lookupName(name: string): unknown;
  search(query: string, section?: string, maxMatches?: number): unknown[];
  performanceMeta(): unknown;
  performanceLookup(construct: string): unknown[];
  performanceSearch(options: {
    query?: string;
    javascriptSupport?: string;
    runtime?: string;
    maxMatches?: number;
  }): unknown[];
}

/**
 * Load scripting + performance packs from a data directory (missing files → empty tools).
 */
export function loadScriptingKnowledge(
  dataDir: string,
  registry?: Registry
): ScriptingKnowledge {
  const scriptingPath = path.join(dataDir, 'scripting_reference.json.gz');
  const altScripting = path.join(dataDir, 'scripting_reference.json');
  const perfPath = path.join(dataDir, 'js_performance.json');

  let scripting: Record<string, unknown> | undefined;
  if (fs.existsSync(scriptingPath)) {
    scripting = JSON.parse(
      zlib.gunzipSync(fs.readFileSync(scriptingPath)).toString('utf8')
    ) as Record<string, unknown>;
  } else if (fs.existsSync(altScripting)) {
    scripting = JSON.parse(fs.readFileSync(altScripting, 'utf8')) as Record<
      string,
      unknown
    >;
  }

  let performance: Record<string, unknown> | undefined;
  let comparisons: Array<Record<string, unknown>> = [];
  if (fs.existsSync(perfPath)) {
    performance = JSON.parse(fs.readFileSync(perfPath, 'utf8')) as Record<
      string,
      unknown
    >;
    const list = performance.comparisons;
    if (Array.isArray(list)) {
      comparisons = list.filter(
        (row): row is Record<string, unknown> =>
          !!row && typeof row === 'object'
      );
    }
  }

  if (registry) {
    attachScriptingDocs(registry, scripting);
  }

  return {
    getMeta() {
      if (!scripting) {
        return { available: false };
      }
      return {
        available: true,
        title: scripting.title,
        subtitle: scripting.subtitle,
        version: scripting.version,
        format: scripting.format,
        source_workbook: scripting.source_workbook,
        warnings: scripting.warnings ?? [],
        counts: scripting.counts ?? {},
        sections: [...SECTION_KEYS]
      };
    },
    listSections() {
      return [...SECTION_KEYS];
    },
    getSection(section: string) {
      if (!scripting) {
        throw new Error('scripting_reference pack not loaded');
      }
      const key = resolveSection(section);
      return scripting[key];
    },
    lookupName(name: string) {
      if (!scripting) {
        throw new Error('scripting_reference pack not loaded');
      }
      const needle = name.trim().toLowerCase();
      if (!needle) {
        throw new Error('name is required');
      }
      const hits: Record<string, unknown> = {
        query: name,
        server: null,
        runtime_item: null,
        undocumented: [] as unknown[]
      };
      for (const row of asRowList(scripting.server)) {
        if (String(row.name ?? '').trim().toLowerCase() === needle) {
          hits.server = row;
          break;
        }
      }
      for (const row of asRowList(scripting.runtime_items)) {
        if (String(row.name ?? '').trim().toLowerCase() === needle) {
          hits.runtime_item = row;
          break;
        }
      }
      const undocumentedHits: unknown[] = [];
      for (const row of asRowList(scripting.undocumented)) {
        const api = String(row.api ?? '').trim().toLowerCase();
        const members = String(row.members ?? '').trim().toLowerCase();
        if (
          needle === api ||
          members.split(',').map((s) => s.trim()).includes(needle) ||
          members.includes(needle)
        ) {
          undocumentedHits.push(row);
        }
      }
      hits.undocumented = undocumentedHits;
      return hits;
    },
    search(query: string, section?: string, maxMatches = 25) {
      if (!scripting) {
        return [];
      }
      const needle = query.trim().toLowerCase();
      if (!needle) {
        return [];
      }
      let sections: SectionKey[] = [...SECTION_KEYS];
      if (section) {
        sections = [resolveSection(section)];
      }
      const results: unknown[] = [];
      for (const sec of sections) {
        const payload = scripting[sec];
        if (sec === 'runtime_catalog' && payload && typeof payload === 'object') {
          const families =
            (payload as { families?: unknown[] }).families ?? [];
          for (const family of families) {
            if (!family || typeof family !== 'object') {
              continue;
            }
            const blob = Object.values(family as object)
              .map(String)
              .join(' ')
              .toLowerCase();
            if (blob.includes(needle)) {
              const f = family as Record<string, unknown>;
              results.push({
                section: sec,
                match: 'family',
                pattern: f.pattern,
                owner: f.owner,
                classification: f.classification,
                change_risk: f.change_risk
              });
              if (results.length >= maxMatches) {
                return results;
              }
            }
          }
          continue;
        }
        if (!Array.isArray(payload)) {
          continue;
        }
        for (const row of payload) {
          if (!row || typeof row !== 'object') {
            continue;
          }
          const blob = Object.values(row)
            .map(String)
            .join(' ')
            .toLowerCase();
          if (!blob.includes(needle)) {
            continue;
          }
          const item: Record<string, unknown> = { section: sec, match: 'row' };
          for (const key of [
            'name',
            'api',
            'pattern',
            'tag',
            'type',
            'owner',
            'family',
            'runtime_layer',
            'classification',
            'supported_contract',
            'change_risk',
            'description',
            'members',
            'script'
          ]) {
            const r = row as Record<string, unknown>;
            if (r[key]) {
              item[key] = r[key];
            }
          }
          results.push(item);
          if (results.length >= maxMatches) {
            return results;
          }
        }
      }
      return results;
    },
    performanceMeta() {
      if (!performance) {
        return { available: false };
      }
      const scope = performance.scope ?? {};
      return {
        available: true,
        format: performance.format,
        version: performance.version,
        dataset_id: performance.dataset_id,
        scope,
        environment: performance.environment,
        method: performance.method,
        ratio_semantics: performance.ratio_semantics,
        comparison_count: comparisons.length,
        comparison_ids: comparisons.map((row) => row.id)
      };
    },
    performanceLookup(construct: string) {
      const needle = construct.trim().toLowerCase();
      if (!needle) {
        throw new Error('construct is required');
      }
      return comparisons.filter((row) => {
        const names = [
          row.id,
          ...((Array.isArray(row.aliases) ? row.aliases : []) as unknown[]),
          (row.baseline as { label?: string } | undefined)?.label,
          (row.candidate as { label?: string } | undefined)?.label
        ];
        return names.some(
          (name) =>
            name != null && String(name).trim().toLowerCase() === needle
        );
      });
    },
    performanceSearch(options) {
      if (!performance) {
        return [];
      }
      const scope = (performance.scope ?? {}) as Record<string, unknown>;
      const supportN = (options.javascriptSupport ?? '').trim().toLowerCase();
      const runtimeN = (options.runtime ?? '').trim().toLowerCase();
      if (
        supportN &&
        supportN !== String(scope.javascript_support ?? '').toLowerCase()
      ) {
        return [];
      }
      if (
        runtimeN &&
        !String(scope.runtime ?? '').toLowerCase().includes(runtimeN)
      ) {
        return [];
      }
      const needle = (options.query ?? '').trim().toLowerCase();
      const maxMatches = options.maxMatches ?? 25;
      const results: unknown[] = [];
      for (const row of comparisons) {
        if (needle) {
          const searchable = JSON.stringify({
            id: row.id,
            aliases: row.aliases,
            category: row.category,
            baseline: row.baseline,
            candidate: row.candidate,
            workload: row.workload,
            observed: row.observed,
            limitations: row.limitations
          }).toLowerCase();
          if (!searchable.includes(needle)) {
            continue;
          }
        }
        results.push({
          id: row.id,
          category: row.category,
          runtime: scope.runtime,
          javascript_support: scope.javascript_support,
          execution_scope: scope.execution_scope,
          application_js_level: scope.application_js_level,
          has_es5_runtime_measurements: scope.has_es5_runtime_measurements,
          has_global_scope_measurements: scope.has_global_scope_measurements,
          scope_warning: scope.warning,
          baseline: row.baseline,
          candidate: row.candidate,
          workload: row.workload,
          observed: row.observed,
          limitations: row.limitations
        });
        if (results.length >= maxMatches) {
          break;
        }
      }
      return results;
    }
  };
}

/**
 * Load the scripting-reference pack and attach each named API onto a Registry symbol.
 */
export function attachScriptingDocsFromDir(
  registry: Registry,
  dataDir: string
): void {
  const scriptingPath = path.join(dataDir, 'scripting_reference.json.gz');
  const altScripting = path.join(dataDir, 'scripting_reference.json');
  let scripting: Record<string, unknown> | undefined;
  if (fs.existsSync(scriptingPath)) {
    scripting = JSON.parse(
      zlib.gunzipSync(fs.readFileSync(scriptingPath)).toString('utf8')
    ) as Record<string, unknown>;
  } else if (fs.existsSync(altScripting)) {
    scripting = JSON.parse(fs.readFileSync(altScripting, 'utf8')) as Record<
      string,
      unknown
    >;
  }
  attachScriptingDocs(registry, scripting);
}

/**
 * Fold scripting-reference rows onto PlatformApi / Global symbols.
 * Names that are not already lint globals are stored as `docsOnly` so lookup
 * can read the row without widening `no-undef`.
 */
export function attachScriptingDocs(
  registry: Registry,
  scripting: Record<string, unknown> | undefined
): void {
  if (!scripting) {
    return;
  }
  for (const row of asRowList(scripting.server)) {
    const name = String(row.name ?? '').trim();
    if (name) {
      mergeScriptingDoc(registry, name, 'server', row, 'server');
    }
  }
  for (const row of asRowList(scripting.runtime_items)) {
    const name = String(row.name ?? '').trim();
    if (name) {
      mergeScriptingDoc(registry, name, 'both', row, 'runtime_item');
    }
  }
  for (const row of asRowList(scripting.undocumented)) {
    const name = String(row.api ?? row.name ?? '').trim();
    if (name) {
      mergeScriptingDoc(registry, name, 'server', row, 'undocumented');
    }
  }
}

/**
 * Case-insensitive scripting-reference lookup over Registry symbols.
 */
export function scriptingLookupFromRegistry(
  registry: Registry,
  name: string
): {
  query: string;
  server: unknown;
  runtime_item: unknown;
  undocumented: unknown[];
} {
  const needle = name.trim().toLowerCase();
  if (!needle) {
    throw new Error('name is required');
  }
  let server: unknown = null;
  let runtimeItem: unknown = null;
  const undocumented: unknown[] = [];
  for (const symbol of platformSymbols(registry)) {
    const doc = symbol.doc;
    if (!doc || !symbol.docSection) {
      continue;
    }
    const symbolName = symbol.name.trim().toLowerCase();
    const memberHit =
      symbol.docSection === 'undocumented' &&
      memberNames(doc).includes(needle);
    if (symbolName !== needle && !memberHit) {
      continue;
    }
    if (symbol.docSection === 'server' && symbolName === needle && !server) {
      server = doc;
    } else if (
      symbol.docSection === 'runtime_item' &&
      symbolName === needle &&
      !runtimeItem
    ) {
      runtimeItem = doc;
    } else if (symbol.docSection === 'undocumented') {
      undocumented.push(doc);
    }
  }
  return {
    query: name,
    server,
    runtime_item: runtimeItem,
    undocumented
  };
}

/**
 * Attach one reference row, merging onto an existing global when the name matches.
 */
function mergeScriptingDoc(
  registry: Registry,
  name: string,
  profile: 'server' | 'client' | 'both',
  row: Record<string, unknown>,
  docSection: ScriptingDocSection
): void {
  const text = docSummary(row);
  const matches = registry.lookup(name).filter(
    (symbol): symbol is PlatformApiSymbol =>
      symbol.kind === 'PlatformApi' || symbol.kind === 'Global'
  );
  if (matches.length === 0) {
    registry.upsert({
      kind: 'PlatformApi',
      name,
      profile,
      documentation: text,
      doc: row,
      docSection,
      docsOnly: true
    });
    return;
  }
  for (const existing of matches) {
    registry.upsert({
      ...existing,
      documentation: existing.documentation || text,
      doc: row,
      docSection
    });
  }
}

function docSummary(row: Record<string, unknown>): string | undefined {
  const raw = row.description ?? row.summary ?? row.supported_contract;
  if (typeof raw !== 'string') {
    return undefined;
  }
  const text = raw.trim();
  return text ? text.slice(0, 2000) : undefined;
}

function memberNames(doc: Record<string, unknown>): string[] {
  const raw = doc.members;
  if (typeof raw !== 'string') {
    return [];
  }
  return raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function platformSymbols(registry: Registry): PlatformApiSymbol[] {
  const out: PlatformApiSymbol[] = [];
  for (const kind of ['PlatformApi', 'Global'] as const) {
    for (const symbol of registry.listByKind(kind)) {
      if (symbol.kind === 'PlatformApi' || symbol.kind === 'Global') {
        out.push(symbol);
      }
    }
  }
  return out;
}

function resolveSection(section: string): SectionKey {
  const resolved = section.trim().toLowerCase().replace(/-/g, '_').replace(/ /g, '_');
  const key = SECTION_ALIASES[resolved] ?? (resolved as SectionKey);
  if (!(SECTION_KEYS as readonly string[]).includes(key)) {
    throw new Error(
      `Unknown section '${section}'. Expected one of: ${SECTION_KEYS.join(', ')}`
    );
  }
  return key;
}

function asRowList(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (row): row is Record<string, unknown> => !!row && typeof row === 'object'
  );
}
