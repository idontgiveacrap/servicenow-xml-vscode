/**
 * Pack a ServiceNow sys_dictionary list CSV into Registry schema assets.
 *
 *   node scripts/pack-dictionary.js "path/to/sys_dictionary.csv"
 *
 * Writes:
 *   src/data/dictionaryTables.json
 *   src/data/dictionaryFields.json.gz
 *
 * Primary input is the instance CSV export. Hand JSON/CSS name supplements in
 * this file are merged as overlays for field-kind hints when internal_type
 * alone is insufficient. Ends by writing fieldKinds.json via pack-field-kinds.js.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { parseCsv } = require('./pack-script-includes');

const ROOT = path.join(__dirname, '..');
const TABLES_OUT = path.join(ROOT, 'src', 'data', 'dictionaryTables.json');
const FIELDS_OUT = path.join(ROOT, 'src', 'data', 'dictionaryFields.json.gz');

/** Hand supplements: field names treated as JSON/CSS when dictionary lacks type. */
const JSON_FIELD_SUPPLEMENTS = [
  'props',
  'composition',
  'layout',
  'data',
  'client_script',
  'server_script',
  'css_variables',
  'required_translations',
  'macroponent_internal_type',
  'state_properties',
  'interfaces'
];
const CSS_FIELD_SUPPLEMENTS = ['css', 'style'];

function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    throw new Error(
      'Usage: node scripts/pack-dictionary.js <sys_dictionary.csv>'
    );
  }
  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV not found: ${csvPath}`);
  }

  // Windows list CSV is often cp1252; try utf8 first then latin1.
  let raw = fs.readFileSync(csvPath);
  let text = raw.toString('utf8');
  if (text.includes('\uFFFD') || text.charCodeAt(0) === 0xfffe) {
    text = raw.toString('latin1');
  }
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  const records = parseCsv(text);
  if (records.length === 0) {
    throw new Error(`No data rows parsed from ${csvPath}`);
  }
  for (const column of ['name', 'element']) {
    if (!(column in records[0])) {
      throw new Error(`CSV is missing the '${column}' column`);
    }
  }

  /** @type {Map<string, { name: string, label?: string }>} */
  const tables = new Map();
  /** @type {Map<string, Array<{ element: string, label?: string, internalType?: string, reference?: string, embeddedLanguage?: string }>>} */
  const fieldsByTable = new Map();

  let tableDefs = 0;
  let fieldRows = 0;
  for (const row of records) {
    const table = String(row.name || '').trim();
    if (!table) {
      continue;
    }
    const element = String(row.element || '').trim();
    const label = String(row.column_label || row.label || '').trim();
    const internalType = String(row.internal_type || '').trim();
    const reference = String(row.reference || '').trim();

    if (!tables.has(table)) {
      tables.set(table, { name: table });
    }
    if (!element) {
      // Table definition row
      if (label) {
        tables.get(table).label = label;
      }
      tableDefs++;
      continue;
    }

    fieldRows++;
    let embeddedLanguage;
    const typeLower = internalType.toLowerCase();
    if (typeLower.startsWith('script')) {
      embeddedLanguage = 'javascript';
    } else if (typeLower === 'json' || typeLower === 'template_value') {
      embeddedLanguage = 'json';
    } else if (typeLower === 'css' || typeLower === 'html_style') {
      embeddedLanguage = 'css';
    } else if (JSON_FIELD_SUPPLEMENTS.includes(element)) {
      embeddedLanguage = 'json';
    } else if (CSS_FIELD_SUPPLEMENTS.includes(element)) {
      embeddedLanguage = 'css';
    }

    let list = fieldsByTable.get(table);
    if (!list) {
      list = [];
      fieldsByTable.set(table, list);
    }
    list.push({
      element,
      ...(label ? { label } : {}),
      ...(internalType ? { internalType } : {}),
      ...(reference ? { reference } : {}),
      ...(embeddedLanguage ? { embeddedLanguage } : {})
    });
  }

  const tableList = [...tables.values()].sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const fieldsObj = {};
  for (const table of [...fieldsByTable.keys()].sort()) {
    fieldsObj[table] = fieldsByTable.get(table);
  }

  fs.writeFileSync(
    TABLES_OUT,
    JSON.stringify({ version: 1, tables: tableList }) + '\n'
  );
  fs.writeFileSync(
    FIELDS_OUT,
    zlib.gzipSync(Buffer.from(JSON.stringify({ version: 1, fields: fieldsObj }), 'utf8'), {
      level: 9
    })
  );

  console.log(
    `Wrote ${tableList.length} tables (${tableDefs} defs) and ${fieldRows} fields`
  );
  console.log(`  ${TABLES_OUT}`);
  console.log(`  ${FIELDS_OUT}`);

  // Compact field-kind sets for parseSnXml / scriptProfile (no full fields.gz).
  require('./pack-field-kinds.js');
}

main();
