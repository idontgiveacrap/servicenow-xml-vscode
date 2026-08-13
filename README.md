# ServiceNow XML Colorize + Lint

Cursor / VS Code extension that:

1. **Colorizes** JavaScript inside ServiceNow script CDATA fields (`script`, `client_script_v2`, `script_true`, `script_false`)
2. **Lints** that embedded JS with ESLint (ServiceNow globals, ES2022)
3. **Validates XML by document kind** — classifies the file, then applies kind-specific structural rules
4. **Optional Records navigator** — browse and search by record name (e.g. `CompareRowForm`) instead of `{table}_{sys_id}.xml`
5. **Cursor helpers (optional)** — ServiceNow MCP servers, user rules, and repo indexer (no-op in VS Code)

## Install (Cursor)

1. Build a VSIX (from this repo):

```bash
npm install
npm run package
```

2. In Cursor: **Extensions** → `…` → **Install from VSIX…** → select the generated `.vsix`
3. Open a ServiceNow app workspace (see below); open a `*.xml` export and check the status bar for `SN XML: …` and the Problems panel for diagnostics

## Workspace gate

Diagnostics/lint and the ServiceNow activity-bar Records view stay inactive until the workspace contains a marker file:

`{sys_id}/sys_app_{sys_id}.xml`

(same 32-hex id in the folder name and filename; may appear anywhere under the workspace, not only at the root). Paths matching `ignoreGlobs` do not count.

Set `servicenowXml.enabledForAllWindows` to `true` to bypass that gate — useful for single-file windows (e.g. a one-off under Downloads) where there is no project folder layout. With the bypass on, open XML is still considered for linting, and the Records view remains available.

`servicenowXml.enable` still toggles diagnostics after the gate (or bypass) passes.

## Records navigator (optional, lazy)

Hidden until the workspace gate passes (or `enabledForAllWindows` is on). Disabled by default even then. **No workspace scan, watchers, or index memory until you enable it and open the view (or run Go to Record).**

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
| `servicenowXml.enable` | `true` | Enable ServiceNow XML validation and JS linting when the workspace gate passes (or `enabledForAllWindows` is on). |
| `servicenowXml.enabledForAllWindows` | `false` | Bypass the ServiceNow app workspace gate so diagnostics run in any window (including single-file / non-project windows) and the Records navigator stays visible. |
| `servicenowXml.lintJavaScript` | `true` | Lint embedded JavaScript in script CDATA regions. |
| `servicenowXml.lintJson` | `true` | Lint JSON embedded in known ServiceNow XML fields. |
| `servicenowXml.ignoreGlobs` | `["**/author_elective_update/**"]` | Glob patterns for XML paths to skip (validation, lint, navigator, and gate marker). |
| `servicenowXml.debounceMs` | `400` | Debounce delay (ms) before re-validating on edit. |
| `servicenowXml.navigator.enable` | `false` | Enable the ServiceNow Records navigator. No indexing runs until the view is opened or Go to Record is used. |
| `servicenowXml.navigator.excludeDelete` | `false` | Hide `action=DELETE` records from the navigator. |
| `servicenowXml.navigator.sortBy` | `mostOpened` | Sort order for Records navigator tables and records: `mostOpened`, `recentlyOpened`, `recentlyUpdated`, `sysModCount`, `name`. |
| `servicenowXml.cursorHelpers.enable` | `true` | **Cursor only.** On activate, idempotently install ServiceNow MCP servers, user rules, and the Python repo indexer. No-op in VS Code. |
| `servicenowXml.cursorHelpers.installIndexHook` | `true` | **Cursor only.** Add/update a user `sessionStart` hook that refreshes `index.json` when stale for ServiceNow export workspaces. |
| `servicenowXml.cursorHelpers.pythonPath` | `python` | Python executable for the indexer, DB schema MCP, and sessionStart hook. |

## Cursor helpers (Cursor only)

On activation in Cursor (or via **ServiceNow XML: Install Cursor Helpers**), the extension installs into `~/.cursor/servicenow-xml/` (`%USERPROFILE%\.cursor\servicenow-xml\` on Windows):

| Piece | Path under `~/.cursor/servicenow-xml/` |
|-------|----------------------------------------|
| **Indexer** | `scripts/servicenow_repo_index.py` |
| **DB schema MCP script** | `scripts/db_schema_mcp_server.py` |
| **DB schema data** | `data/sys_dictionary.csv.gz` (copied from the VSIX; see refresh URL below) |
| **sessionStart hook** | `hooks/session_start_index.py` |
| **Plugin (rules)** | `plugin/rules/servicenow-xml-*.mdc` |
| **MCP servers** | Registered in-process as `servicenow-xml-docs`, `servicenow-xml-ui-examples`, `servicenow-xml-db-schema` |
| **User rules** | Also synced to `~/.cursor/rules/servicenow-xml-*.mdc` (`<!-- managed-by: servicenow-xml -->`) |
| **Cursor plugin** | `plugin/` registered as `servicenow-xml` |

### DB schema CSV refresh URL

The schema MCP is backed by a `sys_dictionary` list CSV export. To refresh the bundled file from an instance:

```text
/sys_dictionary_list.do?sysparm_query=sys_scope.sys_class_name!=sys_app^ORsys_scopeISEMPTY&CSV&sysparm_default_export_fields=all
```

Replace `{custom scope names}` with comma-separated scope values to exclude. Keep `ORsys_scopeISEMPTY` so global dictionary rows remain. Gzip the downloaded CSV to `cursor-plugins/servicenow-xml/data/sys_dictionary.csv.gz`, then rebuild/reinstall helpers.

Helpers may be installed with the (Ctrl+Shift+P) command **ServiceNow XML: Install Cursor Helpers**. After install (or when helpers change on activation), the extension suggests **Developer: Reload Window** (Ctrl+Shift+P) so MCP servers and rules take effect.

If the configured Python cannot `import mcp.server.fastmcp`, helper install runs `python -m pip install --user mcp` (prompts when you use **Install Cursor Helpers**; auto-installs on normal activation). If Python itself is missing, those steps and the DB schema MCP / index hook are skipped; lint, colorize, and the Records navigator keep working. Python 3 is a prerequisite for a custom MCP server and a repo indexer script that intends to save tokens on repo questions.

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

## Non-goals (v1)

- Renaming Explorer filenames or editor tabs
- Live instance schema (use `snc` or refresh the bundled CSV export)
- Macroponent JSON semantic validation
- Marketplace publish
- Depending on repo `index.json` for the navigator
