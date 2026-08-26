const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-xml-decl-smoke-'));
const declsPath = path.join(tempDir, 'scriptDeclarations.cjs');
const parsePath = path.join(tempDir, 'parseSnXml.cjs');
const cachePath = path.join(tempDir, 'declarationCache.cjs');

try {
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', 'src', 'scriptDeclarations.ts')],
    outfile: declsPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  });
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', 'src', 'parseSnXml.ts')],
    outfile: parsePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  });
  esbuild.buildSync({
    entryPoints: [
      path.join(__dirname, '..', 'src', 'scriptDeclarationCache.ts')
    ],
    outfile: cachePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  });

  const {
    extractScriptDeclarations,
    isScriptDeclarationExportPath,
    resolveTechnicalScope
  } = require(declsPath);
  const { parseSnXml } = require(parsePath);
  const {
    createDeclarationCache,
    readDeclarationCache
  } = require(cachePath);

  const fixturePath = path.join(
    __dirname,
    '..',
    'fixtures',
    'scoped_app_record_update',
    'sys_script_include_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.xml'
  );
  assert.ok(
    isScriptDeclarationExportPath(fixturePath),
    'Studio Script Include exports must match the index filename shape'
  );

  const fixtureXml = fs.readFileSync(fixturePath, 'utf8');
  const fixtureDecls = extractScriptDeclarations(parseSnXml(fixtureXml, fixturePath));
  assert.deepStrictEqual(
    fixtureDecls,
    [
      {
        table: 'sys_script_include',
        profile: 'server',
        scope: 'x_example',
        name: 'HelloWorld'
      }
    ],
    `fixture Script Include should resolve via api_name, got ${JSON.stringify(fixtureDecls)}`
  );

  const payloadPath = path.join(
    __dirname,
    '..',
    'fixtures',
    'customer_update',
    'sys_remote_update_set_00000000000000000000000000000000.xml'
  );
  const payloadDoc = parseSnXml(fs.readFileSync(payloadPath, 'utf8'), payloadPath);
  assert.strictEqual(
    extractScriptDeclarations(payloadDoc, { includePayloads: false }).length,
    0,
    'workspace scans must not walk update-set payloads'
  );
  const payloadDecls = extractScriptDeclarations(payloadDoc, {
    includePayloads: true,
    workspaceAppSysId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    workspaceAppScope: 'x_example'
  });
  assert.deepStrictEqual(
    payloadDecls,
    [
      {
        table: 'sys_script_include',
        profile: 'server',
        scope: 'x_example',
        name: 'SampleUtil'
      }
    ],
    `standalone payload Script Includes should resolve through workspace app id, got ${JSON.stringify(payloadDecls)}`
  );

  const inactiveXml = `<record_update table="sys_script_include">
    <sys_script_include action="INSERT_OR_UPDATE">
      <active>false</active>
      <api_name>x_example.DeadUtil</api_name>
      <name>DeadUtil</name>
    </sys_script_include>
  </record_update>`;
  assert.strictEqual(
    extractScriptDeclarations(parseSnXml(inactiveXml)).length,
    0,
    'inactive Script Includes must not be indexed'
  );

  const deleteXml = `<record_update table="sys_script_include">
    <sys_script_include action="DELETE">
      <api_name>x_example.GoneUtil</api_name>
      <name>GoneUtil</name>
    </sys_script_include>
  </record_update>`;
  assert.strictEqual(
    extractScriptDeclarations(parseSnXml(deleteXml)).length,
    0,
    'DELETE Script Includes must not be indexed'
  );

  const badNameXml = `<record_update table="sys_script_include">
    <sys_script_include action="INSERT_OR_UPDATE">
      <api_name>x_example.Render All Table</api_name>
      <name>Render All Table</name>
    </sys_script_include>
  </record_update>`;
  assert.strictEqual(
    extractScriptDeclarations(parseSnXml(badNameXml)).length,
    0,
    'non-identifier names must not be indexed'
  );

  const multiXml = `<unload>
    <sys_script_include action="INSERT_OR_UPDATE">
      <api_name>global.GlobalUtil</api_name>
      <name>GlobalUtil</name>
    </sys_script_include>
    <sys_ui_script action="INSERT_OR_UPDATE">
      <api_name>x_example.AppUi</api_name>
      <name>AppUi</name>
      <script><![CDATA[var AppUi = {};]]></script>
    </sys_ui_script>
    <sys_ux_client_script_include action="INSERT_OR_UPDATE">
      <api_name>x_example.AppCsi</api_name>
      <name>AppCsi</name>
      <script><![CDATA[var AppCsi = {};]]></script>
    </sys_ux_client_script_include>
  </unload>`;
  const multiDecls = extractScriptDeclarations(parseSnXml(multiXml)).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  assert.deepStrictEqual(
    multiDecls.map((d) => `${d.table}:${d.scope}:${d.name}:${d.profile}`),
    [
      'sys_ux_client_script_include:x_example:AppCsi:client',
      'sys_ui_script:x_example:AppUi:client',
      'sys_script_include:global:GlobalUtil:server'
    ]
  );

  assert.strictEqual(
    resolveTechnicalScope({
      sysScopeValue: 'cccccccccccccccccccccccccccccccc',
      workspaceAppSysId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      workspaceAppScope: 'x_example'
    }),
    undefined,
    'unrelated scope sys_ids must not become the current app'
  );
  assert.strictEqual(
    resolveTechnicalScope({
      sysScopeValue: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      workspaceAppSysId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      workspaceAppScope: 'x_example'
    }),
    'x_example'
  );
  assert.strictEqual(
    resolveTechnicalScope({ sysScopeValue: 'global' }),
    'global'
  );

  const persisted = {
    table: 'sys_script_include',
    profile: 'server',
    scope: 'x_example',
    name: 'HelloWorld',
    uri: 'file:///c%3A/work/sys_script_include_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.xml'
  };
  const cache = createDeclarationCache('workspace-a', 'config-a', [persisted]);
  assert.deepStrictEqual(
    readDeclarationCache(cache, 'workspace-a', 'config-a'),
    [persisted]
  );
  assert.strictEqual(
    readDeclarationCache(cache, 'workspace-b', 'config-a'),
    undefined
  );

  console.log('script declaration smoke tests passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
