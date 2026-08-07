# ServiceNow XML Colorize + Lint

Cursor / VS Code extension that:

1. **Colorizes** JavaScript inside ServiceNow script CDATA fields (`script`, `client_script_v2`, `script_true`, `script_false`)
2. **Lints** that embedded JS with ESLint (ServiceNow globals, ES2022)
3. **Validates XML by document kind** — classifies the file, then applies kind-specific structural rules
4. **Optional Records navigator** — browse and search by record name (e.g. `CompareRowForm`) instead of `{table}_{sys_id}.xml`

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
- Per-table dictionary field schemas
- Live instance schema
- Macroponent JSON semantic validation
- Marketplace publish
- Depending on repo `index.json` for the navigator
