const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const esbuild = require('esbuild');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-xml-smoke-'));
const bundlePath = path.join(tempDir, 'recordName.cjs');
const parserBundlePath = path.join(tempDir, 'parseSnXml.cjs');

try {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
  );
  assert.equal(manifest.version, '2.2.0');
  assert.ok(
    manifest.contributes.configuration.properties[
      'servicenowXml.navigator.enable'
    ],
    'navigator setting must be registered in the extension manifest'
  );
  assert.ok(
    manifest.contributes.commands.some(
      (command) => command.command === 'servicenowXml.navigator.enable'
    ),
    'navigator enable command must be registered in the extension manifest'
  );

  esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', 'src', 'navigator', 'recordName.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    logLevel: 'silent'
  });
  const { extractRecordIdentities, extractRecordIdentity } = require(bundlePath);

  const fixturePath = path.join(
    __dirname,
    '..',
    'fixtures',
    'scoped_app_record_update',
    'sys_script_include_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.xml'
  );
  const fixture = extractRecordIdentity(
    fs.readFileSync(fixturePath, 'utf8'),
    fixturePath
  );
  assert.deepStrictEqual(fixture, {
    table: 'sys_script_include',
    displayName: 'HelloWorld',
    sysId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    action: 'INSERT_OR_UPDATE',
    apiName: 'x_example.HelloWorld'
  });

  const multiRecordXml = `<record_update table="sys_script_include">
      <sys_script_include action="INSERT_OR_UPDATE">
        <name>Primary &amp; Correct</name>
        <sys_id>11111111111111111111111111111111</sys_id>
      </sys_script_include>
      <sys_translated_text action="INSERT_OR_UPDATE">
        <name>Wrong sibling</name>
        <sys_id>22222222222222222222222222222222</sys_id>
      </sys_translated_text>
    </record_update>`;
  const multiRecord = extractRecordIdentity(
    multiRecordXml,
    'sys_script_include_11111111111111111111111111111111.xml'
  );
  assert.equal(multiRecord?.displayName, 'Primary & Correct');
  assert.equal(multiRecord?.sysId, '11111111111111111111111111111111');
  const allRecords = extractRecordIdentities(
    multiRecordXml,
    'sys_script_include_11111111111111111111111111111111.xml'
  );
  assert.equal(allRecords.length, 2);
  assert.equal(allRecords[1].displayName, 'Wrong sibling');
  const customerUpdate = extractRecordIdentity(
    '<unload><sys_update_xml action="INSERT_OR_UPDATE"><name>sys_ui_section_abc</name><target_name>Metadata Snapshot</target_name><sys_id>44444444444444444444444444444444</sys_id></sys_update_xml></unload>'
  );
  assert.equal(customerUpdate?.displayName, 'Metadata Snapshot');

  esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', 'src', 'parseSnXml.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: parserBundlePath,
    logLevel: 'silent'
  });
  const { decodeXmlEntities, parseSnXml } = require(parserBundlePath);
  assert.equal(decodeXmlEntities('A &#38; B &#x1f600;'), 'A & B 😀');
  assert.equal(parseSnXml('<record_update/>').wellFormed, true);
  assert.equal(parseSnXml('<record_update>').wellFormed, false);
  const normalized = parseSnXml(
    '<record_update><x_example action="insert_or_update"><sys_id><![CDATA[33333333333333333333333333333333]]></sys_id></x_example></record_update>'
  );
  assert.equal(normalized.rows[0].action, 'INSERT_OR_UPDATE');
  assert.equal(normalized.rows[0].sysId, '33333333333333333333333333333333');

  console.log('navigator and XML parser smoke tests passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
