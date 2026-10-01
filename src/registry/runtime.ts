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
 * Shared Registry, with static packs loaded on first use.
 */
export function getRuntimeRegistry(): Registry {
  if (!registry) {
    registry = new Registry();
  }
  ensureStaticLoaded(registry);
  return registry;
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

function ensureStaticLoaded(target: Registry): void {
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
