import {
  DependencyEdge,
  FieldSymbol,
  PlatformApiSymbol,
  RecordSymbol,
  RegistrySymbol,
  ScopeSymbol,
  ScriptIncludeSymbol,
  ScriptProfile,
  SymbolKind,
  TableSymbol,
  UiScriptSymbol,
  symbolId
} from './types';

/**
 * In-memory symbol store with lookup indexes.
 * No vscode imports — safe for MCP and a future language server.
 */
export class Registry {
  private readonly symbols = new Map<string, RegistrySymbol>();
  private readonly byName = new Map<string, string[]>();
  private readonly byTable = new Map<string, string[]>();
  private readonly byScope = new Map<string, string[]>();
  private readonly byUri = new Map<string, string[]>();
  private readonly byKind = new Map<SymbolKind, string[]>();
  private readonly edges: DependencyEdge[] = [];
  /** Parsed-document / AST payloads keyed by uri + version (Phase D). */
  private readonly parseCache = new Map<
    string,
    { version: number; xmlParsed?: unknown; jsAstByRegion?: Map<string, unknown> }
  >();

  clear(): void {
    this.symbols.clear();
    this.byName.clear();
    this.byTable.clear();
    this.byScope.clear();
    this.byUri.clear();
    this.byKind.clear();
    this.edges.length = 0;
  }

  /**
   * Remove all workspace-backed records and declaration scripts (keep static packs).
   */
  clearWorkspaceSymbols(): void {
    const remove: string[] = [];
    for (const [id, symbol] of this.symbols) {
      if (symbol.kind === 'Record') {
        remove.push(id);
        continue;
      }
      if (
        (symbol.kind === 'ScriptInclude' || symbol.kind === 'UiScript') &&
        symbol.fromWorkspace
      ) {
        remove.push(id);
      }
    }
    for (const id of remove) {
      this.removeSymbol(id);
    }
  }

  /**
   * Remove schema Table/Field symbols (before reloading a dictionary pack).
   */
  clearSchemaSymbols(): void {
    const remove: string[] = [];
    for (const [id, symbol] of this.symbols) {
      if (symbol.kind === 'Table' || symbol.kind === 'Field') {
        remove.push(id);
      }
    }
    for (const id of remove) {
      this.removeSymbol(id);
    }
  }

  upsert(symbol: RegistrySymbol): string {
    const id = symbolId(symbol);
    if (this.symbols.has(id)) {
      this.removeFromIndexes(id, this.symbols.get(id)!);
    }
    this.symbols.set(id, symbol);
    this.addToIndexes(id, symbol);
    return id;
  }

  upsertMany(symbols: RegistrySymbol[]): void {
    for (const symbol of symbols) {
      this.upsert(symbol);
    }
  }

  get(id: string): RegistrySymbol | undefined {
    return this.symbols.get(id);
  }

  lookup(name: string): RegistrySymbol[] {
    const ids = this.byName.get(name) ?? [];
    return ids.map((id) => this.symbols.get(id)!).filter(Boolean);
  }

  listByKind(kind: SymbolKind): RegistrySymbol[] {
    const ids = this.byKind.get(kind) ?? [];
    return ids.map((id) => this.symbols.get(id)!).filter(Boolean);
  }

  byTableName(table: string): RegistrySymbol[] {
    const ids = this.byTable.get(table) ?? [];
    return ids.map((id) => this.symbols.get(id)!).filter(Boolean);
  }

  byScopeName(scope: string): RegistrySymbol[] {
    const ids = this.byScope.get(scope) ?? [];
    return ids.map((id) => this.symbols.get(id)!).filter(Boolean);
  }

  byUriString(uri: string): RegistrySymbol[] {
    const ids = this.byUri.get(uri) ?? [];
    return ids.map((id) => this.symbols.get(id)!).filter(Boolean);
  }

  getTable(name: string): TableSymbol | undefined {
    for (const symbol of this.lookup(name)) {
      if (symbol.kind === 'Table') {
        return symbol;
      }
    }
    return undefined;
  }

  getField(table: string, element: string): FieldSymbol | undefined {
    const id = `Field:${table}.${element}`;
    const symbol = this.symbols.get(id);
    return symbol?.kind === 'Field' ? symbol : undefined;
  }

  listTables(): TableSymbol[] {
    return this.listByKind('Table') as TableSymbol[];
  }

  listFieldsForTable(table: string): FieldSymbol[] {
    return this.byTableName(table).filter(
      (s): s is FieldSymbol => s.kind === 'Field'
    );
  }

  listRecords(): RecordSymbol[] {
    return this.listByKind('Record') as RecordSymbol[];
  }

  /**
   * Workspace Script Include / UI Script / UX CSI declarations for lint.
   */
  listWorkspaceDeclarations(): Array<ScriptIncludeSymbol | UiScriptSymbol> {
    const out: Array<ScriptIncludeSymbol | UiScriptSymbol> = [];
    for (const symbol of this.listByKind('ScriptInclude')) {
      if (symbol.kind === 'ScriptInclude' && symbol.fromWorkspace) {
        out.push(symbol);
      }
    }
    for (const symbol of this.listByKind('UiScript')) {
      if (symbol.kind === 'UiScript' && symbol.fromWorkspace) {
        out.push(symbol);
      }
    }
    return out;
  }

  listPlatformGlobals(profile: ScriptProfile): PlatformApiSymbol[] {
    const out: PlatformApiSymbol[] = [];
    for (const kind of ['PlatformApi', 'Global'] as const) {
      for (const symbol of this.listByKind(kind)) {
        if (symbol.kind !== 'PlatformApi' && symbol.kind !== 'Global') {
          continue;
        }
        if (symbol.profile === profile || symbol.profile === 'both') {
          out.push(symbol);
        }
      }
    }
    return out;
  }

  listScopes(): ScopeSymbol[] {
    return this.listByKind('Scope') as ScopeSymbol[];
  }

  addEdge(edge: DependencyEdge): void {
    this.edges.push(edge);
  }

  getEdges(): readonly DependencyEdge[] {
    return this.edges;
  }

  getOrCreateParseEntry(uri: string, version: number): {
    version: number;
    xmlParsed?: unknown;
    jsAstByRegion?: Map<string, unknown>;
  } {
    const existing = this.parseCache.get(uri);
    if (existing && existing.version === version) {
      return existing;
    }
    const entry = { version, jsAstByRegion: new Map<string, unknown>() };
    this.parseCache.set(uri, entry);
    return entry;
  }

  getParseEntry(uri: string):
    | { version: number; xmlParsed?: unknown; jsAstByRegion?: Map<string, unknown> }
    | undefined {
    return this.parseCache.get(uri);
  }

  invalidateParse(uri: string): void {
    this.parseCache.delete(uri);
  }

  /** Snapshot counts for MCP / diagnostics context. */
  getDiagnosticsContext(): {
    recordCount: number;
    declarationCount: number;
    tableCount: number;
    fieldCount: number;
    platformApiCount: number;
  } {
    return {
      recordCount: this.listByKind('Record').length,
      declarationCount: this.listWorkspaceDeclarations().length,
      tableCount: this.listByKind('Table').length,
      fieldCount: this.listByKind('Field').length,
      platformApiCount:
        this.listByKind('PlatformApi').length + this.listByKind('Global').length
    };
  }

  private removeSymbol(id: string): void {
    const symbol = this.symbols.get(id);
    if (!symbol) {
      return;
    }
    this.removeFromIndexes(id, symbol);
    this.symbols.delete(id);
  }

  private addToIndexes(id: string, symbol: RegistrySymbol): void {
    this.pushIndex(this.byName, symbol.name, id);
    this.pushIndex(this.byKind, symbol.kind, id);
    if (symbol.scope) {
      this.pushIndex(this.byScope, symbol.scope, id);
    }
    if (symbol.uri) {
      this.pushIndex(this.byUri, symbol.uri, id);
    }
    if (symbol.kind === 'Record') {
      this.pushIndex(this.byTable, symbol.table, id);
    } else if (symbol.kind === 'Field') {
      this.pushIndex(this.byTable, symbol.table, id);
    } else if (symbol.kind === 'Table') {
      this.pushIndex(this.byTable, symbol.name, id);
    }
  }

  private removeFromIndexes(id: string, symbol: RegistrySymbol): void {
    this.pullIndex(this.byName, symbol.name, id);
    this.pullIndex(this.byKind, symbol.kind, id);
    if (symbol.scope) {
      this.pullIndex(this.byScope, symbol.scope, id);
    }
    if (symbol.uri) {
      this.pullIndex(this.byUri, symbol.uri, id);
    }
    if (symbol.kind === 'Record') {
      this.pullIndex(this.byTable, symbol.table, id);
    } else if (symbol.kind === 'Field') {
      this.pullIndex(this.byTable, symbol.table, id);
    } else if (symbol.kind === 'Table') {
      this.pullIndex(this.byTable, symbol.name, id);
    }
  }

  private pushIndex(map: Map<string, string[]>, key: string, id: string): void {
    const list = map.get(key);
    if (list) {
      if (!list.includes(id)) {
        list.push(id);
      }
    } else {
      map.set(key, [id]);
    }
  }

  private pullIndex(map: Map<string, string[]>, key: string, id: string): void {
    const list = map.get(key);
    if (!list) {
      return;
    }
    const next = list.filter((x) => x !== id);
    if (next.length === 0) {
      map.delete(key);
    } else {
      map.set(key, next);
    }
  }
}
