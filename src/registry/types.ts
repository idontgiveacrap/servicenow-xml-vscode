/**
 * Shared symbol model for the ServiceNow Registry (vscode-free).
 * Protocol-shaped so MCP and a future LSP can query the same store.
 */

/** Discriminator for Registry symbols. */
export type SymbolKind =
  | 'Record'
  | 'ScriptInclude'
  | 'UiScript'
  | 'Table'
  | 'Field'
  | 'PlatformApi'
  | 'Global'
  | 'Scope'
  | 'Property'
  | 'Method';

/** Lint / runtime profile for script symbols. */
export type ScriptProfile = 'server' | 'client';

/** Base fields every Registry symbol carries. */
export interface RegistrySymbolBase {
  kind: SymbolKind;
  /** Primary lookup name (table name, SI name, API identifier, …). */
  name: string;
  /** Technical scope when applicable (`global`, `x_example`, …). */
  scope?: string;
  /** Absolute or workspace URI string (file-backed symbols). */
  uri?: string;
  /** Workspace-relative path for agent discovery. */
  relativePath?: string;
  /** ServiceNow sys_id when known. */
  sysId?: string;
  /** Optional documentation / hover text. */
  documentation?: string;
}

/** Indexed export row (navigator / agent discovery). */
export interface RecordSymbol extends RegistrySymbolBase {
  kind: 'Record';
  table: string;
  displayName: string;
  action?: string;
  apiName?: string;
  sysModCount?: number;
  startOffset: number;
  mtimeMs?: number;
}

/** Script Include usable as a global (bundled or workspace). */
export interface ScriptIncludeSymbol extends RegistrySymbolBase {
  kind: 'ScriptInclude';
  profile: ScriptProfile;
  table: 'sys_script_include' | 'sys_script';
  packagePrivate?: boolean;
  clientCallable?: boolean;
  /** True when from workspace export rather than static pack. */
  fromWorkspace?: boolean;
}

/** UI Script or UX client script include. */
export interface UiScriptSymbol extends RegistrySymbolBase {
  kind: 'UiScript';
  profile: 'client';
  table: 'sys_ui_script' | 'sys_ux_client_script_include';
  fromWorkspace?: boolean;
}

/** Dictionary table. */
export interface TableSymbol extends RegistrySymbolBase {
  kind: 'Table';
  label?: string;
  /** True when this row is the table definition (empty element). */
  isTableDefinition?: boolean;
  /** True when the table exists only in the workspace export, not the platform pack. */
  fromWorkspace?: boolean;
}

/** Dictionary field on a table. */
export interface FieldSymbol extends RegistrySymbolBase {
  kind: 'Field';
  table: string;
  element: string;
  /** column_label from the dictionary export. */
  label?: string;
  internalType?: string;
  reference?: string;
  /** Script / JSON / CSS / other embedded language hint. */
  embeddedLanguage?: 'javascript' | 'json' | 'css' | 'xml' | 'other';
  /** True when this column came from the workspace dictionary, not the platform pack. */
  fromWorkspace?: boolean;
}

/** Which scripting-reference section a doc payload came from. */
export type ScriptingDocSection = 'server' | 'runtime_item' | 'undocumented';

/** Platform API or global binding name. */
export interface PlatformApiSymbol extends RegistrySymbolBase {
  kind: 'PlatformApi' | 'Global';
  profile: ScriptProfile | 'both';
  writable?: boolean;
  /** True when merged from code supplements rather than an SN export pack. */
  fromSupplement?: boolean;
  /**
   * Scripting-reference row. Lookup tools read this instead of a side index.
   * Lint ignores symbols that exist only to carry this payload (`docsOnly`).
   */
  doc?: Record<string, unknown>;
  docSection?: ScriptingDocSection;
  docsOnly?: boolean;
}

/** Technical scope namespace. */
export interface ScopeSymbol extends RegistrySymbolBase {
  kind: 'Scope';
}

/** sys_properties-style property (reserved for later). */
export interface PropertySymbol extends RegistrySymbolBase {
  kind: 'Property';
  value?: string;
}

/** Method extracted from a parsed Script Include (Phase D). */
export interface MethodSymbol extends RegistrySymbolBase {
  kind: 'Method';
  ownerName: string;
  ownerUri?: string;
}

export type RegistrySymbol =
  | RecordSymbol
  | ScriptIncludeSymbol
  | UiScriptSymbol
  | TableSymbol
  | FieldSymbol
  | PlatformApiSymbol
  | ScopeSymbol
  | PropertySymbol
  | MethodSymbol;

/** Directed edge in the lazy dependency graph. */
export interface DependencyEdge {
  fromId: string;
  toId: string;
  kind: 'calls' | 'references' | 'extends' | 'sys_id_ref';
}

/** Stable id for a symbol (kind + scope + name + uri disambiguator). */
export function symbolId(symbol: RegistrySymbol): string {
  const scope = symbol.scope ?? '';
  const uri = symbol.uri ?? '';
  if (symbol.kind === 'Field') {
    return `Field:${symbol.table}.${symbol.element}`;
  }
  if (symbol.kind === 'Record') {
    return `Record:${symbol.table}:${symbol.sysId ?? symbol.displayName}:${uri}:${symbol.startOffset}`;
  }
  if (symbol.kind === 'Method') {
    return `Method:${symbol.ownerName}.${symbol.name}:${uri}`;
  }
  return `${symbol.kind}:${scope}:${symbol.name}:${uri}`;
}
