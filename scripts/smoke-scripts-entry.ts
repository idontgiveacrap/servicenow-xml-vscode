/**
 * Shared script extract / encode smoke (no vscode formatter).
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseSnXml, encodeXmlEntities } from '../src/parseSnXml';
import {
  detectCommonIndent,
  encodeHit,
  listScriptFields,
  restoreIndent,
  scriptAt,
  stripIndent
} from '../src/scriptHits';

function section(name: string): void {
  console.log(`\n== ${name}`);
}

const fixtures = path.join(__dirname, '../fixtures/scoped_app_record_update');

section('CDATA containing fake </script> is one hit');
{
  const text = fs.readFileSync(
    path.join(fixtures, 'sys_script_include_ffffffffffffffffffffffffffffffff.xml'),
    'utf8'
  );
  const doc = parseSnXml(text);
  const js = doc.rows[0].embeddedFields.filter((f) => f.language === 'javascript');
  assert.equal(js.length, 1, 'must not treat CDATA-contained tags as extra script fields');
  assert.ok(js[0].decodedContent.includes("'</script>'") || js[0].decodedContent.includes('</script>'));
  const fields = listScriptFields(doc);
  assert.equal(fields.length, 1);
  assert.equal(fields[0].role, 'scriptField');
  assert.equal(fields[0].fieldName, 'script');
}

section('dictionary-only processing_script');
{
  const text = fs.readFileSync(
    path.join(fixtures, 'sys_ui_page_11111111111111111111111111111111.xml'),
    'utf8'
  );
  const doc = parseSnXml(text);
  const names = doc.rows[0].embeddedFields
    .filter((f) => f.language === 'javascript')
    .map((f) => f.fieldName)
    .sort();
  assert.deepEqual(names, ['client_script', 'processing_script']);
  const fields = listScriptFields(doc);
  assert.equal(fields.length, 2);
  assert.ok(fields.some((h) => h.fieldName === 'processing_script' && h.profile === 'server'));
  assert.ok(fields.some((h) => h.fieldName === 'client_script' && h.profile === 'client'));
}

section('entity-encoded script body round-trip equivalent');
{
  const js = 'var x = 1 && y < 2;';
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<record_update table="sys_script_include">' +
    '<sys_script_include action="INSERT_OR_UPDATE">' +
    `<script>${encodeXmlEntities(js)}</script>` +
    '<sys_id>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</sys_id>' +
    '</sys_script_include></record_update>';
  const doc = parseSnXml(xml);
  const fields = listScriptFields(doc);
  assert.equal(fields.length, 1);
  assert.equal(fields[0].code, js);
  const encoded = encodeHit(fields[0], js);
  assert.equal(encoded.ok, true);
  if (encoded.ok) {
    assert.equal(encoded.text, encodeXmlEntities(js));
  }
}

section('CDATA ]]> refused on encode');
{
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<record_update table="sys_script_include">' +
    '<sys_script_include action="INSERT_OR_UPDATE">' +
    '<script><![CDATA[var x = 1;]]></script>' +
    '</sys_script_include></record_update>';
  const doc = parseSnXml(xml);
  const hit = listScriptFields(doc)[0];
  const encoded = encodeHit(hit, 'var x = "]]>";');
  assert.equal(encoded.ok, false);
}

section('payload-inner script maps to raw host bytes');
{
  const innerJs = 'var Hello = Class.create();';
  const inner =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<record_update table="sys_script_include">' +
    '<sys_script_include action="INSERT_OR_UPDATE">' +
    `<script><![CDATA[${innerJs}]]></script>` +
    '</sys_script_include></record_update>';
  const text =
    '<?xml version="1.0" encoding="UTF-8"?>\n<unload>\n' +
    '<sys_update_xml action="INSERT_OR_UPDATE">\n' +
    `<payload>${encodeXmlEntities(inner)}</payload>\n` +
    '</sys_update_xml>\n</unload>\n';
  const doc = parseSnXml(text);
  const fields = listScriptFields(doc);
  assert.equal(fields.length, 1);
  assert.equal(fields[0].code, innerJs);
  const rawHead = text.slice(fields[0].hostStart, fields[0].hostStart + 12);
  assert.equal(rawHead, encodeXmlEntities(innerJs).slice(0, 12));
  const encoded = encodeHit(fields[0], innerJs);
  assert.equal(encoded.ok, true);
  if (encoded.ok) {
    assert.equal(encoded.text, encodeXmlEntities(innerJs));
  }
}

section('JSON-string hit is scriptAt only');
{
  const js = 'function evaluate() { return 1; }';
  const composition = JSON.stringify({ fooScript: `javascript(${js})` });
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<record_update table="sys_ux_macroponent">' +
    '<sys_ux_macroponent action="INSERT_OR_UPDATE">' +
    `<composition>${composition.replace(/</g, '&lt;')}</composition>` +
    '</sys_ux_macroponent></record_update>';
  const offset = xml.indexOf('function evaluate');
  assert.ok(offset > 0);
  const at = scriptAt(xml, offset);
  assert.ok(at);
  assert.equal(at!.role, 'jsonString');
  const fields = listScriptFields(parseSnXml(xml));
  assert.equal(fields.filter((h) => h.role === 'scriptField').length, 0);
  assert.ok(!fields.some((h) => h.code.includes('evaluate')));
}

section('indent strip/restore + encode of a given formatted string');
{
  const code = '    var a = 1;\n    var b = 2;';
  const indent = detectCommonIndent(code);
  assert.equal(indent, '    ');
  const stripped = stripIndent(code, indent);
  assert.equal(stripped, 'var a = 1;\nvar b = 2;');
  const formatted = 'var a = 1;\nvar b = 2;';
  const restored = restoreIndent(formatted, indent);
  assert.equal(restored, code);
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<record_update table="sys_script_include">' +
    '<sys_script_include action="INSERT_OR_UPDATE">' +
    `<script><![CDATA[${code}]]></script>` +
    '</sys_script_include></record_update>';
  const hit = listScriptFields(parseSnXml(xml))[0];
  const encoded = encodeHit(hit, restored);
  assert.equal(encoded.ok, true);
  if (encoded.ok) {
    assert.equal(encoded.text, restored);
  }
}

console.log('\nscript extract/encode smoke passed');
process.exit(0);
