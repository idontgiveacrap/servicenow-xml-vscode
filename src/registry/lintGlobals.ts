/**
 * Build ESLint globals maps from the Registry (plus same-document extras).
 */

import {
  globalsForDeclarations,
  ScriptDeclaration,
  ScriptIncludeWhitelist,
  ScopeList
} from '../scriptDeclarations';
import { Registry } from './Registry';
import {
  scriptIncludesFromRegistry,
  scopesFromRegistry
} from './staticLoader';

/**
 * Convert workspace declaration symbols into ScriptDeclaration rows for lint.
 */
export function workspaceDeclarationsFromRegistry(
  registry: Registry
): ScriptDeclaration[] {
  return registry.listWorkspaceDeclarations().map((symbol) => ({
    table:
      symbol.kind === 'ScriptInclude'
        ? 'sys_script_include'
        : symbol.table,
    profile: symbol.profile,
    scope: symbol.scope ?? 'global',
    name: symbol.name
  }));
}

/**
 * Platform + feature globals from Registry as ESLint global map.
 */
export function platformGlobalsMap(
  registry: Registry,
  profile: 'server' | 'client'
): Record<string, 'readonly' | 'writable'> {
  const out: Record<string, 'readonly' | 'writable'> = {};
  for (const symbol of registry.listPlatformGlobals(profile)) {
    out[symbol.name] = symbol.writable ? 'writable' : 'readonly';
  }
  return out;
}

/**
 * Full ESLint globals for a script region from Registry + extra declarations.
 */
export function globalsForLint(
  registry: Registry,
  options: {
    profile: 'server' | 'client';
    callerScope?: string;
    extra: ScriptDeclaration[];
    /** ES12 feature globals (Map, Promise, …) merged like PLATFORM_FEATURE_GLOBALS. */
    featureGlobals?: Record<string, 'readonly' | 'writable'>;
  }
): Record<string, 'readonly' | 'writable'> {
  const bundledScriptIncludes: ScriptIncludeWhitelist =
    scriptIncludesFromRegistry(registry);
  const bundledScopes: ScopeList = scopesFromRegistry(registry);
  const declarationGlobals = globalsForDeclarations({
    profile: options.profile,
    callerScope: options.callerScope,
    bundledScriptIncludes,
    bundledScopes,
    extra: options.extra
  });
  const platform = platformGlobalsMap(registry, options.profile);
  const merged =
    options.profile === 'server'
      ? { ...platform, ...platformGlobalsMap(registry, 'client') }
      : platform;
  return {
    ...(options.featureGlobals ?? {}),
    ...declarationGlobals,
    ...merged
  };
}

/**
 * Names that should not trigger no-shadowed-platform-global (declaration extras only).
 */
export function shadowAllowFromRegistry(
  registry: Registry,
  options: {
    profile: 'server' | 'client';
    callerScope?: string;
    extra: ScriptDeclaration[];
  }
): string[] {
  return Object.keys(
    globalsForDeclarations({
      profile: options.profile,
      callerScope: options.callerScope,
      extra: options.extra
    })
  );
}
