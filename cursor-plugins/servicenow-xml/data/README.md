# sys_dictionary schema data

Bundled as `sys_dictionary.csv.gz` for the **servicenow-xml-db-schema** MCP server.

## Refresh / re-export URL

On a ServiceNow instance, open (or download):

```text
/sys_dictionary_list.do?sysparm_query=sys_scope.sys_class_name!=sys_app^ORsys_scopeISEMPTY&CSV&sysparm_default_export_fields=all
```

Replace `{custom scope names}` with a comma-separated list of scoped app **scope** values to exclude (for example `x_prefix_scope,x_prefix_scope2`). The `ORsys_scopeISEMPTY` clause keeps global and empty-scope dictionary rows.


## Packaging

1. Save the CSV from the URL above.
2. Gzip it to `sys_dictionary.csv.gz` in this folder (Windows list CSV is typically **cp1252**).
3. Rebuild / reinstall Cursor helpers so `~/.cursor/servicenow-xml/data/sys_dictionary.csv.gz` updates.

The MCP reads the gzip directly via `SCHEMA_CSV_PATH` and returns normalized JSON (`list_tables`, `get_table`, `list_columns`, `search_schema`) plus optional raw rows (`get_dictionary_rows`).
