/**
 * Build src/data/fieldKinds.json from packed dictionaryFields.json.gz.
 * Also invoked at the end of pack-dictionary.js after writing the fields pack.
 *
 *   node scripts/pack-field-kinds.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const FIELDS_GZ = path.join(ROOT, 'src', 'data', 'dictionaryFields.json.gz');
const OUT = path.join(ROOT, 'src', 'data', 'fieldKinds.json');

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
  if (!fs.existsSync(FIELDS_GZ)) {
    throw new Error(`Missing ${FIELDS_GZ}; run pack-dictionary.js first`);
  }
  const pack = JSON.parse(zlib.gunzipSync(fs.readFileSync(FIELDS_GZ)).toString('utf8'));
  const fields = pack.fields || {};
  const scriptPairs = new Set();
  const clientScriptPairs = new Set();
  const cssFieldNames = new Set(CSS_FIELD_SUPPLEMENTS);
  const jsonFieldNames = new Set(JSON_FIELD_SUPPLEMENTS);

  for (const [table, rows] of Object.entries(fields)) {
    for (const row of rows || []) {
      const element = row.element;
      if (!element) {
        continue;
      }
      const type = String(row.internalType || '');
      const emb = row.embeddedLanguage;
      if (emb === 'javascript' || /^script/i.test(type)) {
        scriptPairs.add(`${table}.${element}`);
        if (/client/i.test(type)) {
          clientScriptPairs.add(`${table}.${element}`);
        }
      }
      if (emb === 'css' || type === 'css' || type === 'html_style') {
        cssFieldNames.add(element);
      }
      if (emb === 'json' || type === 'json' || type === 'template_value') {
        jsonFieldNames.add(element);
      }
    }
  }

  const out = {
    version: 1,
    scriptPairs: [...scriptPairs].sort(),
    clientScriptPairs: [...clientScriptPairs].sort(),
    cssFieldNames: [...cssFieldNames].sort(),
    jsonFieldNames: [...jsonFieldNames].sort()
  };
  fs.writeFileSync(OUT, JSON.stringify(out) + '\n');
  console.log(
    `Wrote ${OUT}: ${out.scriptPairs.length} script pairs, ` +
      `${out.clientScriptPairs.length} client pairs, ` +
      `${out.cssFieldNames.length} css names, ${out.jsonFieldNames.length} json names`
  );
}

main();
