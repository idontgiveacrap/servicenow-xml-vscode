const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-xml-cache-smoke-'));
const bundlePath = path.join(tempDir, 'catalogCache.cjs');

try {
  esbuild.buildSync({
    entryPoints: [
      path.join(__dirname, '..', 'src', 'navigator', 'catalogCache.ts')
    ],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  });
  const {
    createCatalogCache,
    readCatalogCache
  } = require(bundlePath);

  const record = {
    table: 'sys_script_include',
    displayName: 'MyUtil',
    sysId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    action: 'INSERT_OR_UPDATE',
    apiName: 'x_test.MyUtil',
    sysModCount: 7,
    startOffset: 42,
    mtimeMs: 123456,
    uri: 'file:///c%3A/work/aaaaaaaa/sys_script_include_aaaaaaaa.xml',
    relativePath: 'aaaaaaaa/sys_script_include_aaaaaaaa.xml'
  };
  const cache = createCatalogCache('workspace-a', 'config-a', [record]);

  assert.deepStrictEqual(
    readCatalogCache(cache, 'workspace-a', 'config-a'),
    [record],
    'compatible cache should restore its records'
  );
  assert.strictEqual(
    readCatalogCache(cache, 'workspace-b', 'config-a'),
    undefined,
    'workspace changes must invalidate the cache'
  );
  assert.strictEqual(
    readCatalogCache(cache, 'workspace-a', 'config-b'),
    undefined,
    'indexing configuration changes must invalidate the cache'
  );
  assert.strictEqual(
    readCatalogCache({ ...cache, version: cache.version + 1 }, 'workspace-a', 'config-a'),
    undefined,
    'schema changes must invalidate the cache'
  );
  assert.strictEqual(
    readCatalogCache(
      { ...cache, records: [{ ...record, startOffset: -1 }] },
      'workspace-a',
      'config-a'
    ),
    undefined,
    'malformed records must not reach the navigator'
  );
  assert.deepStrictEqual(
    readCatalogCache(
      createCatalogCache('workspace-a', 'config-a', []),
      'workspace-a',
      'config-a'
    ),
    [],
    'an empty scanned workspace is still a valid warm cache'
  );

  console.log('catalog cache smoke tests passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
