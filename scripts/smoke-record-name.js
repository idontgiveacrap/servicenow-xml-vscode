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
  assert.match(
    manifest.version,
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
    'extension version must be a valid SemVer version'
  );
  assert.ok(
    manifest.contributes.configuration.properties[
      'servicenowXml.enabledForAllWindows'
    ],
    'enabledForAllWindows setting must be registered in the extension manifest'
  );
  assert.ok(
    manifest.contributes.configuration.properties[
      'servicenowXml.cursorHelpers.enable'
    ],
    'cursorHelpers.enable setting must be registered'
  );
  assert.ok(
    manifest.contributes.commands.some(
      (c) => c.command === 'servicenowXml.cursor.installHelpers'
    ),
    'Install Cursor Helpers command must be registered'
  );
  assert.equal(
    manifest.contributes.views['servicenow-xml'][0].when,
    'servicenowXml.isSnWorkspace || servicenowXml.hasSnDocument || config.servicenowXml.enabledForAllWindows',
    'Records view must be gated by SN workspace context, an open SN-shaped document, or enabledForAllWindows'
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
  const fixtureText = fs.readFileSync(fixturePath, 'utf8');
  const fixture = extractRecordIdentity(fixtureText, fixturePath);
  assert.deepStrictEqual(fixture, {
    table: 'sys_script_include',
    displayName: 'HelloWorld',
    sysId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    action: 'INSERT_OR_UPDATE',
    apiName: 'x_example.HelloWorld',
    sysModCount: 1,
    startOffset: fixtureText.indexOf('<sys_script_include action=')
  });

  const dictionaryPath = path.join(
    __dirname,
    '..',
    'fixtures',
    'dictionary_export',
    'x_example_0_compare_row.xml'
  );
  const dictionaryText = fs.readFileSync(dictionaryPath, 'utf8');
  const dictionaryRecords = extractRecordIdentities(dictionaryText, dictionaryPath);
  assert.equal(
    dictionaryRecords.length,
    1,
    'a <database> dictionary export is one navigator record, not one per column'
  );
  assert.deepStrictEqual(dictionaryRecords[0], {
    table: 'x_example_0_compare_row',
    displayName: 'Compare row',
    startOffset: dictionaryText.indexOf('<element audit=')
  });
  // Basename is conventional only, so table and label must come from the content.
  assert.deepStrictEqual(
    extractRecordIdentity(dictionaryText, 'renamed_by_hand.xml'),
    dictionaryRecords[0]
  );

  const rowlessRootTable = extractRecordIdentity(
    '<record_update table="sys_choice"/>',
    'unconventional_name.xml'
  );
  assert.equal(rowlessRootTable?.table, 'sys_choice');

  const deleteXml = `<record_update table="sys_scoped_cache">
      <sys_scoped_cache action="DELETE">
        <name>Key translations</name>
        <sys_id>00000000000000000000000000000000</sys_id>
        <sys_mod_count>3</sys_mod_count>
      </sys_scoped_cache>
    </record_update>`;
  const deleted = extractRecordIdentity(deleteXml);
  assert.equal(deleted?.action, 'DELETE');
  assert.equal(deleted?.displayName, 'Key translations');
  assert.equal(deleted?.sysModCount, 3);

  const displayValueWins = extractRecordIdentity(
    `<record_update table="sys_choice">
      <sys_choice action="INSERT_OR_UPDATE">
        <name>internal_name</name>
        <label>Awaiting Evidence</label>
        <display_value>Closed Complete</display_value>
        <sys_id>66666666666666666666666666666666</sys_id>
      </sys_choice>
    </record_update>`
  );
  assert.equal(displayValueWins?.displayName, 'Closed Complete');

  const labelBeforeName = extractRecordIdentity(
    `<record_update table="sys_choice">
      <sys_choice action="INSERT_OR_UPDATE">
        <name>internal_name</name>
        <label>Awaiting Evidence</label>
        <sys_id>77777777777777777777777777777777</sys_id>
      </sys_choice>
    </record_update>`
  );
  assert.equal(labelBeforeName?.displayName, 'Awaiting Evidence');

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
  assert.equal(
    allRecords[0].startOffset,
    multiRecordXml.indexOf('<sys_script_include action=')
  );
  assert.equal(
    allRecords[1].startOffset,
    multiRecordXml.indexOf('<sys_translated_text action=')
  );
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

  const nestedSameName = parseSnXml(
    `<record_update table="incident">
      <incident action="INSERT_OR_UPDATE">
        <sys_id>55555555555555555555555555555555</sys_id>
        <incident>child field value</incident>
        <short_description>Outer row</short_description>
      </incident>
    </record_update>`
  );
  assert.equal(nestedSameName.rows.length, 1);
  assert.equal(nestedSameName.rows[0].tableName, 'incident');
  assert.equal(nestedSameName.rows[0].sysId, '55555555555555555555555555555555');
  assert.ok(
    nestedSameName.rows[0].endOffset > nestedSameName.text.indexOf('Outer row'),
    'row must include content after nested same-name field'
  );

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

  assert.ok(
    manifest.contributes.commands.some(
      (c) =>
        c.command === 'servicenowXml.changeActionToDelete' &&
        c.title === 'Convert record to DELETE…'
    ),
    'changeActionToDelete command must have a distinct conversion title'
  );
  assert.ok(
    manifest.contributes.menus['view/item/context'].some(
      (m) =>
        m.command === 'servicenowXml.changeActionToDelete' &&
        m.when.includes('servicenowXml.record.insertOrUpdate')
    ),
    'Delete context menu must target INSERT_OR_UPDATE records only'
  );
  assert.ok(
    manifest.contributes.commands.some(
      (c) =>
        c.command === 'servicenowXml.deleteRecordFromDisk' &&
        c.title === 'Delete from disk…'
    ),
    'filesystem delete command must be registered with a distinct title'
  );
  assert.ok(
    manifest.contributes.menus['view/item/context'].some(
      (m) => m.command === 'servicenowXml.deleteRecordFromDisk'
    ),
    'filesystem delete command must be in the Records context menu'
  );
  const pruneMenu = manifest.contributes.menus['view/item/context'].find(
    (m) => m.command === 'servicenowXml.pruneRedundantDeletes'
  );
  assert.ok(pruneMenu, 'prune must be on the Records context menu');
  assert.ok(
    pruneMenu.when.includes('servicenowXml.record.delete') &&
      pruneMenu.when.includes('servicenowXml.table.hasDelete'),
    'prune context menu must target DELETE rows and tables holding one'
  );
  assert.ok(
    !/viewItem == servicenowXml\.record\b(?!\.)/.test(pruneMenu.when) &&
      !pruneMenu.when.includes('servicenowXml.record.insertOrUpdate'),
    'prune context menu must not offer itself on live records'
  );

  const changeActionBundlePath = path.join(tempDir, 'changeActionToDelete.cjs');
  esbuild.buildSync({
    entryPoints: [
      path.join(__dirname, '..', 'src', 'navigator', 'changeActionToDelete.ts')
    ],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: changeActionBundlePath,
    logLevel: 'silent'
  });
  const { changeActionToDelete, electiveUpdatePathFor } = require(
    changeActionBundlePath
  );

  const iouXml = `<record_update table="sys_script_include">
  <sys_script_include action="INSERT_OR_UPDATE">
    <name>DemoInclude</name>
    <sys_id>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</sys_id>
  </sys_script_include>
</record_update>`;
  const iouIdentity = extractRecordIdentity(iouXml);
  assert.equal(iouIdentity?.action, 'INSERT_OR_UPDATE');
  const changed = changeActionToDelete(iouXml, 'demo.xml', iouIdentity);
  assert.equal(changed.ok, true);
  assert.match(changed.text, /action="DELETE"/);
  assert.doesNotMatch(changed.text, /action="INSERT_OR_UPDATE"/);
  assert.equal(
    extractRecordIdentity(changed.text)?.action,
    'DELETE'
  );

  const alreadyDelete = changeActionToDelete(
    deleteXml,
    'gone.xml',
    extractRecordIdentity(deleteXml)
  );
  assert.equal(alreadyDelete.ok, false);

  const mixedXml = `<unload>
<sys_script_include action="INSERT_OR_UPDATE">
<name>Keep</name>
<sys_id>11111111111111111111111111111111</sys_id>
</sys_script_include>
<sys_script_include action="INSERT_OR_UPDATE">
<name>Flip</name>
<sys_id>22222222222222222222222222222222</sys_id>
</sys_script_include>
</unload>`;
  const flipTarget = extractRecordIdentities(mixedXml).find(
    (r) => r.sysId === '22222222222222222222222222222222'
  );
  assert.ok(flipTarget);
  const flipped = changeActionToDelete(mixedXml, 'mixed.xml', flipTarget);
  assert.equal(flipped.ok, true);
  const afterFlip = extractRecordIdentities(flipped.text);
  assert.equal(
    afterFlip.find((r) => r.sysId === '11111111111111111111111111111111')?.action,
    'INSERT_OR_UPDATE'
  );
  assert.equal(
    afterFlip.find((r) => r.sysId === '22222222222222222222222222222222')?.action,
    'DELETE'
  );

  assert.equal(
    electiveUpdatePathFor('/repo/app/1234/update/sys_script_include_abcd.xml'),
    '/repo/app/1234/author_elective_update/sys_script_include_abcd.xml'
  );
  assert.equal(
    electiveUpdatePathFor('C:\\repo\\app\\1234\\update\\sys_ui_policy_ef01.xml'),
    'C:\\repo\\app\\1234\\author_elective_update\\sys_ui_policy_ef01.xml'
  );
  // Nearest `update` ancestor wins, so an outer directory of that name is left alone.
  assert.equal(
    electiveUpdatePathFor('/update/app/1234/update/sys_dictionary_2345.xml'),
    '/update/app/1234/author_elective_update/sys_dictionary_2345.xml'
  );
  // Already filed as elective, and standalone exports: nowhere to move.
  assert.equal(
    electiveUpdatePathFor(
      '/repo/app/1234/author_elective_update/sys_script_include_abcd.xml'
    ),
    undefined
  );
  assert.equal(electiveUpdatePathFor('/tmp/one_off_export.xml'), undefined);
  // A file literally named `update` is not a directory match.
  assert.equal(electiveUpdatePathFor('/repo/app/update'), undefined);

  const removeRowBundlePath = path.join(tempDir, 'removeRecordRow.cjs');
  esbuild.buildSync({
    entryPoints: [
      path.join(__dirname, '..', 'src', 'navigator', 'removeRecordRow.ts')
    ],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: removeRowBundlePath,
    logLevel: 'silent'
  });
  const { removeRecordRow } = require(removeRowBundlePath);

  // The only record in a file: there is no export left to rewrite.
  assert.deepStrictEqual(
    removeRecordRow(iouXml, 'demo.xml', extractRecordIdentity(iouXml)),
    { outcome: 'delete-file' }
  );

  const cut = removeRecordRow(mixedXml, 'mixed.xml', flipTarget);
  assert.equal(cut.outcome, 'rewrite');
  assert.equal(cut.remaining, 1);
  assert.deepStrictEqual(
    extractRecordIdentities(cut.text).map((r) => r.sysId),
    ['11111111111111111111111111111111'],
    'only the targeted record leaves the file'
  );
  assert.ok(
    !/\n\s*\n/.test(cut.text),
    'removing a row must not leave a blank line behind'
  );

  assert.equal(
    removeRecordRow(mixedXml, 'mixed.xml', {
      ...flipTarget,
      sysId: '33333333333333333333333333333333'
    }).outcome,
    'not-found'
  );

  // Deletion package: version + metadata_delete for one update name → trash file.
  const deletionPackageXml = `<?xml version="1.0" encoding="UTF-8"?><record_update table="sys_security_acl_role">
    <sys_update_version action="INSERT_OR_UPDATE">
        <name>sys_security_acl_role_5ff8876987a3c350498aa9b70cbb353b</name>
        <sys_id>d089cfa987a3c350498aa9b70cbb350a</sys_id>
    </sys_update_version>
    <sys_metadata_delete action="INSERT_OR_UPDATE">
        <sys_id>100ece5f4955403481db6ba52602f144</sys_id>
        <sys_metadata>5ff8876987a3c350498aa9b70cbb353b</sys_metadata>
        <sys_update_name>sys_security_acl_role_5ff8876987a3c350498aa9b70cbb353b</sys_update_name>
    </sys_metadata_delete>
</record_update>`;
  const metadataDeleteTarget = extractRecordIdentities(deletionPackageXml).find(
    (r) => r.table === 'sys_metadata_delete'
  );
  assert.ok(metadataDeleteTarget);
  assert.deepStrictEqual(
    removeRecordRow(
      deletionPackageXml,
      'sys_security_acl_role_5ff8876987a3c350498aa9b70cbb353b.xml',
      metadataDeleteTarget
    ),
    { outcome: 'delete-file' },
    'removing delete metadata must also take the matching sys_update_version'
  );

  // Live insert plus companions: drop the group, keep an unrelated sibling.
  const withCompanionsXml = `<unload>
<sys_script_include action="INSERT_OR_UPDATE">
<name>Keep</name>
<sys_id>11111111111111111111111111111111</sys_id>
<sys_update_name>sys_script_include_11111111111111111111111111111111</sys_update_name>
</sys_script_include>
<sys_script_include action="INSERT_OR_UPDATE">
<name>Drop</name>
<sys_id>22222222222222222222222222222222</sys_id>
<sys_update_name>sys_script_include_22222222222222222222222222222222</sys_update_name>
</sys_script_include>
<sys_update_version action="INSERT_OR_UPDATE">
<name>sys_script_include_22222222222222222222222222222222</name>
<sys_id>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</sys_id>
</sys_update_version>
<sys_metadata_delete action="INSERT_OR_UPDATE">
<sys_id>bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb</sys_id>
<sys_metadata>22222222222222222222222222222222</sys_metadata>
<sys_update_name>sys_script_include_22222222222222222222222222222222</sys_update_name>
</sys_metadata_delete>
<sys_translated_text action="delete_multiple" query="documentkey=22222222222222222222222222222222"/>
</unload>`;
  const dropTarget = extractRecordIdentities(withCompanionsXml).find(
    (r) => r.sysId === '22222222222222222222222222222222'
  );
  assert.ok(dropTarget);
  const dropped = removeRecordRow(withCompanionsXml, 'mixed.xml', dropTarget);
  assert.equal(dropped.outcome, 'rewrite');
  assert.equal(dropped.remaining, 1);
  assert.deepStrictEqual(
    extractRecordIdentities(dropped.text).map((r) => r.sysId),
    ['11111111111111111111111111111111'],
    'companions for the removed update name leave with it'
  );
  assert.doesNotMatch(dropped.text, /sys_update_version/);
  assert.doesNotMatch(dropped.text, /sys_metadata_delete/);
  assert.doesNotMatch(dropped.text, /delete_multiple/);

  // Companions belonging to another record, and a cleanup row shared with one,
  // must survive removal of the targeted record.
  const sharedCompanionsXml = `<unload>
<sys_script_include action="INSERT_OR_UPDATE">
<name>Drop</name>
<sys_id>22222222222222222222222222222222</sys_id>
<sys_update_name>sys_script_include_22222222222222222222222222222222</sys_update_name>
</sys_script_include>
<sys_script_include action="INSERT_OR_UPDATE">
<name>Keep</name>
<sys_id>11111111111111111111111111111111</sys_id>
<sys_update_name>sys_script_include_11111111111111111111111111111111</sys_update_name>
</sys_script_include>
<sys_update_version action="INSERT_OR_UPDATE">
<name>sys_script_include_11111111111111111111111111111111</name>
<sys_id>cccccccccccccccccccccccccccccccc</sys_id>
</sys_update_version>
<sys_metadata_delete action="INSERT_OR_UPDATE">
<sys_id>dddddddddddddddddddddddddddddddd</sys_id>
<sys_metadata>11111111111111111111111111111111</sys_metadata>
<sys_update_name>sys_script_include_11111111111111111111111111111111</sys_update_name>
</sys_metadata_delete>
<sys_translated_text action="delete_multiple" query="documentkey=22222222222222222222222222222222^ORdocumentkey=11111111111111111111111111111111"/>
</unload>`;
  const sharedTarget = extractRecordIdentities(sharedCompanionsXml).find(
    (r) => r.sysId === '22222222222222222222222222222222'
  );
  assert.ok(sharedTarget);
  const shared = removeRecordRow(sharedCompanionsXml, 'mixed.xml', sharedTarget);
  assert.equal(shared.outcome, 'rewrite');
  assert.equal(shared.remaining, 3, 'other record keeps its version and delete metadata');
  assert.match(
    shared.text,
    /<name>sys_script_include_11111111111111111111111111111111<\/name>/,
    "another record's sys_update_version must stay"
  );
  assert.match(
    shared.text,
    /<sys_metadata>11111111111111111111111111111111<\/sys_metadata>/,
    "another record's delete metadata must stay"
  );
  assert.match(
    shared.text,
    /delete_multiple/,
    'a cleanup row also covering another record must stay'
  );
  assert.doesNotMatch(
    shared.text,
    /<name>Drop<\/name>/,
    'the targeted record still leaves'
  );

  console.log('navigator and XML parser smoke tests passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
