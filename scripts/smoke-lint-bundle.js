const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const esbuild = require('esbuild');
const { options } = require('../esbuild.js');

// Guards the bundling of eslint: its package entry loads RuleTester, which
// resolves espree at runtime and fails only once the bundle actually lints.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-lint-bundle-'));
const bundlePath = path.join(tempDir, 'jsLint.cjs');

try {
  esbuild.buildSync({
    ...options,
    entryPoints: [path.join(__dirname, '..', 'src', 'jsLint.ts')],
    outfile: bundlePath,
    sourcemap: false,
    minify: false,
    logLevel: 'silent'
  });

  const { lintScriptRegions } = require(bundlePath);
  const region = {
    decodedContent: 'var a = 1\nundeclared = 2\ngs.info(a)\n',
    content: 'var a = 1\nundeclared = 2\ngs.info(a)\n',
    profile: 'server',
    tableName: 'sys_script_include',
    action: 'INSERT_OR_UPDATE',
    fieldName: 'script',
    isCdata: true,
    bodyStartOffset: 0,
    bodyEndOffset: 35,
    line: 0,
    character: 0,
    language: 'javascript'
  };

  const diagnostics = lintScriptRegions([region]);
  const messages = diagnostics.map((d) => d.message).join(' | ');
  assert.ok(
    diagnostics.some((d) => d.message.includes('no-undef')),
    `bundled ESLint must report no-undef for an undeclared global, got: ${messages}`
  );
  assert.ok(
    !diagnostics.some((d) => d.message.includes('ESLint failed on')),
    `bundled ESLint must run without internal errors, got: ${messages}`
  );

  // ServiceNow calls script fields; the declarations it calls must not be
  // reported as unused, or every UX client script export shows warnings.
  const uxScript =
    'function handler({api, event, helpers, imports}) {\n' +
    '  var stale = 1\n' +
    '  api.setState("ready", true)\n' +
    '}\n';
  const uxDiagnostics = lintScriptRegions([
    {
      ...region,
      decodedContent: uxScript,
      content: uxScript,
      profile: 'client',
      tableName: 'sys_ux_client_script',
      bodyEndOffset: uxScript.length
    }
  ]);
  const uxMessages = uxDiagnostics.map((d) => d.message);
  for (const name of ['handler', 'event', 'helpers', 'imports']) {
    assert.ok(
      !uxMessages.some((m) => m.includes(`'${name}' is defined but never used`)),
      `platform entry point '${name}' must not be reported unused, got: ${uxMessages.join(' | ')}`
    );
  }
  assert.ok(
    uxMessages.some((m) => m.includes("'stale'")),
    `unused locals must still be reported, got: ${uxMessages.join(' | ')}`
  );

  console.log('lint bundle smoke test passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
