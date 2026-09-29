/**
 * Load packed sys_dictionary assets into the Registry (tables eagerly, fields lazy).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { Registry } from './Registry';
import type { FieldSymbol, TableSymbol } from './types';

interface TablesPack {
  version: number;
  tables: Array<{ name: string; label?: string }>;
}

interface FieldsPack {
  version: number;
  fields: Record<
    string,
    Array<{
      element: string;
      internalType?: string;
      reference?: string;
      embeddedLanguage?: 'javascript' | 'json' | 'css' | 'xml' | 'other';
    }>
  >;
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
