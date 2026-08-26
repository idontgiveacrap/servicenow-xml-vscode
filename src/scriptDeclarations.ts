import { parseExportFileName } from './fileName';
import { detectSysAppMetadata } from './javascriptSupport';
import { ParsedDocument, RecordRow, SYS_ID_RE } from './kinds/types';
import {
  decodeXmlEntities,
  extractRowElement,
  isPrimaryAction,
  parseSnXml
} from './parseSnXml';

/** Identifiers ESLint can accept as a global. */
export const JS_IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Tables whose record names can be additional lint globals. */
export const SCRIPT_DECLARATION_TABLE_PROFILE = {
  sys_script_include: 'server',
  sys_ui_script: 'client',
  sys_ux_client_script_include: 'client'
} as const;

export type ScriptDeclarationTable = keyof typeof SCRIPT_DECLARATION_TABLE_PROFILE;

export type ScriptDeclarationProfile =
  (typeof SCRIPT_DECLARATION_TABLE_PROFILE)[ScriptDeclarationTable];

/** One Script Include, UI Script, or UX client script include usable as a global. */
export interface ScriptDeclaration {
  table: ScriptDeclarationTable;
  profile: ScriptDeclarationProfile;
  /** Technical scope (`global`, `x_example`, …). */
  scope: string;
  name: string;
}

export interface ScriptIncludeScope {
  names: string[];
  packagePrivate?: string[];
  clientCallable?: string[];
}

export interface ScriptIncludeWhitelist {
  version: number;
  scopes: Record<string, ScriptIncludeScope>;
}

/** Technical scope names from a bundled `sys_scope` export. */
export interface ScopeList {
  version: number;
  scopes: string[];
}

const DECLARATION_TABLES = new Set<string>(
  Object.keys(SCRIPT_DECLARATION_TABLE_PROFILE)
);

/** Workspace `findFiles` glob for independent declaration export files. */
export const SCRIPT_DECLARATION_EXPORT_GLOB =
  '**/{sys_script_include,sys_ui_script,sys_ux_client_script_include}_????????????????????????????????.xml';

export interface ResolveScopeInput {
  apiName?: string;
  packageSource?: string;
  sysScopeValue?: string;
  workspaceAppSysId?: string;
  workspaceAppScope?: string;
  documentAppSysId?: string;
  documentAppScope?: string;
}

/**
 * True when `table` is a declaration table the linter indexes.
 */
export function isScriptDeclarationTable(
  table: string
): table is ScriptDeclarationTable {
  return DECLARATION_TABLES.has(table);
}

/**
 * True when the path is a `{table}_{32-hex}.xml` export for a declaration table.
 */
export function isScriptDeclarationExportPath(filePath: string): boolean {
  const parsed = parseExportFileName(filePath);
  return !!parsed && isScriptDeclarationTable(parsed.table.toLowerCase());
}

/**
 * Resolve a technical scope from api_name, package source, sys_scope, or app ids.
 * Unrelated scope sys_ids do not become the current app.
 */
export function resolveRowTechnicalScope(
  rowXml: string,
  sysScopeValue: string | undefined,
  apps: Omit<ResolveScopeInput, 'apiName' | 'packageSource' | 'sysScopeValue'>
): string | undefined {
  return resolveTechnicalScope({
    ...apps,
    apiName: rowFieldText(rowXml, 'api_name'),
    packageSource: packageSource(rowXml),
    sysScopeValue
  });
}

/**
 * Resolve a technical scope from api_name, package source, sys_scope, or app ids.
 * Unrelated scope sys_ids do not become the current app.
 */
export function resolveTechnicalScope(
  input: ResolveScopeInput
): string | undefined {
  const fromApi = scopePrefix(input.apiName);
  if (fromApi) {
    return fromApi;
  }
  if (input.packageSource && JS_IDENTIFIER_RE.test(input.packageSource)) {
    return input.packageSource;
  }
  const sysScope = input.sysScopeValue?.trim();
  if (!sysScope) {
    return undefined;
  }
  if (sysScope.toLowerCase() === 'global') {
    return 'global';
  }
  if (JS_IDENTIFIER_RE.test(sysScope) && !SYS_ID_RE.test(sysScope)) {
    return sysScope;
  }
  if (!SYS_ID_RE.test(sysScope)) {
    return undefined;
  }
  const id = sysScope.toLowerCase();
  if (
    input.workspaceAppSysId &&
    id === input.workspaceAppSysId.toLowerCase() &&
    input.workspaceAppScope &&
    JS_IDENTIFIER_RE.test(input.workspaceAppScope)
  ) {
    return input.workspaceAppScope;
  }
  if (
    input.documentAppSysId &&
    id === input.documentAppSysId.toLowerCase() &&
    input.documentAppScope &&
    JS_IDENTIFIER_RE.test(input.documentAppScope)
  ) {
    return input.documentAppScope;
  }
  return undefined;
}

/**
 * Collect declaration records from a parsed export.
 * Payload traversal is for standalone documents; workspace scans skip it.
 */
export function extractScriptDeclarations(
  doc: ParsedDocument,
  options?: {
    includePayloads?: boolean;
    workspaceAppSysId?: string;
    workspaceAppScope?: string;
  }
): ScriptDeclaration[] {
  const documentApp = detectSysAppMetadata(doc.text);
  const scopeInput = {
    workspaceAppSysId: options?.workspaceAppSysId,
    workspaceAppScope: options?.workspaceAppScope,
    documentAppSysId: documentApp?.sysId,
    documentAppScope: documentApp?.scope
  };
  const out: ScriptDeclaration[] = [];
  collectFromRows(doc, doc.rows, scopeInput, out);
  if (options?.includePayloads) {
    for (const inner of payloadDocuments(doc)) {
      collectFromRows(inner, inner.rows, scopeInput, out);
    }
  }
  return out;
}

/**
 * Overlay `next` onto `base` by table+scope+name (later wins).
 */
export function mergeScriptDeclarations(
  base: ScriptDeclaration[],
  next: ScriptDeclaration[]
): ScriptDeclaration[] {
  const byKey = new Map<string, ScriptDeclaration>();
  for (const declaration of [...base, ...next]) {
    byKey.set(declarationKey(declaration), declaration);
  }
  return [...byKey.values()];
}

/**
 * Stable cache key for a declaration list.
 */
export function scriptDeclarationsKey(declarations: ScriptDeclaration[]): string {
  return declarations
    .map(declarationKey)
    .sort()
    .join('|');
}

/**
 * ESLint globals contributed by bundled Script Includes plus indexed declarations.
 */
export function globalsForDeclarations(options: {
  profile: 'server' | 'client';
  callerScope?: string;
  bundledScriptIncludes?: ScriptIncludeWhitelist;
  bundledScopes?: ScopeList;
  extra: ScriptDeclaration[];
}): Record<string, 'readonly'> {
  if (options.profile === 'client') {
    return clientDeclarationGlobals(
      options.callerScope ?? 'global',
      options.extra
    );
  }
  return serverDeclarationGlobals(
    options.callerScope ?? 'global',
    options.bundledScriptIncludes,
    options.bundledScopes,
    options.extra
  );
}

/**
 * Name a declaration-table row contributes as a global, if any.
 *
 * Unlike the globals maps this ignores `active` and scope resolution: the row
 * is where the name comes from either way, so its own script must never be
 * treated as shadowing it.
 */
export function rowDeclarationName(
  table: string,
  rowXml: string
): string | undefined {
  if (!isScriptDeclarationTable(table)) {
    return undefined;
  }
  return declarationName(
    rowFieldText(rowXml, 'name'),
    rowFieldText(rowXml, 'api_name')
  );
}

function declarationKey(declaration: ScriptDeclaration): string {
  return `${declaration.table}:${declaration.scope}:${declaration.name}`;
}

function scopePrefix(apiName: string | undefined): string | undefined {
  if (!apiName) {
    return undefined;
  }
  const dot = apiName.indexOf('.');
  if (dot <= 0) {
    return undefined;
  }
  const scope = apiName.slice(0, dot);
  return JS_IDENTIFIER_RE.test(scope) ? scope : undefined;
}

function collectFromRows(
  doc: ParsedDocument,
  rows: RecordRow[],
  scopeInput: Omit<ResolveScopeInput, 'apiName' | 'packageSource' | 'sysScopeValue'>,
  out: ScriptDeclaration[]
): void {
  for (const row of rows) {
    if (!isPrimaryAction(row.action) || row.action === 'DELETE') {
      continue;
    }
    const table = row.tableName.toLowerCase();
    if (!isScriptDeclarationTable(table)) {
      continue;
    }
    const rowXml = doc.text.slice(row.startOffset, row.endOffset);
    const declaration = declarationFromRow(table, rowXml, {
      ...scopeInput,
      sysScopeValue: row.sysScopeValue
    });
    if (declaration) {
      out.push(declaration);
    }
  }
}

function declarationFromRow(
  table: ScriptDeclarationTable,
  rowXml: string,
  scopeInput: ResolveScopeInput
): ScriptDeclaration | undefined {
  const active = rowFieldText(rowXml, 'active');
  if (active && active.toLowerCase() !== 'true') {
    return undefined;
  }
  const apiName = rowFieldText(rowXml, 'api_name');
  const name = declarationName(rowFieldText(rowXml, 'name'), apiName);
  if (!name) {
    return undefined;
  }
  const scope = resolveTechnicalScope({
    ...scopeInput,
    apiName,
    packageSource: packageSource(rowXml)
  });
  if (!scope) {
    return undefined;
  }
  return {
    table,
    profile: SCRIPT_DECLARATION_TABLE_PROFILE[table],
    scope,
    name
  };
}

function declarationName(
  name: string | undefined,
  apiName: string | undefined
): string | undefined {
  if (name && JS_IDENTIFIER_RE.test(name)) {
    return name;
  }
  if (!apiName) {
    return undefined;
  }
  const dot = apiName.lastIndexOf('.');
  const className = dot >= 0 ? apiName.slice(dot + 1) : apiName;
  return JS_IDENTIFIER_RE.test(className) ? className : undefined;
}

function rowFieldText(rowXml: string, fieldName: string): string | undefined {
  const el = extractRowElement(rowXml, fieldName);
  if (!el) {
    return undefined;
  }
  const value = (el.isCdata ? el.content : decodeXmlEntities(el.content)).trim();
  return value || undefined;
}

function packageSource(rowXml: string): string | undefined {
  const open = rowXml.match(/<\s*sys_package\b([^>]*)>/i);
  if (!open) {
    return undefined;
  }
  const attr = open[1].match(/\bsource\s*=\s*["']([^"']+)["']/i);
  const value = attr?.[1]?.trim();
  return value && JS_IDENTIFIER_RE.test(value) ? value : undefined;
}

function payloadDocuments(doc: ParsedDocument): ParsedDocument[] {
  const out: ParsedDocument[] = [];
  for (const row of doc.rows) {
    if (row.tableName !== 'sys_update_xml') {
      continue;
    }
    if (row.action === 'DELETE') {
      continue;
    }
    const rowXml = doc.text.slice(row.startOffset, row.endOffset);
    const payloadEl = extractRowElement(rowXml, 'payload');
    if (!payloadEl) {
      continue;
    }
    const payload = payloadEl.isCdata
      ? payloadEl.content
      : decodeXmlEntities(payloadEl.content);
    if (!payload.trim()) {
      continue;
    }
    const inner = parseSnXml(payload);
    if (inner.wellFormed) {
      out.push(inner);
    }
  }
  return out;
}

function serverDeclarationGlobals(
  callerScope: string,
  bundled: ScriptIncludeWhitelist | undefined,
  bundledScopes: ScopeList | undefined,
  extra: ScriptDeclaration[]
): Record<string, 'readonly'> {
  const namesByScope = new Map<string, Set<string>>();
  if (bundled) {
    for (const [scope, entry] of Object.entries(bundled.scopes)) {
      namesByScope.set(scope, new Set(entry.names));
    }
  }
  for (const declaration of extra) {
    if (declaration.profile !== 'server') {
      continue;
    }
    let names = namesByScope.get(declaration.scope);
    if (!names) {
      names = new Set();
      namesByScope.set(declaration.scope, names);
    }
    names.add(declaration.name);
  }

  const globals: Record<string, 'readonly'> = {};
  if (callerScope !== 'global') {
    globals.global = 'readonly';
  }
  for (const [scope, names] of namesByScope) {
    if (scope === callerScope) {
      for (const name of names) {
        globals[name] = 'readonly';
      }
      continue;
    }
    if (scope !== 'global' && JS_IDENTIFIER_RE.test(scope)) {
      globals[scope] = 'readonly';
    }
  }

  // A scope that owns no Script Include in the whitelist is still a namespace
  // the platform binds, so `<scope>.<Name>` resolves its prefix. `global` and
  // the caller's own scope are excluded: both are handled above, where the
  // reachable names decide whether the namespace exists at all.
  for (const scope of bundledScopes?.scopes ?? []) {
    if (scope === 'global' || scope === callerScope) {
      continue;
    }
    if (JS_IDENTIFIER_RE.test(scope)) {
      globals[scope] = 'readonly';
    }
  }
  return globals;
}

function clientDeclarationGlobals(
  callerScope: string,
  extra: ScriptDeclaration[]
): Record<string, 'readonly'> {
  const globals: Record<string, 'readonly'> = {};
  for (const declaration of extra) {
    if (declaration.profile !== 'client') {
      continue;
    }
    if (declaration.scope === 'global' || declaration.scope === callerScope) {
      globals[declaration.name] = 'readonly';
    }
  }
  return globals;
}
