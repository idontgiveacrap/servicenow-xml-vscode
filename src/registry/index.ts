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
export { scriptCompletions } from './scriptCompletion';
export {
  loadDictionaryTables,
  DictionaryFieldIndex,
  schemaAssetPaths,
  mergeSchemaFields,
  searchMergedSchema
} from './schemaLoader';
export { extractProjectSchema } from './projectSchema';
export {
  extractXmlReferences,
  referenceTargetState,
  referenceTargetIndex
} from './xmlReferences';
export { lintSchemaTableArgs, schemaMessagesToEslint } from './schemaLint';
export {
  getOrParseXml,
  extractAndMergeMethods,
  resolveScriptIncludeReference,
  outlineScriptMethods,
  methodSourceExcerpt
} from './lazyParse';
export {
  extractCallCandidates,
  buildCachedDependencies,
  mergeDependencyEdges,
  queryDependencies
} from './dependencies';
export {
  pickCanonicalRecord,
  parseExportRecordRow,
  aggregateRecords,
  readExportRecord,
  RECORD_EXCERPT_CHARS
} from './recordDetail';
export { loadWorkspaceSnapshot, syncWorkspaceCache } from './workspaceCache';
export { getRuntimeRegistry, getRuntimeFieldIndex, ensureStaticLoaded } from './runtime';
export {
  attachScriptingDocs,
  scriptingLookupFromRegistry
} from './scriptingKnowledge';
