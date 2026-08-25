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
      javascriptSupport: 'ES12',
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

  // Script Include whitelist: global-scope names resolve bare, other scopes
  // resolve only through their namespace, and unknown names still fail.
  const undefNames = (source, profile, tableName) =>
    lintScriptRegions([
      {
        ...region,
        decodedContent: source,
        content: source,
        profile,
        tableName,
        bodyEndOffset: source.length
      }
    ])
      .filter((d) => d.code === 'no-undef')
      .map((d) => d.message);

  const serverSource =
    'var a = new ArrayUtil()\n' +
    'var b = new GlideRecordUtil()\n' +
    'var c = new sn_cmdb_ws.SomethingScoped()\n' +
    'var d = new NotARealScriptIncludeXyz()\n';
  const serverUndef = undefNames(serverSource, 'server', 'sys_script_include');
  for (const name of ['ArrayUtil', 'GlideRecordUtil', 'sn_cmdb_ws']) {
    assert.ok(
      !serverUndef.some((m) => m.includes(`'${name}'`)),
      `whitelisted '${name}' must not be no-undef, got: ${serverUndef.join(' | ')}`
    );
  }
  assert.ok(
    serverUndef.some((m) => m.includes("'NotARealScriptIncludeXyz'")),
    `unknown Script Includes must still be no-undef, got: ${serverUndef.join(' | ')}`
  );

  // A scoped Script Include is not reachable by bare name from another scope.
  const bareScoped = undefNames(
    'var x = new SomethingScoped()\n',
    'server',
    'sys_script_include'
  );
  assert.ok(
    bareScoped.some((m) => m.includes("'SomethingScoped'")),
    `scoped Script Includes must not be whitelisted as bare names, got: ${bareScoped.join(' | ')}`
  );

  // GlideAjax is the client entry point to a client-callable Script Include.
  const clientUndef = undefNames(
    'var ga = new GlideAjax("HelloWorld")\nga.getXMLAnswer(function (a) { g_form.setValue("x", a) })\n',
    'client',
    'sys_client_script'
  );
  assert.strictEqual(
    clientUndef.length,
    0,
    `GlideAjax/g_form must be defined for client scripts, got: ${clientUndef.join(' | ')}`
  );

  // ServiceNow rules are selected by the application JavaScript mode. Unknown
  // metadata defaults to ES5, while ES12 permits features supported by that mode.
  const lintForSupport = (source, javascriptSupport) =>
    lintScriptRegions([
      {
        ...region,
        decodedContent: source,
        content: source,
        javascriptSupport,
        bodyEndOffset: source.length
      }
    ]);

  const es5Promise = lintForSupport('var p = new Promise(function () {})\n', 'ES5');
  assert.ok(
    es5Promise.some(
      (d) =>
        d.code === 'servicenow/no-promise' &&
        d.message.includes('[ES5]')
    ),
    `ES5 Promise use must carry a level-tagged platform warning, got: ${es5Promise
      .map((d) => d.message)
      .join(' | ')}`
  );

  const es12Promise = lintForSupport(
    'var p = new Promise(function () {})\n',
    'ES12'
  );
  assert.ok(
    !es12Promise.some((d) => d.code === 'servicenow/no-promise'),
    `ES12 Promise use must be allowed, got: ${es12Promise
      .map((d) => d.message)
      .join(' | ')}`
  );

  const es12Atomics = lintForSupport('Atomics.add(buffer, 0, 1)\n', 'ES12');
  assert.ok(
    es12Atomics.some(
      (d) =>
        d.code === 'servicenow/no-shared-memory-atomics' &&
        d.message.includes('[ES12]')
    ),
    `unsupported ES12 features must identify the active level, got: ${es12Atomics
      .map((d) => d.message)
      .join(' | ')}`
  );

  console.log('lint bundle smoke test passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
