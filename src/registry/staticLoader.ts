/**
 * Load static Registry packs (SI whitelist, scopes, platform globals).
 * Pack scripts remain export-shaped; globals JSON may include documented supplements.
 */

import {
  ScopeList,
  ScriptIncludeWhitelist
} from '../scriptDeclarations';
import { Registry } from './Registry';
import {
  PlatformApiSymbol,
  ScopeSymbol,
  ScriptIncludeSymbol
} from './types';

/** Packed platform global / API name. */
export interface PackedPlatformGlobal {
  name: string;
  profile: 'server' | 'client' | 'both';
  writable?: boolean;
  /** True when carried from code because no SN export listed it. */
  fromSupplement?: boolean;
  documentation?: string;
}

/** Root shape of `platformGlobals.json`. */
export interface PlatformGlobalsPack {
  version: number;
  globals: PackedPlatformGlobal[];
}

/**
 * Load bundled Script Includes, scopes, and platform globals into the Registry.
 */
export function loadStaticPacks(
  registry: Registry,
  packs: {
    scriptIncludes: ScriptIncludeWhitelist;
    scopes: ScopeList;
    platformGlobals: PlatformGlobalsPack;
  }
): void {
  for (const [scope, entry] of Object.entries(packs.scriptIncludes.scopes)) {
    const packagePrivate = new Set(entry.packagePrivate ?? []);
    const clientCallable = new Set(entry.clientCallable ?? []);
    for (const name of entry.names) {
      const symbol: ScriptIncludeSymbol = {
        kind: 'ScriptInclude',
        name,
        table: 'sys_script_include',
        profile: 'server',
        scope,
        packagePrivate: packagePrivate.has(name),
        clientCallable: clientCallable.has(name),
        fromWorkspace: false
      };
      registry.upsert(symbol);
    }
  }

  for (const scope of packs.scopes.scopes) {
    const symbol: ScopeSymbol = {
      kind: 'Scope',
      name: scope,
      scope
    };
    registry.upsert(symbol);
  }

  for (const global of packs.platformGlobals.globals) {
    const symbol: PlatformApiSymbol = {
      kind: global.fromSupplement ? 'Global' : 'PlatformApi',
      name: global.name,
      profile: global.profile,
      writable: global.writable,
      fromSupplement: global.fromSupplement,
      documentation: global.documentation
    };
    registry.upsert(symbol);
  }
}

/**
 * Rebuild the Script Include whitelist shape from Registry static SI symbols
 * for callers that still expect `ScriptIncludeWhitelist`.
 */
export function scriptIncludesFromRegistry(
  registry: Registry
): ScriptIncludeWhitelist {
  const scopes: ScriptIncludeWhitelist['scopes'] = {};
  for (const symbol of registry.listByKind('ScriptInclude')) {
    if (symbol.kind !== 'ScriptInclude' || symbol.fromWorkspace) {
      continue;
    }
    const scope = symbol.scope ?? 'global';
    let entry = scopes[scope];
    if (!entry) {
      entry = { names: [] };
      scopes[scope] = entry;
    }
    entry.names.push(symbol.name);
    if (symbol.packagePrivate) {
      entry.packagePrivate = entry.packagePrivate ?? [];
      entry.packagePrivate.push(symbol.name);
    }
    if (symbol.clientCallable) {
      entry.clientCallable = entry.clientCallable ?? [];
      entry.clientCallable.push(symbol.name);
    }
  }
  return { version: 1, scopes };
}

/**
 * Rebuild ScopeList from Registry Scope symbols.
 */
export function scopesFromRegistry(registry: Registry): ScopeList {
  return {
    version: 1,
    scopes: registry.listScopes().map((s) => s.name)
  };
}
