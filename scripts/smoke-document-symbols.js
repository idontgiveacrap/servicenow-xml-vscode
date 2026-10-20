const assert = require('assert');
const path = require('path');
const esbuild = require('esbuild');

const bundlePath = path.join(__dirname, '..', 'dist', 'smoke-document-symbols.cjs');

esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'documentSymbols.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
  external: ['vscode']
});

const { buildDocumentOutline } = require(bundlePath);

const xml =
  '<?xml version="1.0"?><record_update>' +
  '<sys_script_include action="INSERT_OR_UPDATE">' +
  '<name>DemoInclude</name>' +
  '<sys_id>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</sys_id>' +
  '<script><![CDATA[var DemoInclude = Class.create();' +
  'DemoInclude.prototype = { initialize: function() {}, run: function() {} };]]></script>' +
  '<output_schema><![CDATA[{"title":"Demo","enabled":true}]]></output_schema>' +
  '</sys_script_include></record_update>';

const outline = buildDocumentOutline(xml, 'demo.xml');
assert.ok(outline && outline.length === 1, 'expected one record row');
const record = outline[0];
assert.strictEqual(record.kind, 'record');
assert.ok(record.rangeStart < record.rangeEnd);
assert.ok(record.children.length > 0, 'record should have field children');

const scriptField = record.children.find((node) => node.name === 'script');
assert.ok(scriptField, 'script field missing');
assert.ok(
  scriptField.rangeStart >= record.rangeStart &&
    scriptField.rangeEnd <= record.rangeEnd,
  'script field range should sit inside the record'
);
assert.ok(
  scriptField.children.some((node) => node.name === 'initialize'),
  'expected a function/method under script'
);

const schemaField = record.children.find((node) => node.name === 'output_schema');
assert.ok(schemaField, 'output_schema field missing');
assert.ok(
  schemaField.children.some((node) => node.name === 'title'),
  'expected JSON property outline'
);

console.log('smoke-document-symbols: ok');
