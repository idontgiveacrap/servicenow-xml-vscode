/**
 * Diagnostic underlines cover the XML tag or element text, not one character.
 * Run: node scripts/smoke-diagnostic-range.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-xml-diag-range-'));
const outfile = path.join(tempDir, 'diagnosticRange.cjs');

async function main() {
  await esbuild.build({
    entryPoints: [path.join(__dirname, '../src/diagnosticRange.ts')],
    bundle: true,
    outfile,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    logLevel: 'silent'
  });
  const { inferXmlDiagnosticEnd } = require(outfile);

  const field = '    <sys_created_by>jacob.smith@example.com</sys_created_by>';
  const valueAt = field.indexOf('jacob.smith@example.com');
  assert.strictEqual(
    inferXmlDiagnosticEnd(field, valueAt),
    valueAt + 'jacob.smith@example.com'.length,
    'element text is underlined through the value, not just its first character'
  );

  const tagAt = field.indexOf('<sys_created_by>');
  assert.strictEqual(
    inferXmlDiagnosticEnd(field, tagAt),
    tagAt + '<sys_created_by>'.length,
    'a diagnostic on the opening tag covers that tag'
  );

  const nameAt = field.indexOf('sys_created_by');
  assert.strictEqual(
    inferXmlDiagnosticEnd(field, nameAt),
    tagAt + '<sys_created_by>'.length,
    'a diagnostic on the tag name runs through the end of the tag'
  );

  const row = '    <sys_ui_element action="INSERT_OR_UPDATE">';
  const rowAt = row.indexOf('<');
  assert.strictEqual(
    inferXmlDiagnosticEnd(row, rowAt),
    row.length,
    'an opening tag with attributes is underlined through >'
  );

  const position = '<position>0</position>';
  const zeroAt = position.indexOf('0');
  assert.strictEqual(inferXmlDiagnosticEnd(position, zeroAt), zeroAt + 1);

  const dated = '<sys_created_on>2026-10-12 20:15:30</sys_created_on>';
  const dateAt = dated.indexOf('2026');
  assert.strictEqual(
    inferXmlDiagnosticEnd(dated, dateAt),
    dateAt + '2026-10-12 20:15:30'.length
  );

  const comparison = 'if (a <= b && c < d) return;';
  assert.strictEqual(
    inferXmlDiagnosticEnd(comparison, 0),
    comparison.length,
    '<= and < in script text are not treated as tags'
  );

  const unclosed = '<sys_ui_section caption="Comp';
  assert.strictEqual(inferXmlDiagnosticEnd(unclosed, 0), unclosed.length);

  assert.strictEqual(inferXmlDiagnosticEnd('abc', 10), 3);
  assert.strictEqual(inferXmlDiagnosticEnd('', 0), 0);

  console.log('OK diagnostic range');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
