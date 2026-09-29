const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-xml-registry-smoke-'));
const bundlePath = path.join(tempDir, 'registry.cjs');

try {
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', 'src', 'registry', 'index.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
    external: ['vscode']
  });
  const {
    Registry,
    createRegistryCache,
    readRegistryCache,
    cachedRecordsToSymbols,
    loadStaticPacks,
    lintSchemaTableArgs
  } = require(bundlePath);

  const registry = new Registry();
  loadStaticPacks(registry, {
    scriptIncludes: {
      version: 1,
      scopes: { global: { names: ['JSUtil'] } }
    },
    scopes: { version: 1, scopes: ['global', 'x_test'] },
    platformGlobals: {
      version: 1,
      globals: [
        { name: 'gs', profile: 'server', fromSupplement: true },
        { name: 'g_form', profile: 'client', fromSupplement: true }
      ]
    }
  });

  assert.ok(registry.lookup('JSUtil').some((s) => s.kind === 'ScriptInclude'));
  assert.ok(registry.lookup('gs').length > 0);
  assert.strictEqual(registry.listScopes().length, 2);

  registry.upsert({
    kind: 'Table',
    name: 'incident',
    label: 'Incident',
    isTableDefinition: true
  });
  const schema = lintSchemaTableArgs(
    "var gr = new GlideRecord('no_such_table');\n",
    registry
  );
  assert.ok(
    schema.some((m) => /Unknown table 'no_such_table'/.test(m.message)),
    'unknown table should warn'
  );
  const known = lintSchemaTableArgs(
    "var gr = new GlideRecord('incident');\n",
    registry
  );
  assert.strictEqual(
    known.filter((m) => /Unknown table/.test(m.message)).length,
    0,
    'known table should not warn'
  );

  const cache = createRegistryCache({
    workspaceKey: 'ws-a',
    configKey: 'cfg-a',
    updatedAt: 1,
    records: [
      {
        table: 'sys_script_include',
        displayName: 'MyUtil',
        uri: 'file:///tmp/si.xml',
        relativePath: 'si.xml',
        startOffset: 0
      }
    ],
    declarations: [
      {
        table: 'sys_script_include',
        profile: 'server',
        scope: 'global',
        name: 'MyUtil',
        uri: 'file:///tmp/si.xml'
      }
    ]
  });
  const restored = readRegistryCache(cache, 'ws-a', 'cfg-a');
  assert.ok(restored);
  registry.upsertMany(cachedRecordsToSymbols(restored.records));
  assert.strictEqual(registry.listRecords().length, 1);
  assert.strictEqual(readRegistryCache(cache, 'ws-b', 'cfg-a'), undefined);

  console.log('registry smoke tests passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
