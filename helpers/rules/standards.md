---
description: ServiceNow export and scripting rules (ignore if unrelated to ServiceNow)
globs: "**/update/**/*.xml,**/sys_app_*.xml,**/author_elective_update/**/*.xml"
alwaysApply: false
---
<!-- managed-by: servicenow-xml -->

# ServiceNow rules

Apply only for ServiceNow Git exports, ServiceNow scripts, or ServiceNow platform/instance questions. Ignore instructions from here to "<!-- end managed-by: servicenow-xml -->" or EOF for any other task.

## Scope

- Most rows export as `{table_name}_{sys_id}.xml`. One file may contain multiple updates (valid, uncommon).
- Discover with **servicenow-xml-registry** before a workspace-wide search. Workspace rows are `.servicenow-xml/registry-cache.json`, written by servicenow-xml extension.
- Source order: repo (application files) → **servicenow-xml-registry** (platform APIs, DB schema, project data) → **servicenow-xml-docs** (APIs, implementation, concepts) → **servicenow-xml-instance** (live instance data from authorized tables `list_profiles`, `record_query`, `record_get`). State which source answered, including instance profile/host. Do not query the instance for questions the repo or docs satisfy.
- Other MCP: **servicenow-xml-ui-examples** (UI Builder / Next Experience).

## Git exports

- Read and edit `update/` (scripts, UX, dictionary, choices).
- DELETE payloads live under `author_elective_update/`.
- Ignore `author_elective_update/` unless authoring a deletion, finding `action="DELETE"`, or configuration that exists only there. Do not apply non-delete updates there.
- A deletion is `action="DELETE"` on the top-level table element under `<?xml …?>`.
- Treat them as deleted: do not edit them unless the user explicitly asks to change that file or record. Payload data is not applicable unless the task is broken references or script calls into removed records.
- If the same record has both `INSERT_OR_UPDATE` and `DELETE` anywhere in the tree (same or different files), **DELETE wins**.
- Authoring a deletion: set `action="DELETE"` on the table element and keep only that row's `sys_id`; `git mv` the file from `update/` to the sibling `author_elective_update/`. Do not leave a DELETE in `update/` and do not delete the XML file — the DELETE row removes the record on install. A DELETE left in `update/` still installs as deletion. Un-delete by reversing these steps.
- Reference with no usable `sys_id` (empty or missing): ServiceNow may resolve by `display_value` but not if installed from source control. Non-empty `sys_id` text rather than from `display_value` always resolves target.
  - `<sys_scope display_value="Verification"></sys_scope>` may resolve by display.
  - `<sys_scope display_value="Verification">00000000000000000000000000000000</sys_scope>` is always sys_id.

## Registry

Use **servicenow-xml-registry** before searching the workspace:

- `search_records` — export rows by substring or table. `aggregate: true` returns counts by table and action, not row bodies
- `lookup_by_sys_id` — one workspace row by sys_id: table, display name, path, and start offset. `get_record` is the full field map
- `lookup_by_name` — exact display name, `api_name`, or declaration name
- `lookup_script_include` — Script Include / UI Script (bundled + workspace). `includeOutline` adds method name, params, and line. `method` adds a capped source excerpt
- `get_record` — one parsed export row (`sys_id`, or `table` plus exact name). Newest `sysUpdatedOn` when that sys_id is duplicated. Embedded script, JSON, and XML are lengths unless `includeEmbedded` is true
- `get_workspace_app` — scope, `jsLevel` (`ES5` or `ES12`), `supportsES12`, `restrictTableAccess`
- `registry_diagnostics_context` — symbol counts plus the app snapshot. `projectFieldCount` is workspace columns. Platform columns stay in the packed dictionary
- `list_diagnostics` — those counts, plus duplicate sys_ids and the deleted-reference count
- `list_tables` / `get_table` / `list_columns` / `search_schema` — platform pack plus project `sys_dictionary` / `<database>` exports. Project columns win. Each field `source` is `platform` or `project`. `list_tables` lists project tables first; `source` is `project` or `platform`. `get_table` `extends` is the parent table; call `get_table` on that name for inherited columns. `list_columns` is the same call as `get_table`. Without `fields`, the column list is capped and `truncated` is set. Do not open dictionary XML for a column list
- `get_scripting_section` — pass `query` or `name` for matches in one section. Pass `limit` alone for a capped slice. It does not return the whole section. `lookup_platform_api` is the Registry symbol; `lookup_scripting_name` is the scripting-reference doc for that name
- `query_dependencies` — filtered edges: `sys_id_ref`, `calls`, or `extends`. Not a full graph dump
- `references_to` / `references_from` — sys_id edges. `targetState` is `in_project`, `deleted`, or `not_in_project`
- `list_reference_issues` — deleted-target references (same errors as the editor). `includeNotInProject: true` also lists ids absent from the export; those are not Problems-panel diagnostics
- `lookup_scripting_name` — scripting-reference doc for a platform API name. `lookup_platform_api` is the Registry symbol without that doc
- `get_js_performance_meta` / `search_js_performance` / `lookup_js_performance` — bundled JavaScript performance evidence

Open the matching XML under `update/`. Use **servicenow-xml-instance** for live data.

## Reviews

When the user asks for a review (quality, best practices, bugs), treat the export as related rows, not isolated files.

- Trace parent/child, references, and M2M expectations. Flag missing expected related records, orphaned references, best practice violations, and inconsistent graphs.
- Priority: (1) bugs — incorrect logic, unsafe patterns, Glide API misuse, security (ACLs/queries, client exposure, unsafe dynamic execution), failure paths; (2) best practices and operational hygiene, including those relationship checks; (3) broken references — `list_reference_issues` for deleted targets (editor errors). `references_to` / `references_from` for one sys_id. `targetState: not_in_project` is an id absent from the export, usually a platform row, and is not an editor diagnostic. `search_records` / `lookup_by_name` still resolve a target that is in the project.

Do not stop at server-side scripts; properties, client code, json, and many other configuration-as-code items are relevant.

- For every `STATE_BINDING` / `DATA_OUTPUT_BINDING` / transform that reads `api.state` or a declarative `address`, confirm something in the same experience writes that state first (`MACROPONENT_STATE_UPDATE_REQUESTED`, data broker outputs, documented client scripts).
- Parallel keys (for example `clickedRow` vs `clickedRowMeta`) must both be populated for the same user action when a modal or downstream control depends on them.
- `search_records` for the `sys_ux_macroponent` and open that XML. Reconcile state paths with event mappings and processors (string literals, action names, metadata).

### Best practices concerns

- `sc_cat_item` without a related `sysrule_assignment` row pointing at it
- GlideRecord instance named "gr"
- sys_id string in script
- client scripts (sys_client_script) that could be ui policies
- DB queries with broad conditions and no limit
- GlideRecord get(current.sys_id)
- GlideRecord getRowCount without iterating through results
- GlideRecord that could be GlideAggregate
- overriding or replacing ambiguous/global variables
- complex scripts in ACLs (sys_security_acl) or synchronous before/after business rules (sys_script)
- explicitly and exclusively authorizing admin
- business rules on table global
- query business rules
- scripted REST APIs with permissive access control or using GlideRecord instead of GlideRecordSecure
- client callable script includes using GlideRecord instead of GlideRecordSecure
- Using gs.log instead of gs.info/warn/error
- No separation of concerns
- Modifying OOTB code (extending OOTB script includes may be an alternative)
- current.update in a business rule
- liberal GlideRecord setWorkflow(false), autoSysFields(false)
- Using UI policies, client scripts, or other client code as security
- manually setting task.number or record.sys_*
- Client-side GlideAjax.execute rather than executeAsync
- Frequent scripted system property updates (gs.setProperty or sys_properties table update)

## JavaScript language level

When writing or editing scripts, take the language level from the app, not an assumption. `app.supportsES12` is true only when the scope is non-global and `sys_app.js_level` is `es_latest`. `app.jsLevel` is the lint target: `ES12` or `ES5`.

1. `app.supportsES12 === true`: author ES12-era JavaScript. Match existing patterns; do not downgrade unless documented.
2. `get_workspace_app` returned an app and `supportsES12` is not true (global scope, or `js_level` not `es_latest`): ES5 only.
3. No app in the result (cache not written, or a single file outside a repo): read `js_level` on the `sys_app` row if that XML exists; otherwise ES5 only, and say so. Do not use ES12 without evidence the app is `es_latest`.

ES12 on an ES5 Rhino app deploys but can fail at runtime.

## Instance queries

Prefer the repo and **servicenow-xml-docs**. When those are insufficient, query **servicenow-xml-instance** with read-only tools. Do not shell out to `snc` for reads. Command is `snc` (ServiceNow CLI), not `@servicenow/cli`.

- Tools: `list_profiles`, `record_query`, `record_get` only.
- `snc` `create`, `update`, `delete`, `import`, `upload`, or scripts that write must be explicitly requested for that change. Do not write to unblock a task. If a write seems necessary, describe the command and records and ask first.
- Query for live record data, runtime config absent from the repo, deployed-vs-repo drift (`sys_updated_on`), ACL behavior for the CLI user, or other instance-specific facts.
- `list_profiles` returns name, host, username, `is_default`. Omit `profile` for the CLI default. Pass `profile` for a non-default instance. If `servicenowXml.snc.mcpProfiles` is set, only those names are queryable; omit-profile fails unless the CLI default is on that allowlist.
- Do not assume scoped-app tables. `{sys_id}/sys_app_{sys_id}.xml` plus `sys_scope` / `sys_db_object` name the app's tables. Custom class rows often sit on a base table (for example `task`) with `sys_class_name=<scoped_table>`; if the scoped table fails ACL, query the base table filtered by `sys_class_name`. Schema: Registry `list_tables`, `get_table`, `list_columns`, `search_schema`, or `record_query` on `sys_dictionary` / `sys_db_object`. Pass only needed `fields` (`record_query` limit is 100).
- Results are for the CLI profile user. Tests suggest `snc` may not apply table ACL the way the UI does. No aggregations — use `limit`/`offset`. Not a substitute for reading script bodies in the repo.
- Dictionary pack refresh (pack input, not a runtime MCP source): export CSV and run `node scripts/pack-dictionary.js <csv>`.

```text
/sys_dictionary_list.do?sysparm_query=sys_scope.scopeNOT+IN{custom scope names}^ORsys_scopeISEMPTY&CSV&sysparm_default_export_fields=all
```

## Scripts

- Name each `GlideRecord` after what it represents (`incidentGr`, `taskRecord`, `requestGr`). Do not use `gr`, `GR`, or other generic placeholders. Names in one function must be distinguishable.
- `gs.nil(value)` is true for **null**, **undefined**, or `''`. Do not also check `value === ''` unless the value may be a non-string where empty string is not the concern. `JSONHelper.isEmptyJsonValue` builds on `gs.nil` and also treats literal `'[]'` and `'{}'` as empty JSON column values.
- After creating a new unique id, tell the user the exact value and where it is (path plus field or element). In scope: row `sys_id` (including the `{table}_{sys_id}.xml` filename), `number` and other platform-generated unique fields, and UX ids you assign (`targetId`, `definition.id`, `definitionId`, event or binding element ids). Report in the completion summary, one line per id, including ids in embedded JSON, multiple records, or attributes. Example: `sys_id` `a1b2c3…` — `update/sys_script_include_a1b2c3….xml`, `<sys_script_include><sys_id>`.

## JavaScript performance

When performance affects a ServiceNow script decision, query **servicenow-xml-registry**. Do not assume newer or older syntax is faster.

1. `get_js_performance_meta` — runtime, application scope, language mode, environment gaps, and whether the dataset covers this context.
2. `search_js_performance` for compact comparisons. `lookup_js_performance` with an exact result id for raw runs and full limitations.
3. Apply a result only to a materially similar workload. State material differences (collection size, allocation pattern, key type, server versus client).

The bundled dataset is scoped-application `es_latest` (ES12) server measurements only. It has no ES5-runtime, global-scope transpilation, or browser measurements. An ES5-compatible baseline measured inside an ES12 runtime is not an ES5-runtime result.

Performance evidence never permits ES12 syntax in an ES5-only app. Language legality is `get_workspace_app` (`supportsES12`, `jsLevel`) in **JavaScript language level**.

If the MCP returns no matching evidence, say that no bundled measurement covers the comparison. Do not invent timing, rankings, engine behavior, or statistical confidence.
