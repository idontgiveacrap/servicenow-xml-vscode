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
3. Open a ServiceNow `*.xml` export; check the status bar for `SN XML: …` and the Problems panel for diagnostics

## Records navigator (optional, lazy)

Disabled by default. **No workspace scan, watchers, or index memory until you enable it and open the view (or run Go to Record).**

1. Set `servicenowXml.navigator.enable` to `true` (or click **Enable ServiceNow Records navigator…** in the ServiceNow activity bar view)
2. Open the **ServiceNow** activity icon → **Records**
3. Browse by table → record name, or run **ServiceNow XML: Go to Record**
4. Workspace symbol search (Go to Symbol in Workspace) also uses the same catalog once the navigator is enabled and a search runs

Refresh via the view title bar or **ServiceNow XML: Refresh Records Navigator**.

`DELETE` rows are hidden unless `servicenowXml.navigator.includeDelete` is `true`. Paths matching `servicenowXml.ignoreGlobs` (default: `author_elective_update`) are skipped.

## Document kinds

| Kind | Recognition (v1) | Validation |
|------|------------------|------------|
| `scoped_app_record_update` | `<record_update>` / scoped unload + app metadata (`sys_scope` / `sys_update_name` / `sys_package`) | Action values, `sys_id`, filename `{table}_{sys_id}.xml` match, script CDATA |
| `data_record_export` | Record rows **without** app metadata | `sys_id` presence/format; refine further with more samples |
| `customer_update` | `sys_update_xml` / `sys_remote_update_set` / `sys_update_set` | Name/type/payload CDATA, nested payload XML, remote set refs |
| `unknown_sn_xml` | Well-formed XML, no kind match | Warning only |
| `not_xml` | Parse failure | XML well-formedness error |

Status bar shows the active kind so misclassification is obvious.

## Settings

| Setting | Default | Purpose |
|---------|---------|---------|
| `servicenowXml.enable` | `true` | Toggle diagnostics |
| `servicenowXml.lintJavaScript` | `true` | Lint embedded script fields |
| `servicenowXml.lintJson` | `true` | Lint embedded JSON fields |
| `servicenowXml.ignoreGlobs` | `**/author_elective_update/**` | Skip paths for diagnostics, lint, and navigator |
| `servicenowXml.debounceMs` | `400` | Edit debounce |
| `servicenowXml.navigator.enable` | `false` | Opt-in Records navigator |
| `servicenowXml.navigator.includeDelete` | `false` | Show DELETE rows in navigator |

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
