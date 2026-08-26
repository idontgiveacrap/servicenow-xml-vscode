const fs = require('fs');
const path = require('path');

// Regenerates src/data/scriptIncludes.json from a sys_script_include list CSV
// export. See README ("Script Include whitelist") for the export query.
//
//   node scripts/pack-script-includes.js "path/to/sys_script_include.csv"

const OUT_PATH = path.join(__dirname, '..', 'src', 'data', 'scriptIncludes.json');
const REQUIRED_COLUMNS = ['name', 'api_name', 'active'];

// Optional columns. When present they drive the cross-scope access rules; when
// absent the whitelist stays permissive rather than guessing.
//   access          'public' | 'package_private' — package_private is callable
//                   only from its own scope, even for global-scope records
//   client_callable whether client code may reach it via GlideAjax
const OPTIONAL_COLUMNS = ['access', 'client_callable'];

/** Identifiers ESLint can accept as a global. */
const JS_IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Parse RFC 4180 CSV text into an array of row objects keyed by header name.
 * Hand-rolled because descriptions in this export contain commas, quotes, and
 * newlines, and the repo has no CSV dependency.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  // Strip a UTF-8 BOM so the first header name matches.
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  for (; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      // handled by the \n branch
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length === 0) {
    return [];
  }
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cells) => {
    const record = {};
    header.forEach((key, index) => {
      record[key] = (cells[index] ?? '').trim();
    });
    return record;
  });
}

function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    throw new Error('Usage: node scripts/pack-script-includes.js <sys_script_include.csv>');
  }
  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV not found: ${csvPath}`);
  }

  const records = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  if (records.length === 0) {
    throw new Error(`No data rows parsed from ${csvPath}`);
  }
  for (const column of REQUIRED_COLUMNS) {
    if (!(column in records[0])) {
      throw new Error(
        `CSV is missing the '${column}' column. Export name, sys_scope, api_name, and active.`
      );
    }
  }

  const presentOptional = OPTIONAL_COLUMNS.filter((column) => column in records[0]);
  const hasAccess = presentOptional.includes('access');
  const hasClientCallable = presentOptional.includes('client_callable');

  /**
   * @type {Map<string, {names: Set<string>, packagePrivate: Set<string>, clientCallable: Set<string>}>}
   * scope technical name -> membership sets
   */
  const byScope = new Map();
  const skipped = { inactive: 0, noApiName: 0, notIdentifier: 0 };

  for (const record of records) {
    if (record.active !== 'true') {
      // An inactive Script Include is not loaded at runtime, so leaving it out
      // keeps a reference to it reportable rather than silently allowed.
      skipped.inactive++;
      continue;
    }
    const dot = record.api_name.indexOf('.');
    if (dot <= 0) {
      skipped.noApiName++;
      continue;
    }
    const scope = record.api_name.slice(0, dot);
    const name = record.name;
    // Some sys_script_include rows carry human-readable names (e.g. "Render All
    // Table") and are never referenced as classes.
    if (!JS_IDENTIFIER_RE.test(name) || !JS_IDENTIFIER_RE.test(scope)) {
      skipped.notIdentifier++;
      continue;
    }
    if (!byScope.has(scope)) {
      byScope.set(scope, {
        names: new Set(),
        packagePrivate: new Set(),
        clientCallable: new Set()
      });
    }
    const entry = byScope.get(scope);
    entry.names.add(name);
    if (hasAccess && record.access === 'package_private') {
      entry.packagePrivate.add(name);
    }
    if (hasClientCallable && record.client_callable === 'true') {
      entry.clientCallable.add(name);
    }
  }

  const scopes = {};
  for (const scope of [...byScope.keys()].sort()) {
    const entry = byScope.get(scope);
    const out = { names: [...entry.names].sort() };
    // Side-lists are omitted entirely when the source export lacked the column,
    // so a consumer can tell "not package-private" from "unknown".
    if (hasAccess) {
      out.packagePrivate = [...entry.packagePrivate].sort();
    }
    if (hasClientCallable) {
      out.clientCallable = [...entry.clientCallable].sort();
    }
    scopes[scope] = out;
  }

  const payload = {
    version: 2,
    format: 'servicenow_script_include_whitelist',
    note:
      'Generated by scripts/pack-script-includes.js. Keys are scope technical names ' +
      "(api_name prefix); 'global' entries are referenced by bare name, all other " +
      'scopes are reachable only as <scope>.<Name>. packagePrivate/clientCallable ' +
      'are present only when the source export included the access/client_callable columns.',
    sourceColumns: [...REQUIRED_COLUMNS, ...presentOptional],
    scopes
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  const total = Object.values(scopes).reduce((sum, entry) => sum + entry.names.length, 0);
  console.log(`wrote ${OUT_PATH}`);
  console.log(`  scopes: ${Object.keys(scopes).length}`);
  console.log(`  script includes: ${total}`);
  console.log(`  global (bare-name): ${(scopes.global?.names || []).length}`);
  console.log(
    `  skipped: ${skipped.inactive} inactive, ${skipped.noApiName} without api_name, ` +
      `${skipped.notIdentifier} non-identifier names`
  );
  for (const column of OPTIONAL_COLUMNS) {
    if (!presentOptional.includes(column)) {
      console.warn(
        `  note: '${column}' not in export — cross-scope checks cannot use it. ` +
          `Re-export with sysparm_fields including ${column}.`
      );
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseCsv, JS_IDENTIFIER_RE };
