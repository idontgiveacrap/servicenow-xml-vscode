const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const esbuild = require('esbuild');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-xml-smoke-'));
const bundlePath = path.join(tempDir, 'recordUrls.cjs');

try {
  // Verify package.json contributions for codelens feature.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
  );

  assert.ok(
    manifest.contributes.configuration.properties['servicenowXml.codelens.enable'],
    'codelens.enable setting must be registered in the manifest'
  );
  assert.equal(
    manifest.contributes.configuration.properties['servicenowXml.codelens.enable'].default,
    true,
    'codelens.enable must default to true'
  );

  assert.ok(
    manifest.contributes.configuration.properties['servicenowXml.instanceBaseUrl'],
    'instanceBaseUrl setting must be registered in the manifest'
  );
  assert.equal(
    manifest.contributes.configuration.properties['servicenowXml.instanceBaseUrl'].default,
    '',
    'instanceBaseUrl must default to empty string'
  );

  assert.ok(
    manifest.contributes.commands.some(
      (c) => c.command === 'servicenowXml.codelens.openUrl'
    ),
    'codelens openUrl command must be registered in the manifest'
  );

  // Bundle the pure URL module.
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', 'src', 'codelens', 'recordUrls.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    logLevel: 'silent'
  });
  const { buildRecordUrls, joinUrl, isAbsoluteUrl, URL_TYPES, URL_LABELS } =
    require(bundlePath);

  // --- buildRecordUrls ---

  const table = 'sys_script_include';
  const sysId = '0b686e7e1bc7435004a5eac1604bcb5e';
  const urls = buildRecordUrls(table, sysId);

  assert.equal(
    urls.studio,
    'servicenow_studio.do?table=sys_script_include&sysId=0b686e7e1bc7435004a5eac1604bcb5e',
    'studio URL must use table= and sysId= query params'
  );
  assert.equal(
    urls.navForm,
    '/nav_to.do?uri=sys_script_include.do?sys_id=0b686e7e1bc7435004a5eac1604bcb5e',
    'nav_to URL must encode table.do?sys_id='
  );
  assert.equal(
    urls.jsonApi,
    '/sys_script_include.do?JSONv2&sysparm_action=get&sysparm_sys_id=0b686e7e1bc7435004a5eac1604bcb5e',
    'JSON API URL must use table.do?JSONv2&params'
  );
  assert.equal(
    urls.xmlApi,
    '/sys_script_include.do?XML=&sys_id=0b686e7e1bc7435004a5eac1604bcb5e',
    'XML API URL must use table.do?XML=&sys_id='
  );

  // --- URL_TYPES ordering ---

  assert.deepStrictEqual(
    URL_TYPES,
    ['studio', 'navForm', 'jsonApi', 'xmlApi'],
    'URL_TYPES must list all four link types in the expected order'
  );

  // --- URL_LABELS ---

  assert.equal(URL_LABELS.studio, 'Studio', 'Studio label');
  assert.equal(URL_LABELS.navForm, 'Form', 'Form label');
  assert.equal(URL_LABELS.jsonApi, 'JSON', 'JSON label');
  assert.equal(URL_LABELS.xmlApi, 'XML', 'XML label');

  // --- joinUrl ---

  assert.equal(
    joinUrl('https://my-instance.service-now.com', '/nav_to.do?uri=x.do?sys_id=y'),
    'https://my-instance.service-now.com/nav_to.do?uri=x.do?sys_id=y',
    'joinUrl must insert a single slash between host and relative path'
  );
  assert.equal(
    joinUrl('https://my-instance.service-now.com/', '/nav_to.do?uri=x.do?sys_id=y'),
    'https://my-instance.service-now.com/nav_to.do?uri=x.do?sys_id=y',
    'joinUrl must strip trailing slash from base'
  );
  assert.equal(
    joinUrl('https://my-instance.service-now.com//', '/nav_to.do'),
    'https://my-instance.service-now.com/nav_to.do',
    'joinUrl must strip multiple trailing slashes'
  );
  assert.equal(
    joinUrl('', '/nav_to.do?uri=x'),
    '/nav_to.do?uri=x',
    'joinUrl with empty base returns the path unchanged'
  );

  // --- isAbsoluteUrl ---

  assert.equal(isAbsoluteUrl('https://ex.com/a'), true, 'https is absolute');
  assert.equal(isAbsoluteUrl('http://ex.com/a'), true, 'http is absolute');
  assert.equal(isAbsoluteUrl('/nav_to.do?uri=x'), false, 'relative path is not absolute');
  assert.equal(isAbsoluteUrl('servicenow_studio.do?table=x&sysId=y'), false, 'studio path is not absolute');

  // --- Integration with extractRecordIdentities ---

  const esbuild2 = require('esbuild');
  const identityBundle = path.join(tempDir, 'identities.cjs');
  esbuild2.buildSync({
    entryPoints: [path.join(__dirname, '..', 'src', 'navigator', 'recordName.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: identityBundle,
    logLevel: 'silent'
  });
  const { extractRecordIdentities } = require(identityBundle);

  const fixturePath = path.join(
    __dirname,
    '..',
    'fixtures',
    'scoped_app_record_update',
    'sys_script_include_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.xml'
  );
  const fixtureText = fs.readFileSync(fixturePath, 'utf8');
  const identities = extractRecordIdentities(fixtureText, fixturePath);
  assert.equal(identities.length, 1, 'fixture must have exactly one record identity');
  assert.equal(identities[0].sysId, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(identities[0].table, 'sys_script_include');

  const fixtureUrls = buildRecordUrls(identities[0].table, identities[0].sysId);
  assert.equal(
    fixtureUrls.studio,
    'servicenow_studio.do?table=sys_script_include&sysId=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  );

  // --- Dictionary export (no sys_id) produces no URLs ---

  const dictionaryPath = path.join(
    __dirname,
    '..',
    'fixtures',
    'dictionary_export',
    'x_example_0_compare_row.xml'
  );
  const dictionaryText = fs.readFileSync(dictionaryPath, 'utf8');
  const dictionaryIdentities = extractRecordIdentities(dictionaryText, dictionaryPath);
  assert.equal(dictionaryIdentities.length, 1);
  assert.equal(dictionaryIdentities[0].sysId, undefined, 'dictionary exports have no sys_id');

  console.log('codelens URL smoke tests passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
