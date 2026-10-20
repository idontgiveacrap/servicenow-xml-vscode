# Reference data (legacy plugin folder)

Runtime Registry packs ship from **`src/data/`** (copied to `dist/data/` at build, then synced to `~/.cursor/servicenow-xml/data/` on Cursor helper install). This folder is no longer the install source for schema/scripting packs.

| File (under `src/data/`) | Consumed by | Purpose |
|--------------------------|-------------|---------|
| `dictionaryTables.json` / `dictionaryFields.json.gz` | **servicenow-xml-registry** | Offline schema |
| `fieldKinds.json` | Extension parse / script profile | Compact script/CSS/JSON field sets |
| `scripting_reference.json.gz` | **servicenow-xml-registry** | Server APIs, runtime catalog/items, snippets |
| `js_performance.json` | **servicenow-xml-registry** | Evidence-bounded JS benchmark comparisons |
| `platformGlobals.json` / `scriptIncludes.json` / `scopes.json` | Registry + lint | Platform APIs and SI whitelist |

Python `servicenow-xml-db-schema` and `servicenow-xml-scripting` MCP servers are **retired**; use Registry MCP tools instead.

## Dictionary pack refresh

On a ServiceNow instance, download:

```text
/sys_dictionary_list.do?sysparm_query=sys_scope.sys_class_name!=sys_app^ORsys_scopeISEMPTY&CSV&sysparm_default_export_fields=all
```

Then:

```bash
node scripts/pack-dictionary.js "path/to/sys_dictionary.csv"
```

Writes `src/data/dictionaryTables.json`, `dictionaryFields.json.gz`, and `fieldKinds.json`. Rebuild/reinstall helpers afterward. CSV is a **refresh input**, not a runtime MCP source.

## Scripting reference pack

```bash
python scripts/pack-scripting-reference.py "path/to/ServiceNow scripting reference.xlsx"
```

Writes `src/data/scripting_reference.json.gz`. Registry MCP exposes `get_scripting_meta`, section list/get, lookup/search, `list_runtime_items`, and JS performance tools.

## JavaScript performance data

`src/data/js_performance.json` — `get_js_performance_meta`, `search_js_performance`, `lookup_js_performance` on Registry MCP. Scoped `es_latest` server measurements only.
