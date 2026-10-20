const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const esbuild = require('esbuild');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-xml-instance-mcp-'));
const bundlePath = path.join(tempDir, 'snc.cjs');

try {
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', 'src', 'instance', 'snc.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  });
  const {
    parseInstanceProfileList,
    filterProfiles,
    queryLimit,
    resolveProfileName,
    instanceToolPayload,
    profileAllowlistFromEnv
  } = require(bundlePath);

  const stdout = [
    'Processing the request',
    '\u001b[32mSuccess\u001b[0m',
    JSON.stringify({
      admin: { host: 'dev.service-now.com', username: 'admin', default: true },
      other: { host: 'prod.service-now.com', username: 'reader' }
    })
  ].join('\n');
  const profiles = parseInstanceProfileList(stdout);
  assert.equal(profiles.length, 2);
  assert.equal(profiles[0].name, 'admin');
  assert.equal(profiles[0].is_default, true);
  assert.equal(profiles[1].is_default, false);
  assert.equal(profiles[1].username, 'reader');

  const allowed = filterProfiles(profiles, ['OTHER']);
  assert.deepEqual(
    allowed.map((row) => row.name),
    ['other']
  );
  assert.equal(filterProfiles(profiles, undefined).length, 2);

  assert.equal(queryLimit(undefined), 100);
  assert.equal(queryLimit(0), 1);
  assert.equal(queryLimit(500), 100);
  assert.equal(queryLimit('nope'), 100);

  assert.equal(resolveProfileName('', undefined, []), undefined);
  assert.equal(resolveProfileName('admin', undefined, []), 'admin');
  assert.throws(
    () => resolveProfileName('prod', ['pdi'], []),
    /mcpProfiles/
  );
  assert.equal(
    resolveProfileName('', ['admin'], filterProfiles(profiles, ['admin'])),
    'admin'
  );
  assert.throws(
    () => resolveProfileName('', ['other'], filterProfiles(profiles, ['other'])),
    /pass profile explicitly/
  );

  assert.deepEqual(instanceToolPayload({ status: 'success', result: [{ sys_id: 'abc' }] }), [
    { sys_id: 'abc' }
  ]);
  assert.deepEqual(instanceToolPayload([{ sys_id: 'abc' }]), [{ sys_id: 'abc' }]);

  const previousAllow = process.env.SNC_PROFILE_ALLOWLIST;
  process.env.SNC_PROFILE_ALLOWLIST = '[]';
  assert.equal(profileAllowlistFromEnv(), undefined);
  process.env.SNC_PROFILE_ALLOWLIST = '["pdi"]';
  assert.deepEqual(profileAllowlistFromEnv(), ['pdi']);
  process.env.SNC_PROFILE_ALLOWLIST = '{';
  assert.throws(() => profileAllowlistFromEnv(), /not valid JSON/);
  if (previousAllow === undefined) {
    delete process.env.SNC_PROFILE_ALLOWLIST;
  } else {
    process.env.SNC_PROFILE_ALLOWLIST = previousAllow;
  }

  const serverBundle = path.join(tempDir, 'instanceMcp.cjs');
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', 'src', 'instance', 'mcpServer.ts')],
    outfile: serverBundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  });
  const messages = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'smoke', version: '1.0.0' }
      }
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'record_query', arguments: { table: '   ' } }
    },
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'record_get', arguments: { table: 'incident' } }
    }
  ];
  const mcpRun = spawnSync(process.execPath, [serverBundle], {
    input: `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`,
    encoding: 'utf8',
    timeout: 5_000
  });
  assert.ok(
    !String(mcpRun.stdout).startsWith('Content-Length:'),
    'instance MCP must not emit LSP Content-Length framing'
  );
  const lines = String(mcpRun.stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const initialize = lines.find((line) => line.id === 1);
  const listed = lines.find((line) => line.id === 2);
  const emptyTable = lines.find((line) => line.id === 3);
  const missingId = lines.find((line) => line.id === 4);
  assert.equal(initialize.result.serverInfo.name, 'servicenow-xml-instance');
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    ['list_profiles', 'record_query', 'record_get']
  );
  assert.equal(emptyTable.result.isError, true);
  assert.match(emptyTable.result.content[0].text, /table is required/);
  assert.equal(missingId.result.isError, true);
  assert.match(missingId.result.content[0].text, /sys_id is required/);
  assert.strictEqual(mcpRun.status, 0, mcpRun.stderr);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
