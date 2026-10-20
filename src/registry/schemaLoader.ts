/**
 * Load packed sys_dictionary assets into the Registry (tables eagerly, fields lazy).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import type { CachedSchemaField } from './cache';
import { Registry } from './Registry';
import type { FieldSymbol, TableSymbol } from './types';

interface TablesPack {
  version: number;
  tables: Array<{ name: string; label?: string }>;
}

/** One packed dictionary field (name, label, type, reference). */
export interface PackedField {
  element: string;
  label?: string;
  internalType?: string;
  reference?: string;
  embeddedLanguage?: 'javascript' | 'json' | 'css' | 'xml' | 'other';
}

/** Field row returned by schema queries. */
export interface SchemaFieldHit {
  table: string;
  name: string;
  label?: string;
  type?: string;
  reference?: string;
}

/** Schema hit tagged with whether the workspace export replaced the platform row. */
export interface MergedSchemaFieldHit extends SchemaFieldHit {
  source: 'platform' | 'project';
}

interface FieldsPack {
  version: number;
  fields: Record<string, PackedField[]>;
}

/**
 * Resolve schema asset paths next to the compiled extension or source tree.
 */
export function schemaAssetPaths(baseDir?: string): {
  tables: string;
  fieldsGz: string;
} {
  const root = baseDir ?? path.join(__dirname, '..', 'data');
  return {
    tables: path.join(root, 'dictionaryTables.json'),
    fieldsGz: path.join(root, 'dictionaryFields.json.gz')
  };
}

/**
 * Load table symbols into the Registry from the packed tables JSON.
 */
export function loadDictionaryTables(
  registry: Registry,
  tablesJsonPath: string
): number {
  if (!fs.existsSync(tablesJsonPath)) {
    console.warn('[servicenow-xml] dictionary tables pack missing:', tablesJsonPath);
    return 0;
  }
  const pack = JSON.parse(fs.readFileSync(tablesJsonPath, 'utf8')) as TablesPack;
  registry.clearSchemaSymbols();
  for (const table of pack.tables) {
    const symbol: TableSymbol = {
      kind: 'Table',
      name: table.name,
      label: table.label,
      isTableDefinition: true
    };
    registry.upsert(symbol);
  }
  return pack.tables.length;
}

/**
 * Lazy field pack: gunzip once, upsert Field symbols per table on demand.
 */
export class DictionaryFieldIndex {
  private fields: FieldsPack['fields'] | undefined;
  private loadedTables = new Set<string>();

  constructor(
    private readonly registry: Registry,
    private readonly fieldsGzPath: string
  ) {}

  /**
   * Ensure fields for `table` are in the Registry (no-op if unknown / already loaded).
   */
  ensureTableFields(table: string): void {
    if (this.loadedTables.has(table)) {
      return;
    }
    this.ensurePackLoaded();
    if (!this.fields) {
      return;
    }
    const rows = this.fields[table];
    this.loadedTables.add(table);
    if (!rows) {
      return;
    }
    for (const row of rows) {
      const symbol: FieldSymbol = {
        kind: 'Field',
        name: row.element,
        table,
        element: row.element,
        label: row.label,
        internalType: row.internalType,
        reference: row.reference,
        embeddedLanguage: row.embeddedLanguage
      };
      this.registry.upsert(symbol);
    }
  }

  /**
   * Preload every table's fields (MCP / bulk search). Heavy — call intentionally.
   */
  loadAllFields(): void {
    this.ensurePackLoaded();
    if (!this.fields) {
      return;
    }
    for (const table of Object.keys(this.fields)) {
      this.ensureTableFields(table);
    }
  }

  /**
   * Fields for one table: name, label, type, and reference.
   * Does not require the table's symbols to be upserted first.
   */
  fieldsFor(table: string): SchemaFieldHit[] {
    this.ensurePackLoaded();
    const rows = this.fields?.[table];
    if (!rows) {
      return [];
    }
    return rows.map((row) => toFieldHit(table, row));
  }

  /**
   * Substring search across field name, label, type, and reference.
   */
  searchFields(query: string, limit: number): SchemaFieldHit[] {
    this.ensurePackLoaded();
    const needle = query.trim().toLowerCase();
    if (!needle || !this.fields || limit <= 0) {
      return [];
    }
    const hits: SchemaFieldHit[] = [];
    const tables = Object.keys(this.fields).sort();
    for (const table of tables) {
      for (const row of this.fields[table]) {
        const hit = toFieldHit(table, row);
        const hay = [hit.name, hit.label, hit.type, hit.reference]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(needle)) {
          continue;
        }
        hits.push(hit);
        if (hits.length >= limit) {
          return hits;
        }
      }
    }
    return hits;
  }

  hasTable(table: string): boolean {
    if (this.registry.getTable(table)) {
      return true;
    }
    this.ensurePackLoaded();
    return !!(this.fields && table in this.fields);
  }

  private ensurePackLoaded(): void {
    if (this.fields) {
      return;
    }
    if (!fs.existsSync(this.fieldsGzPath)) {
      console.warn(
        '[servicenow-xml] dictionary fields pack missing:',
        this.fieldsGzPath
      );
      this.fields = {};
      return;
    }
    const raw = zlib.gunzipSync(fs.readFileSync(this.fieldsGzPath));
    const pack = JSON.parse(raw.toString('utf8')) as FieldsPack;
    this.fields = pack.fields;
  }
}

/**
 * Map a packed dictionary row to the schema query shape.
 */
/**
 * Platform pack fields with workspace columns overlaid. Project rows win on the same element.
 */
export function mergeSchemaFields(
  packed: SchemaFieldHit[],
  project: CachedSchemaField[]
): MergedSchemaFieldHit[] {
  const byName = new Map<string, MergedSchemaFieldHit>();
  for (const field of packed) {
    byName.set(field.name, { ...field, source: 'platform' });
  }
  for (const field of project) {
    if (!field.element) {
      continue;
    }
    byName.set(field.element, projectFieldHit(field));
  }
  return [...byName.values()];
}

/**
 * Field search across project columns first, then platform rows the project did not replace.
 */
export function searchMergedSchema(
  packedHits: SchemaFieldHit[],
  project: CachedSchemaField[],
  query: string,
  limit: number
): MergedSchemaFieldHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle || limit <= 0) {
    return [];
  }
  const overridden = new Set(
    project.filter((field) => field.element).map((field) => `${field.table}.${field.element}`)
  );
  const hits: MergedSchemaFieldHit[] = [];
  for (const field of project) {
    if (!field.element || !fieldMatches(projectFieldHit(field), needle)) {
      continue;
    }
    hits.push(projectFieldHit(field));
    if (hits.length >= limit) {
      return hits;
    }
  }
  for (const field of packedHits) {
    if (overridden.has(`${field.table}.${field.name}`)) {
      continue;
    }
    if (!fieldMatches(field, needle)) {
      continue;
    }
    hits.push({ ...field, source: 'platform' });
    if (hits.length >= limit) {
      return hits;
    }
  }
  return hits;
}

function projectFieldHit(field: CachedSchemaField): MergedSchemaFieldHit {
  return {
    table: field.table,
    name: field.element,
    ...(field.label ? { label: field.label } : {}),
    ...(field.internalType ? { type: field.internalType } : {}),
    ...(field.reference ? { reference: field.reference } : {}),
    source: 'project'
  };
}

function fieldMatches(field: SchemaFieldHit, needle: string): boolean {
  return [field.name, field.label, field.type, field.reference]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(needle);
}

function toFieldHit(table: string, row: PackedField): SchemaFieldHit {
  return {
    table,
    name: row.element,
    ...(row.label ? { label: row.label } : {}),
    ...(row.internalType ? { type: row.internalType } : {}),
    ...(row.reference ? { reference: row.reference } : {})
  };
}
