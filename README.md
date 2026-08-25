# ServiceNow XML Colorize + Lint

Cursor / VS Code extension that:

1. **Colorizes** JavaScript inside ServiceNow script CDATA fields (`script`, `client_script_v2`, `script_true`, `script_false`)
2. **Lints** that embedded JS with ESLint (ServiceNow globals, ES2022), across every script-typed field in the bundled dictionary table
3. **Validates XML by document kind** — classifies the file, then applies kind-specific structural rules
4. **Edits embedded scripts** — right-click any script, however it is encoded (CDATA, entity-escaped, nested inside an update-set `<payload>`, or inside a JSON string), edit it in a temp JS tab, and save to write it back through the same encodings
5. **Optional Records navigator** — browse and search by record name (e.g. `CompareRowForm`) instead of `{table}_{sys_id}.xml`
6. **Cursor helpers (optional)** — ServiceNow MCP servers, user rules, and repo indexer (no-op in VS Code)

## Install (Cursor)

1. Build a VSIX (from this repo):

```bash
npm install
npm run package
```

2. In Cursor: **Extensions** → `…` → **Install from VSIX…** → select the generated `.vsix`
3. Open a ServiceNow app workspace (see below); open a `*.xml` export and check the status bar for `SN XML: …` and the Problems panel for diagnostics

## Gates

Two gates decide what runs. Workspace-wide features need the **workspace gate**; per-file features also accept the **document gate**.

### Workspace gate

The ServiceNow activity-bar Records view and navigator indexing stay inactive until the workspace contains a marker file:

`{sys_id}/sys_app_{sys_id}.xml`

(same 32-hex id in the folder name and filename; may appear anywhere under the workspace, not only at the root). Paths matching `ignoreGlobs` do not count.

Set `servicenowXml.enabledForAllWindows` to `true` to bypass it — this makes **every** open XML file in scope, whether or not it looks like a ServiceNow export.

### Document gate

Classification, structure diagnostics, and embedded JS/JSON lint also run for any single document that looks like a ServiceNow export, with no marker and no folder required. That covers the common one-off: open a retrieved update set straight from Downloads in a window with no project.

A document passes when its language is XML and either:

- the basename follows the export convention `{table}_{32-hex}.xml`, or
- an export root or record table (`<unload>`, `<record_update>`, `<sys_update_xml>`, `<sys_remote_update_set>`, `<sys_update_set>`) appears near the top of the buffer

Matching is on file shape rather than on a successful classification, so a truncated or malformed export still reaches the parser and reports its well-formedness and structure errors instead of going silent.

`ignoreGlobs` still applies, and `servicenowXml.enable` still toggles diagnostics after either gate passes.

Two things are weaker in a folderless window: the `{sys_id}/sys_app_{sys_id}.xml` marker cannot be found, so cross-checks that compare a payload's `sys_scope` / `sys_package` against the workspace application are skipped. Update sets are unaffected, because they use their own `<application>` value as the container id.

### What the document gate does not enable

Navigator indexing, Go to Record, workspace symbols, and the Cursor helpers all need a folder to scan and stay workspace-gated. The Records view becomes *visible* when an export-shaped file is open, but it can only list records the workspace scan found — see [Records navigator](#records-navigator-optional-lazy).

## Embedded script editor

Right-click anywhere inside a script — or run **ServiceNow XML: Edit Embedded Script…** with the caret there.

1. The script opens in a side JS tab (wrapper stripped)
2. Save the temp tab to splice the re-encoded script back into the XML
3. Save the XML file to clear the write-back draft

### What it finds

Detection is by content, not by field name. The command walks inward from the click position, peeling one encoding at a time — CDATA, XML entity escaping, a nested `record_update` document inside a `<payload>`, a JSON string value, a `javascript(…)` wrapper — and stops when what is left reads as code. Write-back re-applies the same stack in reverse, so a script buried in an entity-encoded payload round-trips without hand-written cases for each combination.

"Reads as code" means the text parses as JavaScript **and** contains a function, class, variable declaration, assignment, call, or control-flow statement. Parsing alone is not enough: `general`, `true`, `300000`, and sys_ids starting with a letter are all valid JavaScript programs, and are ordinary values of non-script fields. A lone call still counts, because `response.sendRedirect(…)` is the entire body of a real `sys_ui_page` processing script.

Consequences worth knowing:

| Situation | Behavior |
|-----------|----------|
| Caret on markup between fields | Nothing opens — the offset is on structure, not a value |
| Caret in a scalar field (`<category>general</category>`) | Nothing opens |
| Script field that is empty or a single literal | Nothing opens |
| CDATA script that builds HTML strings | Opens; CDATA is exempt from the markup check |
| Encoding differs from ServiceNow's own | Write-back is not byte-identical, only equivalent — entity style may change (`&#39;` becomes `'`) |

If write-back cannot re-encode (for example the edit introduces `]]>` inside CDATA), it refuses and saves a draft rather than writing. After a successful splice it re-reads the result through the same layer walk and fails to a draft if what comes back is not what was typed.

If write-back fails (stale host, encoding, etc.), the edited script is stored under `.servicenow-xml/json-string-drafts/` (the extension ensures `.gitignore` includes `.servicenow-xml/`). Re-opening the same string prompts **Use Draft** / **Reset to XML** / **Cancel**.

## Records navigator (optional, lazy)

Hidden until the workspace gate passes, an export-shaped XML file is open, or `enabledForAllWindows` is on. Disabled by default even then. **No workspace scan, watchers, or index memory until you enable it and open the view (or run Go to Record).**

Records come from a scan of workspace XML files, so a window with no folder open shows the view with a welcome message rather than a tree — the open file itself is not indexed. Indexing open documents as a second catalog source is planned but not implemented; see [Deferred](#deferred).

1. Set `servicenowXml.navigator.enable` to `true` (or click **Enable ServiceNow Records navigator…** in the ServiceNow activity bar view)
2. Open the **ServiceNow** activity icon → **Records**
3. Browse by table → record name, or run **ServiceNow XML: Go to Record**
4. Workspace symbol search (**Go to Symbol in Workspace**) also uses the same catalog once the navigator is enabled and a search runs
5. Right-click a record for **Reveal in Explorer** (VS Code sidebar) or **Reveal in File Explorer** (OS file browser)

### How search works

There is no separate custom search UI beyond the tree. Two entry points share the same in-memory catalog:

| Entry | How to open | Behavior |
|-------|-------------|----------|
| **Go to Record** | Command Palette → `ServiceNow XML: Go to Record` | QuickPick over indexed records. Type to filter by display name, table, `table.name`, `api_name`, `sys_id`, or relative path. Shows up to 200 matches. Selecting opens the XML file. |
| **Workspace symbols** | `Ctrl+T` / **Go to Symbol in Workspace** | Same filters. Only runs after the navigator is enabled and you type a non-empty query (opening the picker alone does not index). |

The catalog is built by scanning workspace `*.xml` (honoring `ignoreGlobs`), extracting primary record rows, and caching results until refresh / file-watch updates.

Refresh via the view title bar or **ServiceNow XML: Refresh Records Navigator**.

### Sort order

Default is **most opened**. Change via the sort icon on the Records view title, the **ServiceNow XML: Sort Records By…** command, or `servicenowXml.navigator.sortBy`:

| Mode | Records within a table | Table folders |
|------|------------------------|---------------|
| `mostOpened` (default) | Open count ↓ | Sum of opens in the table ↓ |
| `recentlyOpened` | Last open time ↓ | Max last-open among children ↓ |
| `recentlyUpdated` | File mtime ↓ | Max mtime among children ↓ |
| `sysModCount` | `<sys_mod_count>` ↓ | Max among children ↓ |
| `name` | Display name A–Z | Table name A–Z |

Open counts / last-opened times persist in workspace state. Missing metrics sort last.

`DELETE` rows are shown by default (trash icon, struck-through label, `DELETE · {table}` description). Set `servicenowXml.navigator.excludeDelete` to `true` to hide them. Paths matching `servicenowXml.ignoreGlobs` (default: `author_elective_update`) are skipped.

### Active editor tracking

Switching tabs marks the records that came from the active file: every matching row gets an accented icon and an `In the active editor` hover line, and the first one is selected with its table folder expanded and scrolled into view.

Only one row can be *selected* — VS Code has no API to set a multi-item tree selection — so files that export several records rely on the icon accent for the rest.

Clicking a record opens the XML at that record row. The row is resolved again from the current editor text, so unsaved edits above it do not shift the destination.

Nothing is revealed when there is no visible target: navigator disabled, catalog still indexing, file not indexed, or all of its rows hidden by the active filter. Reveal is also skipped while the Records view is hidden (revealing would force the view open) and right after clicking a record in the view; the tree re-syncs when it becomes visible again.

### Git decorations

Records carry the same Git color and badge the Explorer puts on their filename — VS Code applies file decorations to any tree item backed by a file URI, so a modified export shows as `M` in the Records view too.

Table folders group records across directories, so they have no file of their own. Their state is rolled up from the record files underneath, using the built-in Git extension's data (letters, theme colors, and severity ordering copied from it, so themes stay consistent):

| Table folder shows | Meaning |
|--------------------|---------|
| Color + letter badge | Highest-severity Git status among its record files (conflict > modified > added / untracked / renamed) |
| Hover | Per-status counts, e.g. `Git: 3 Modified, 1 Untracked` |

Deletions are not rolled up to table folders, matching how Git decorations propagate in the Explorer.

This follows the standard switches — no extension-specific setting:

| Setting | Effect when off |
|---------|-----------------|
| `explorer.decorations.colors` | No Git colors in the Records view |
| `explorer.decorations.badges` | No Git letter badges in the Records view |
| `git.decorations.enabled` / `git.enabled` | No Git state at all |

Git is only contacted after the navigator has indexed records; a window that never opens the navigator never touches it. If the built-in Git extension is disabled or absent, the view renders exactly as before.

### Problem decorations (amber names are not edits)

VS Code also decorates file-backed rows from the Problems panel, and its warning color is close to the Git "modified" color. A record name turning amber with a count badge after you click it means **the file now has warnings** — diagnostics are computed lazily when a file is first opened, so they appear on first click, not because anything was written. Nothing in this extension modifies an XML file on click; the only write-back path is saving an embedded JSON script temp tab.

Telling the two apart:

| Badge | Source | Meaning |
|-------|--------|---------|
| Number | Problems panel | Error / warning count for the file |
| Letter (`M`, `U`, `A`, …) | Git | File differs from the index / HEAD |
| Dot on the editor tab | VS Code | Unsaved buffer |

Hovering a record spells the counts out (`Problems in this file: 2 warnings — …`). Counts are per **file**, so an export holding several records attributes them to every row from that file. Set `problems.decorations.enabled` to `false` to drop the coloring everywhere, or narrow what gets linted with `servicenowXml.lintJavaScript`, `servicenowXml.lintJson`, and `servicenowXml.ignoreGlobs`.

### Which fields get linted

Background lint covers the four always-on names (`script`, `client_script_v2`, `script_true`, `script_false`) plus every script-typed field in `src/kinds/scriptFields.generated.ts` — 441 `table.field` pairs over 207 distinct field names, derived from a `sys_dictionary` export.

The table is keyed by `table.field` rather than by field name because the same name is code on one table and data on another: `value` is a script on some tables and an integer on `sys_properties`, and `layout` is a script on some tables and JSON on the `sys_ux_*` ones.

Regenerate it after re-exporting the dictionary:

```bash
node scripts/pack-script-fields.js "path/to/sys_dictionary.csv"
```

Export with `internal_typeSTARTSWITHscript`; the script needs the `name`, `element`, and `internal_type` columns. Syntax colorizing is unaffected — the TextMate injection still keys off the four base names, since a grammar has no table context and would light up unrelated `<value>` fields.

Embedded-JS lint does not flag platform entry points as unused: script fields are called by ServiceNow, not from inside the field, so top-level declarations (`handler` in a UX client script, `onBefore` in a business rule, the `var X = Class.create()` a Script Include exports) and platform-supplied parameters are exempt from `no-unused-vars`. Unused locals inside functions are still reported.

Lint also includes the MIT `eslint-plugin-servicenow` platform rules for unsupported engine features and ServiceNow-specific hazards. The extension reads `<scope>` and `<js_level>` from the workspace `sys_app` export (non-global `es_latest` → ES12; `helsinki_es5` / `traditional` → ES5), uses that level for parsing and rule selection, and defaults to ES5 for global scope or when metadata is missing or unknown. Every ESLint problem includes the selected `[ES5]` or `[ES12]` level. Rules for features supported in ES12—such as Promise, typed arrays, BigInt, `.at()`, and `Object.setPrototypeOf`—only run for ES5; rules for features disallowed in both modes remain active in both.

Individual-script ES12 overrides are stored by ServiceNow in separate `sys_es_latest_script` records and are not included in normal record XML exports. Without that accompanying metadata, lint therefore follows the application mode or the ES5 fallback.

## Embedded JS globals

`no-undef` needs to know every identifier the platform supplies, or ordinary ServiceNow code lights up with errors. Three sources feed the ESLint `globals` map in `src/jsLint.ts`:

| Source | Contributes | Profile |
|--------|-------------|---------|
| `SERVER_GLOBALS` | Glide server classes, `sn_*` namespaces, `Packages` / `java`, and platform entry-point variables (`current`, `action`, `event`, `request`, …) | server |
| `CLIENT_GLOBALS` | `g_*` variables, client Glide classes (`GlideAjax`, `GlideModal`, …), Service Portal (`spModal`, `spUtil`), browser APIs | client, and merged into server |
| `src/data/scriptIncludes.json` | Script Include names from an instance export, grouped by scope | server |

### Script Include whitelist

`src/data/scriptIncludes.json` is generated from a `sys_script_include` list export and bundled into `dist/extension.js` by esbuild — no separate packaging step, and `.vscodeignore` needs no change.

How scope is applied matters, because ServiceNow does not resolve every Script Include as a bare identifier:

| Entry | Whitelisted as | Why |
|-------|----------------|-----|
| `global.ArrayUtil` | `ArrayUtil` | Global-scope Script Includes resolve by bare name from any scope |
| `sn_hr_core.HRUtil` | `sn_hr_core` | Cross-scope access is `sn_hr_core.HRUtil`, so an undefined-variable error lands on the namespace, not the class |

Scoped class names are still recorded under their scope in the JSON so a future cross-scope access check can tell whether `sn_hr_core.HRUtil` names a real record. They are deliberately **not** emitted as bare globals — doing so would hide genuine typos.

Client-callable Script Includes get no client-side global. Client code reaches them through `new GlideAjax('HelloWorld')`, where the name is a string literal `no-undef` never inspects.

Inactive Script Includes and rows whose `name` is not a valid JavaScript identifier (some `sys_script_include` records hold display text such as `Render All Table`) are dropped by the generator.

### Data shape

```json
{
  "version": 2,
  "sourceColumns": ["name", "api_name", "active", "access", "client_callable"],
  "scopes": {
    "global": {
      "names": ["ArrayUtil", "JSUtil"],
      "packagePrivate": ["JSUtil"],
      "clientCallable": []
    }
  }
}
```

`names` always exists. `packagePrivate` and `clientCallable` appear **only** when the source export carried the matching column, so a consumer can distinguish "not package-private" from "unknown" rather than treating a missing column as a negative. `sourceColumns` records what the export actually supplied.

`packagePrivate` matters for cross-scope validation: a Script Include with `access = package_private` is callable only from its own scope, and that applies to global-scope records too. Without the column the whitelist is more permissive than the platform.

### Regenerating

Export the list from an instance. `name`, `api_name`, and `active` are required; include `access` and `client_callable` so cross-scope checks have something to work with:

```text
/sys_script_include_list.do?CSV&sysparm_fields=name,sys_scope,api_name,active,access,client_callable
```

Then:

```bash
node scripts/pack-script-includes.js "path/to/sys_script_include.csv"
npm run build
```

The generator prints scope, record, and skip counts, and warns for each optional column the export omitted.

The list only covers the instance it came from. Script Includes in your own application scope are not in an out-of-box export, so re-export from an instance where the app is installed.

## Document kinds

| Kind | Recognition (v1) | Validation |
|------|------------------|------------|
| `scoped_app_record_update` | `<record_update>` / scoped unload + app metadata (`sys_scope` / `sys_update_name` / `sys_package`) | Action must be `INSERT_OR_UPDATE` or `DELETE` (error); `sys_id`; filename match; script CDATA; `sys_scope` / `sys_package` vs workspace app id (warning) |
| `data_record_export` | Record rows **without** app metadata | `sys_id` presence/format; refine further with more samples |
| `customer_update` | `sys_update_xml` / `sys_remote_update_set` / `sys_update_set` | Wrapper action must be `INSERT_OR_UPDATE` or `DELETE` (error); name/type/payload; update-set `<application>` must match member updates and payload `sys_scope` / `sys_package` (warning) |
| `unknown_sn_xml` | Well-formed XML, no kind match | Warning only |
| `not_xml` | Parse failure | XML well-formedness error |

Status bar shows the active kind so misclassification is obvious.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `servicenowXml.enable` | `true` | Enable ServiceNow XML validation and JS linting once a gate passes. |
| `servicenowXml.enabledForAllWindows` | `false` | Bypass the workspace gate so diagnostics run for **every** XML file in the window, not just export-shaped ones, and the Records view stays visible. Export-shaped single files already work without this via the document gate. |
| `servicenowXml.lintJavaScript` | `true` | Lint embedded JavaScript in script CDATA regions. |
| `servicenowXml.lintJson` | `true` | Lint JSON embedded in known ServiceNow XML fields. |
| `servicenowXml.ignoreGlobs` | `["**/author_elective_update/**"]` | Glob patterns for XML paths to skip (validation, lint, navigator, and gate marker). |
| `servicenowXml.debounceMs` | `400` | Debounce delay (ms) before re-validating on edit. |
| `servicenowXml.navigator.enable` | `false` | Enable the ServiceNow Records navigator. No indexing runs until the view is opened or Go to Record is used. |
| `servicenowXml.navigator.excludeDelete` | `false` | Hide `action=DELETE` records from the navigator. |
| `servicenowXml.navigator.sortBy` | `mostOpened` | Sort order for Records navigator tables and records: `mostOpened`, `recentlyOpened`, `recentlyUpdated`, `sysModCount`, `name`. |
| `servicenowXml.cursorHelpers.enable` | `true` | **Cursor only.** On activate, idempotently install ServiceNow MCP servers, user rules, and the Python repo indexer. No-op in VS Code. |
| `servicenowXml.cursorHelpers.installIndexHook` | `true` | **Cursor only.** Add/update a user `sessionStart` hook that refreshes `index.json` when stale for ServiceNow export workspaces. |
| `servicenowXml.cursorHelpers.pythonPath` | `python` | Python executable for the indexer, local MCP servers, and sessionStart hook. |

## Cursor helpers (Cursor only)

On activation in Cursor (or via **ServiceNow XML: Install Cursor Helpers**), the extension installs into `~/.cursor/servicenow-xml/` (`%USERPROFILE%\.cursor\servicenow-xml\` on Windows):

| Piece | Path under `~/.cursor/servicenow-xml/` |
|-------|----------------------------------------|
| **Indexer** | `scripts/servicenow_repo_index.py` |
| **DB schema MCP script** | `scripts/db_schema_mcp_server.py` |
| **Scripting MCP script** | `scripts/scripting_mcp_server.py` |
| **DB schema data** | `data/sys_dictionary.csv.gz` (copied from the VSIX; see refresh URL below) |
| **Scripting reference data** | `data/scripting_reference.json.gz` (packed from the scripting workbook) |
| **sessionStart hook** | `hooks/session_start_index.py` |
| **Plugin (rules)** | `plugin/rules/servicenow-xml-*.mdc` |
| **MCP servers** | Registered in-process as `servicenow-xml-docs`, `servicenow-xml-ui-examples`, `servicenow-xml-db-schema`, `servicenow-xml-scripting` |
| **User rules** | Also synced to `~/.cursor/rules/servicenow-xml-*.mdc` (`<!-- managed-by: servicenow-xml -->`) |
| **Cursor plugin** | `plugin/` registered as `servicenow-xml` |

### DB schema CSV refresh URL

The schema MCP is backed by a `sys_dictionary` list CSV export. To refresh the bundled file from an instance:

```text
/sys_dictionary_list.do?sysparm_query=sys_scope.sys_class_name!=sys_app^ORsys_scopeISEMPTY&CSV&sysparm_default_export_fields=all
```

Replace `{custom scope names}` with comma-separated scope values to exclude. Keep `ORsys_scopeISEMPTY` so global dictionary rows remain. Gzip the downloaded CSV to `cursor-plugins/servicenow-xml/data/sys_dictionary.csv.gz`, then rebuild/reinstall helpers.

### Scripting reference pack

```bash
python scripts/pack-scripting-reference.py "path/to/ServiceNow scripting reference.xlsx"
```

Writes `cursor-plugins/servicenow-xml/data/scripting_reference.json.gz`. Rebuild/reinstall helpers afterward.

Helpers may be installed with the (Ctrl+Shift+P) command **ServiceNow XML: Install Cursor Helpers**. After install (or when helpers change on activation), the extension suggests **Developer: Reload Window** (Ctrl+Shift+P) so MCP servers and rules take effect.

If the configured Python cannot `import mcp.server.fastmcp`, helper install runs `python -m pip install --user mcp` (prompts when you use **Install Cursor Helpers**; auto-installs on normal activation). If Python itself is missing, those steps and the local MCP servers / index hook are skipped; lint, colorize, and the Records navigator keep working. Python 3 is a prerequisite for a custom MCP server and a repo indexer script that intends to save tokens on repo questions.

A Cursor rule is included which references snc (ServiceNow CLI utility) I recommend installing it and pointing it to a PDI or non-production environment with non-sensitive data so Cursor can learn about ServiceNow the way you would and point you to exact URIs.

VS Code installs ignore this path entirely; lint/navigator behavior is unchanged.

## Fixtures

See `fixtures/` for a minimal scoped-app sample and placeholders for other kinds. Drop real examples into those folders when refining detectors.

## Adding a kind

1. Add a profile under `src/kinds/` implementing `KindProfile` (`matches` + `validate`)
2. Register it in `src/kinds/index.ts` (**order matters** — first match wins)
3. Add fixtures under `fixtures/<kind_id>/`

## Development

```bash
npm install
npm run build
# or: npm run watch
```

Press F5 in VS Code/Cursor against this folder to launch an Extension Development Host, or package a VSIX as above.

## Deferred

### Index open documents into the navigator

The document gate covers diagnostics for one-off exports, but the Records tree is still built only from a workspace scan, so a folderless window shows an empty view. Intended follow-up: a second catalog source built from open documents.

Sketch:

- Build rows with `extractRecordIdentities(document.getText(), fsPath)` — the same function `RecordCatalog.readCatalogRecords` uses, so tree rendering, sorting, reveal, and `servicenowXml.navigator.openRecord` need no changes
- Keep them in a map separate from `recordsByUri` and merge in `rebuildViews()`, skipping URIs the workspace scan already covers, so a full rescan does not drop them
- Invalidate on document open/close and debounced change instead of the file watchers, which need a workspace folder
- Untitled buffers have no `mtimeMs`; missing metrics already sort last

Known limitations to accept or solve first:

- **Usage sorting degrades.** `RecordUsageStore` persists to `workspaceState`, which is per-window when no folder is open, so open counts do not carry over and the default `mostOpened` order is effectively arbitrary there.
- **Value is uneven.** A retrieved update set has many `sys_update_xml` rows and makes a genuinely useful member browser; a single-record export produces a one-leaf tree that adds nothing over the status bar and Problems panel.

## Non-goals (v1)

- Renaming Explorer filenames or editor tabs
- Live instance schema (use `snc` or refresh the bundled CSV export)
- Macroponent JSON semantic validation
- Marketplace publish
- Depending on repo `index.json` for the navigator
