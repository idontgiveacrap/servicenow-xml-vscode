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
  assert.equal(manifest.version, '2.2.3');
  assert.ok(
    manifest.contributes.configuration.properties[
      'servicenowXml.enabledForAllWindows'
    ],
    'enabledForAllWindows setting must be registered in the extension manifest'
  );
  assert.equal(
    manifest.contributes.views['servicenow-xml'][0].when,
    'servicenowXml.isSnWorkspace || config.servicenowXml.enabledForAllWindows',
    'Records view must be gated by SN workspace context or enabledForAllWindows'
  );
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
  assert.ok(
    manifest.contributes.configuration.properties[
      'servicenowXml.navigator.sortBy'
    ],
    'navigator sortBy setting must be registered in the extension manifest'
  );
  assert.ok(
    manifest.contributes.commands.some(
      (command) => command.command === 'servicenowXml.navigator.sortBy'
    ),
    'navigator sortBy command must be registered in the extension manifest'
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
    apiName: 'x_example.HelloWorld',
    sysModCount: 1
  });

  const deleteXml = `<record_update table="sys_scoped_cache">
      <sys_scoped_cache action="DELETE">
        <name>Key translations</name>
        <sys_id>c6e46af2c3c8831086f39f3ed4013126</sys_id>
        <sys_mod_count>3</sys_mod_count>
      </sys_scoped_cache>
    </record_update>`;
  const deleted = extractRecordIdentity(deleteXml);
  assert.equal(deleted?.action, 'DELETE');
  assert.equal(deleted?.displayName, 'Key translations');
  assert.equal(deleted?.sysModCount, 3);

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

  const fileNameBundlePath = path.join(tempDir, 'fileName.cjs');
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', 'src', 'fileName.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: fileNameBundlePath,
    logLevel: 'silent'
  });
  const { matchesSnAppMarker } = require(fileNameBundlePath);
  const sid = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  assert.equal(
    matchesSnAppMarker(path.join('apps', sid, `sys_app_${sid}.xml`)),
    true
  );
  assert.equal(
    matchesSnAppMarker(path.join('apps', sid, `sys_app_${sid.toUpperCase()}.xml`)),
    true
  );
  assert.equal(
    matchesSnAppMarker(path.join('apps', 'other', `sys_app_${sid}.xml`)),
    false
  );
  assert.equal(
    matchesSnAppMarker(path.join(sid, `sys_script_include_${sid}.xml`)),
    false
  );

  console.log('navigator and XML parser smoke tests passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
