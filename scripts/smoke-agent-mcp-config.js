const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-xml-mcp-config-'));
const bundlePath = path.join(tempDir, 'agentMcpConfig.cjs');

esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'agentMcpConfig.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
  external: ['vscode']
});

const {
  buildAgentMcpServerSpecs,
  mergeJsonMcpFile,
  mergeCodexToml
} = require(bundlePath);

const ourIds = new Set([
  'servicenow-xml-docs',
  'servicenow-xml-ui-examples',
  'servicenow-xml-registry',
  'servicenow-xml-instance'
]);

const servers = buildAgentMcpServerSpecs({
  mcpEnable: true,
  includeRemote: true,
  includeRegistry: false,
  includeInstance: false,
  registryScript: path.join(tempDir, 'missing-registry.js'),
  registryDataDir: tempDir,
  instanceScript: path.join(tempDir, 'missing-instance.js'),
  sncPath: 'snc',
  sncProfileAllowlist: '[]',
  usageLogPath: path.join(tempDir, 'mcp-usage.log'),
  launch: { command: process.execPath, env: {} }
});
assert.strictEqual(servers.length, 2, 'expected two remote MCP servers');

const jsonPath = path.join(tempDir, 'mcp.json');
fs.writeFileSync(
  jsonPath,
  JSON.stringify(
    {
      mcpServers: {
        'other-server': { command: 'echo', args: ['hi'] },
        'servicenow-xml-docs': { url: 'https://old.example' }
      }
    },
    null,
    2
  ) + '\n'
);

const messages = [];
assert.strictEqual(
  mergeJsonMcpFile(jsonPath, 'copilot-cli', servers, ourIds, messages),
  true
);
const afterFirst = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
assert.ok(afterFirst.mcpServers['other-server']);
assert.strictEqual(
  afterFirst.mcpServers['servicenow-xml-docs'].url,
  'https://gitmcp.io/ServiceNow/ServiceNowDocs'
);
assert.strictEqual(
  mergeJsonMcpFile(jsonPath, 'copilot-cli', servers, ourIds, messages),
  false
);

const tomlPath = path.join(tempDir, 'config.toml');
fs.writeFileSync(tomlPath, 'model = "test"\n');
assert.strictEqual(mergeCodexToml(tomlPath, servers, ourIds, messages), true);
const toml = fs.readFileSync(tomlPath, 'utf8');
assert.ok(toml.includes('[mcp_servers.servicenow-xml-docs]'));
assert.ok(toml.includes('begin managed-by: servicenow-xml-mcp'));
assert.strictEqual(mergeCodexToml(tomlPath, [], ourIds, messages), true);
assert.ok(!fs.readFileSync(tomlPath, 'utf8').includes('[mcp_servers.servicenow-xml-docs]'));

console.log('smoke-agent-mcp-config: ok');
