# Reference data for local MCP servers

Bundled under this folder and synced to `~/.cursor/servicenow-xml/data/` on Cursor helper install.

| File | MCP server | Purpose |
|------|------------|---------|
| `sys_dictionary.csv.gz` | **servicenow-xml-db-schema** | Instance `sys_dictionary` export |
| `scripting_reference.json.gz` | **servicenow-xml-scripting** | Server APIs, browser runtime catalog/items, snippets, undocumented notes |

## sys_dictionary CSV refresh

On a ServiceNow instance, open (or download):

```text
/sys_dictionary_list.do?sysparm_query=sys_scope.sys_class_name!=sys_app^ORsys_scopeISEMPTY&CSV&sysparm_default_export_fields=all
```

Replace `{custom scope names}` with a comma-separated list of scoped app **scope** values to exclude (for example `x_prefix_scope,x_prefix_scope2`). The `ORsys_scopeISEMPTY` clause keeps global and empty-scope dictionary rows.

### Packaging

1. Save the CSV from the URL above.
2. Gzip it to `sys_dictionary.csv.gz` in this folder (Windows list CSV is typically **cp1252**).
3. Rebuild / reinstall Cursor helpers so `~/.cursor/servicenow-xml/data/sys_dictionary.csv.gz` updates.

The MCP reads the gzip directly via `SCHEMA_CSV_PATH` and returns normalized JSON (`list_tables`, `get_table`, `list_columns`, `search_schema`) plus optional raw rows (`get_dictionary_rows`).

## Scripting reference pack

Source workbook is a multi-sheet Excel guide (cover, runtime catalog/items, server globals, useful scripts, undocumented APIs, UI Builder examples). Pack it into MCP-ready JSON:

```bash
python scripts/pack-scripting-reference.py "path/to/ServiceNow scripting reference.xlsx"
```

Writes `scripting_reference.json.gz` here (UTF-8 JSON, presentation rows stripped, snake_case fields). Rebuild / reinstall Cursor helpers so `SCRIPTING_REF_PATH` picks up the new file.

The scripting MCP exposes `get_scripting_meta`, `list_scripting_sections`, `get_scripting_section`, `lookup_scripting_name`, `search_scripting_reference`, and `list_runtime_items`.
