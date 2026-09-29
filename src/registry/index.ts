/**
 * Public Registry API surface (vscode-free modules + types).
 */

export { Registry } from './Registry';
export type { RegistryHost, RegistryFileSystem, RegistryClock, RegistryWorkspaceRoots } from './host';
export * from './types';
export * from './cache';
export {
  loadStaticPacks,
  scriptIncludesFromRegistry,
  scopesFromRegistry
} from './staticLoader';
export type { PlatformGlobalsPack, PackedPlatformGlobal } from './staticLoader';
export {
  globalsForLint,
  platformGlobalsMap,
  shadowAllowFromRegistry,
  workspaceDeclarationsFromRegistry
} from './lintGlobals';
export { indexExportText, toCachedDeclaration } from './workspaceIndexer';
export {
  loadDictionaryTables,
  DictionaryFieldIndex,
  schemaAssetPaths
} from './schemaLoader';
export { lintSchemaTableArgs, schemaMessagesToEslint } from './schemaLint';
export {
  getOrParseXml,
  extractAndMergeMethods,
  resolveScriptIncludeReference
} from './lazyParse';
export { getRuntimeRegistry, getRuntimeFieldIndex } from './runtime';
