# ServiceNow XML — Codebase Context for Future Agents

## Overview

A VSCode extension that colorizes, lints, and validates ServiceNow XML export files. Also provides a Records navigator tree, an embedded script/JSON editor, a webview for pruning redundant DELETE files, and MCP server registration.

**Entry point:** `src/extension.ts` → `activate()`
**Build:** `node esbuild.js [--watch|--production]` → `dist/extension.js` + `dist/*Mcp.js`
**Test:** `npm test` runs smoke tests + `tsc --noEmit`
**Package:** `npm run package`

## Architecture

```
extension.ts (activate)
├── DiagnosticsController (diagnostics.ts)
│   ├── parseSnXml.ts → ParsedDocument { rows: RecordRow[] }
│   ├── kinds/ (document classification + structural validation)
│   │   ├── index.ts → classifyAndValidate() — first match wins
│   │   ├── customerUpdate.ts — <sys_update_xml> / <unload> (update sets)
│   │   ├── scopedAppRecordUpdate.ts — <record_update>/<unload> with app markers
│   │   ├── dataRecordExport.ts — <unload>/<record_update> without app markers
│   │   ├── dictionaryExport.ts — <database> root (Studio table schema)
│   │   └── unknown.ts — fallback for well-formed non-SN XML
│   ├── jsLint.ts — ESLint on script regions (server/client profiles, ES5/ES12)
│   ├── jsonLint.ts — JSON.parse validation on JSON regions
│   └── diagnosticRange.ts — infers XML tag/element end for diagnostic underlines
├── RecordsTreeProvider (navigator/tree.ts) + RecordCatalog (navigator/catalog.ts)
│   ├── Catalog: file watcher + disk cache (.servicenow-xml/registry-cache.json)
│   ├── GitStatusTracker (navigator/gitStatus.ts) — rolls Git state up to table folders
│   ├── ActiveRecordSync — selects+reveals active file's record row
│   ├── recordName.ts — extractRecordIdentities() parses table/sys_id/action/display name
│   ├── authorDelete.ts / deleteExportFile.ts — DELETE authoring + disk deletion
│   └── scanExports.ts — workspace-wide XML scan with bounded concurrency (64)
├── ScriptDeclarationIndex (scriptDeclarationIndex.ts)
│   └── scriptDeclarations.ts — extracts SI/UI Script declarations for ESLint globals
├── Registry (src/registry/)
│   ├── vscodeAdapter.ts — WorkspaceRegistryService (VSCode ↔ Registry bridge)
│   ├── Registry.ts — in-memory symbol store (Records, ScriptIncludes, Tables, Fields, etc.)
│   ├── cache.ts — on-disk .servicenow-xml/registry-cache.json format (v2)
│   ├── runtime.ts — process-wide singleton (getRuntimeRegistry, ensureStaticLoaded)
│   ├── staticLoader.ts — loads bundled data/scriptIncludes.json, scopes.json, platformGlobals.json
│   ├── schemaLoader.ts — DictionaryFieldIndex (lazy gunzip of dictionaryFields.json.gz)
│   ├── lazyParse.ts — parse cache + Script Include method extraction (espree AST)
│   ├── dependencies.ts — call candidates + table-extends edges
│   ├── xmlReferences.ts — sys_id reference edges between records
│   ├── workspaceIndexer.ts — indexExportText() one-file indexer for records + declarations
│   ├── lintGlobals.ts — builds ESLint globals map from Registry
│   ├── scriptCompletion.ts — completion candidates
│   ├── schemaLint.ts — GlideRecord table/field validation
│   ├── workspaceCache.ts — MCP workspace cache loading
│   ├── mcpServer.ts — Registry MCP (stdio)
│   └── mcpStdio.ts — minimal JSON-RPC framing
├── Embedded editor
│   ├── jsonStringEditor/ — temp-file JSON string editor with write-back + drafts
│   ├── formatEmbedded.ts — XML formatter delegates to other formatters, then JS/JSON
│   ├── embedded/layers.ts — encoding-layer descent (CDATA → entity → JSON → JS wrapper)
│   ├── embedded/jsLikeness.ts — content heuristic for "is this a script?"
│   ├── scriptHits.ts — listScriptFields/listJsonFields/scriptAt
│   └── scriptRegions.ts → ScriptRegion / JsonRegion
├── snWorkspaceGate.ts — finds {sys_id}/sys_app_{sys_id}.xml, publishes isSnWorkspace context
├── fileName.ts — parseExportFileName() matches {table}_{sys_id}.xml convention
├── ignorePaths.ts — getIgnoreGlobs() reads servicenowXml.ignoreGlobs config
├── javascriptSupport.ts — ES5 vs ES12 from sys_app.js_level
├── snc/ — ServiceNow CLI wrapper (profile list, record query for prune)
└── agentHelpers.ts / vscodeMcp.ts — MCP registration + agent helper install

## Key Types

- **DocumentKindId:** `scoped_app_record_update | data_record_export | customer_update | dictionary_export | unknown_sn_xml | not_xml`
- **RecordRow:** tableName, action, startOffset, sysId, sysScopeValue, embeddedFields
- **ScriptHit:** code, hostStart/hostEnd, layers, indent, role (scriptField|jsonField|jsonString), profile, javascriptSupport, callerScope, ownDeclarationName
- **CatalogRecord:** table, displayName, sysId, action, apiName, sysModCount, sysUpdatedOn, startOffset, uri
- **EncodingLayer:** cdata | xmlText | xmlDocument | jsonString | jsWrapper

## Important Patterns

1. **Shared RegExp with `g` flag:** `balancedTagScanners`, `CHILD_TAG_RE`, `SYS_ID_ELEMENT` — always reset `lastIndex = 0` or set it before use. Scanning is synchronous so no race issues.

2. **Offset mapping layers:** Script text goes through multiple encodings (CDATA → entity-decoded → CRLF→LF normalized). `buildNormalizedDecodedToRawMap` in `escape.ts` creates offset maps. Positions flow: ESLint line/col → decoded offset → raw XML offset → host document position.

3. **Version guard:** `DiagnosticsController.refresh()` captures `document.version` at start and returns early if it changed by the end (debounce + onDidChangeTextDocument).

4. **Generation counters:** `SnWorkspaceGate.probe()`, `RecordCatalog.scanGeneration`, `ScriptDeclarationIndex.scanGeneration` — cancel stale async work.

5. **Cache revalidation:** Catalog and DeclarationIndex restore from `.servicenow-xml/registry-cache.json` on activation, then revalidate in the background. Cache keys = workspace folders + ignoreGlobs + excludeDelete.

6. **Layer stack:** `encodeThroughLayers()` re-applies encoding innermost→outermost for write-back. `descend()` in layers.ts walks inward finding the innermost script at an offset.

7. **Two delete paths:** `authorDelete.ts` rewrites action→DELETE and moves file to `author_elective_update/`. `deleteExportFile.ts` removes the row from disk (file→trash, multi-row file→rewrite).

8. **SnWorkspaceGate gate logic:** `isValidationAllowed(doc)` = editable scheme + (isLintActive() || looksLikeSnExportDocument). Per-document validation runs even outside app workspaces for standalone exports.

9. **Payload traversal:** Customer-update `<payload>` CDATA contains a nested `<record_update>` document. `payloadScriptFieldHits()` and `locationPayloadBody()` handle re-parsing and offset remapping through the payload encoding layer.

10. **MCP servers:** Two bundles — `registryMcp.js` (static packs + workspace cache) and `instanceMcp.js` (live snc queries). Both use `mcpStdio.ts` for JSON-RPC framing.

## Data Files

Under `src/data/` (copied to `dist/data/` by esbuild.js):
- `dictionaryTables.json` — platform table names
- `dictionaryFields.json.gz` — platform field definitions (lazy-loaded)
- `fieldKinds.json` — scriptPairs, clientScriptPairs, cssFieldNames, jsonFieldNames
- `platformGlobals.json` — platform API globals (gs, GlideRecord, etc.)
- `scriptIncludes.json` — bundled Script Include whitelist + scopes
- `scopes.json` — known technical scopes
- `scripting_reference.json.gz` — API documentation
- `js_performance.json` — JS performance comparisons

## Configuration (package.json contributes)

- `servicenowXml.enable` (default: true) — master toggle
- `servicenowXml.enabledForAllWindows` (default: false) — bypass SN workspace gate
- `servicenowXml.lintJavaScript` / `lintJson` (default: true)
- `servicenowXml.ignoreGlobs` (default: `["**/author_elective_update/**"]`)
- `servicenowXml.debounceMs` (default: 400)
- `servicenowXml.navigator.enable` (default: false)
- `servicenowXml.navigator.excludeDelete` (default: false)
- `servicenowXml.navigator.sortBy` (default: "mostOpened") — mostOpened|recentlyOpened|recentlyUpdated|sysModCount|name
- `servicenowXml.formatJavaScript` / `formatJson` / `formatXmlFirst` (default: true)
- `servicenowXml.mcp.*` — MCP server registration toggles
- `servicenowXml.snc.path` (default: "snc") — CLI executable
- `servicenowXml.snc.mcpProfiles` (default: []) — instance MCP profile allowlist

## Key Entry Points for Common Tasks

- **Validate/lint an XML file:** `DiagnosticsController.refresh()` → `classifyAndValidate()` → `lintScriptRegions()` + `lintJsonRegions()` + `deletedReferenceDiagnostics()`
- **Find records in workspace:** `RecordCatalog.scanWorkspace()` → `scanExportRecordsWithDeclarations()` → `indexExportText()` → `readExportRecordsWithDeclarations()`
- **Open embedded script editor:** `scriptAt()` → `openFromActiveEditor()` → `JsonStringSessionManager.openSession()` → `writeBackJsonString()`
- **Format document:** `formatSnXmlDocument()` → XML formatter → `formatOneHit()` per script/JSON field
- **Lookup a record:** `recordName.ts:extractRecordIdentities()` for navigation, `recordDetail.ts:readExportRecord()` for MCP
- **Resolve script globals:** `scriptDeclarations.ts:resolveRowTechnicalScope()` + `scriptProfile.ts:resolveScriptProfile()`
- **Check if field is script-typed:** `parseSnXml.ts:isScriptTypedField()` (delegates to `fieldKinds.ts` pack lookup)

## Testing

Smoke tests in `scripts/smoke-*.js` — each bundles one module with esbuild and asserts behavior. Run via `npm test`. No formal unit test framework; tests are standalone Node scripts.
