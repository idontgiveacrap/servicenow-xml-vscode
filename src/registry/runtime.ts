/**
 * Process-wide Registry singleton (vscode-free).
 * Lint, MCP, and the extension adapter all share this instance.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  ScopeList,
  ScriptIncludeWhitelist
} from '../scriptDeclarations';
import { Registry } from './Registry';
import {
  DictionaryFieldIndex,
  loadDictionaryTables,
  schemaAssetPaths
} from './schemaLoader';
import { attachScriptingDocsFromDir } from './scriptingKnowledge';
import {
  loadStaticPacks,
  PlatformGlobalsPack
} from './staticLoader';

const SCRIPT_INCLUDES: ScriptIncludeWhitelist = require('../data/scriptIncludes.json');
const SCOPES: ScopeList = require('../data/scopes.json');
const PLATFORM_GLOBALS: PlatformGlobalsPack = require('../data/platformGlobals.json');

let registry: Registry | undefined;
let fieldIndex: DictionaryFieldIndex | undefined;
let staticLoaded = false;

/**
 * Shared Registry instance (created on first call). Static packs are NOT loaded
 * here — they are deferred via {@link ensureStaticLoaded} so that callers like
 * the embedded formatter, which never touch the Registry, are not blocked by
 * synchronous file I/O during activation.
 */
export function getRuntimeRegistry(): Registry {
  if (!registry) {
    registry = new Registry();
  }
  return registry;
}

/**
 * Load bundled SI / scopes / platform globals / dictionary tables into the
 * shared Registry on first call. Idempotent — subsequent calls are a single
 * boolean check. Call this before using Registry lookup methods that depend on
 * static packs (lint, completion, MCP). The formatter never needs to call it.
 */
export function ensureStaticLoaded(): void {
  if (!registry) {
    registry = new Registry();
  }
  if (staticLoaded) {
    return;
  }
  ensureStaticLoadedImpl(registry);
  staticLoaded = true;
}

/**
 * Lazy dictionary field index, or undefined when the pack is missing.
 */
export function getRuntimeFieldIndex(): DictionaryFieldIndex | undefined {
  const r = getRuntimeRegistry();
  if (!fieldIndex) {
    const paths = resolveSchemaPaths();
    if (fs.existsSync(paths.fieldsGz)) {
      fieldIndex = new DictionaryFieldIndex(r, paths.fieldsGz);
    }
  }
  return fieldIndex;
}

/**
 * Reset the process singleton (tests).
 */
export function resetRuntimeRegistry(): void {
  registry = undefined;
  fieldIndex = undefined;
  staticLoaded = false;
}

function ensureStaticLoadedImpl(target: Registry): void {
  if (staticLoaded) {
    return;
  }
  loadStaticPacks(target, {
    scriptIncludes: SCRIPT_INCLUDES,
    scopes: SCOPES,
    platformGlobals: PLATFORM_GLOBALS
  });
  const paths = resolveSchemaPaths();
  if (fs.existsSync(paths.tables)) {
    loadDictionaryTables(target, paths.tables);
  }
  attachScriptingDocsFromDir(target, path.dirname(paths.tables));
  staticLoaded = true;
}

function resolveSchemaPaths(): { tables: string; fieldsGz: string } {
  const candidates = [
    path.join(__dirname, 'data'),
    path.join(__dirname, '..', 'data'),
    path.join(__dirname, '..', 'src', 'data')
  ];
  for (const dir of candidates) {
    const paths = schemaAssetPaths(dir);
    if (fs.existsSync(paths.tables)) {
      return paths;
    }
  }
  return schemaAssetPaths(path.join(__dirname, '..', 'src', 'data'));
}
