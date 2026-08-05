# ServiceNow XML Colorize + Lint

Cursor / VS Code extension that:

1. **Colorizes** JavaScript inside ServiceNow script CDATA fields (`script`, `client_script_v2`, `script_true`, `script_false`)
2. **Lints** that embedded JS with ESLint (ServiceNow globals, ES2022)
3. **Validates XML by document kind** — classifies the file, then applies kind-specific structural rules

## Install (Cursor)

1. Build a VSIX (from this repo):

```bash
npm install
npm run package
```

2. In Cursor: **Extensions** → `…` → **Install from VSIX…** → select the generated `.vsix`
3. Open a ServiceNow `*.xml` export; check the status bar for `SN XML: …` and the Problems panel for diagnostics

## Document kinds

| Kind | Recognition (v1) | Validation |
|------|------------------|------------|
| `scoped_app_record_update` | `<record_update>` + rows with app metadata (`sys_scope` / `sys_update_name` / `sys_package`) | Action values, `sys_id`, filename `{table}_{sys_id}.xml` match, script CDATA |
| `data_record_export` | Record rows **without** app metadata | Minimal `sys_id` checks; full rules pending examples |
| `customer_update` | Update-set / `sys_update_xml` / related markers | Heuristic only; rules pending examples |
| `unknown_sn_xml` | Well-formed XML, no kind match | Warning only |
| `not_xml` | Parse failure | XML well-formedness error |

Status bar shows the active kind so misclassification is obvious.

## Settings

| Setting | Default | Purpose |
|---------|---------|---------|
| `servicenowXml.enable` | `true` | Toggle diagnostics |
| `servicenowXml.lintJavaScript` | `true` | Lint embedded script fields |
| `servicenowXml.ignoreGlobs` | `**/author_elective_update/**` | Skip diagnostics for matching paths |
| `servicenowXml.debounceMs` | `300` | Edit debounce |

## Fixtures

See [`fixtures/`](fixtures/) for a minimal scoped-app sample and placeholders for other kinds. Drop real examples into those folders when refining detectors.

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

- Per-table dictionary field schemas
- Live instance schema
- Macroponent JSON semantic validation
- Marketplace publish
