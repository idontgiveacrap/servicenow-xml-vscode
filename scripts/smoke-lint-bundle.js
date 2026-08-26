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
  const undefNames = (source, profile, tableName, extras, callerScope) =>
    lintScriptRegions(
      [
        {
          ...region,
          decodedContent: source,
          content: source,
          profile,
          tableName,
          callerScope,
          bodyEndOffset: source.length
        }
      ],
      extras
    )
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

  // The bundled scope list covers scopes that own no whitelisted Script
  // Include, so the namespace half of `<scope>.<Name>` resolves on its own.
  const scopeNamespaces = undefNames(
    'var a = new sn_appcreator.SomeUtil()\nvar b = new x_not_a_real_scope.SomeUtil()\n',
    'server',
    'sys_script_include'
  );
  assert.ok(
    !scopeNamespaces.some((m) => m.includes("'sn_appcreator'")),
    `bundled scopes must not be no-undef, got: ${scopeNamespaces.join(' | ')}`
  );
  assert.ok(
    scopeNamespaces.some((m) => m.includes("'x_not_a_real_scope'")),
    `unknown scopes must still be no-undef, got: ${scopeNamespaces.join(' | ')}`
  );

  const extras = [
    {
      table: 'sys_script_include',
      profile: 'server',
      scope: 'global',
      name: 'customUtil'
    },
    {
      table: 'sys_script_include',
      profile: 'server',
      scope: 'x_app',
      name: 'AppUtil'
    },
    {
      table: 'sys_ui_script',
      profile: 'client',
      scope: 'global',
      name: 'GlobalUi'
    },
    {
      table: 'sys_ui_script',
      profile: 'client',
      scope: 'x_app',
      name: 'AppUi'
    },
    {
      table: 'sys_ux_client_script_include',
      profile: 'client',
      scope: 'x_other',
      name: 'OtherCsi'
    }
  ];

  const scopedCaller = undefNames(
    'var a = new customUtil()\nvar b = new AppUtil()\nvar c = global.customUtil\nvar d = new ArrayUtil()\n',
    'server',
    'sys_script',
    extras,
    'x_app'
  );
  assert.ok(
    scopedCaller.some((m) => m.includes("'customUtil'")),
    `global SI must not be bare from a scoped caller, got: ${scopedCaller.join(' | ')}`
  );
  assert.ok(
    !scopedCaller.some((m) => m.includes("'AppUtil'")),
    `same-scope SI must be bare from that scope, got: ${scopedCaller.join(' | ')}`
  );
  assert.ok(
    !scopedCaller.some((m) => m.includes("'global'")),
    `scoped callers must have the global namespace, got: ${scopedCaller.join(' | ')}`
  );
  assert.ok(
    scopedCaller.some((m) => m.includes("'ArrayUtil'")),
    `bundled global SIs must not be bare from a scoped caller, got: ${scopedCaller.join(' | ')}`
  );

  const globalCaller = undefNames(
    'var a = new customUtil()\nvar b = new AppUtil()\nvar c = global.customUtil\n',
    'server',
    'sys_script',
    extras
  );
  assert.ok(
    !globalCaller.some((m) => m.includes("'customUtil'")),
    `global SI must be bare from global scope, got: ${globalCaller.join(' | ')}`
  );
  assert.ok(
    globalCaller.some((m) => m.includes("'AppUtil'")),
    `scoped SI must not be bare from global scope, got: ${globalCaller.join(' | ')}`
  );
  assert.ok(
    globalCaller.some((m) => m.includes("'global'")),
    `global.Name must not be defined in global scope, got: ${globalCaller.join(' | ')}`
  );

  const clientScoped = undefNames(
    'var a = GlobalUi\nvar b = AppUi\nvar c = OtherCsi\nvar d = global.GlobalUi\n',
    'client',
    'sys_client_script',
    extras,
    'x_app'
  );
  assert.ok(
    !clientScoped.some((m) => m.includes("'GlobalUi'") || m.includes("'AppUi'")),
    `global and same-scope UI scripts must be client globals, got: ${clientScoped.join(' | ')}`
  );
  assert.ok(
    clientScoped.some((m) => m.includes("'OtherCsi'")),
    `other-scope UX CSI must stay undef, got: ${clientScoped.join(' | ')}`
  );
  assert.ok(
    clientScoped.some((m) => m.includes("'global'")),
    `client types must not use global.Name, got: ${clientScoped.join(' | ')}`
  );

  const clientGlobal = undefNames(
    'var a = GlobalUi\nvar b = AppUi\n',
    'client',
    'sys_client_script',
    extras
  );
  assert.ok(
    !clientGlobal.some((m) => m.includes("'GlobalUi'")),
    `global UI scripts must be bare for a global client caller, got: ${clientGlobal.join(' | ')}`
  );
  assert.ok(
    clientGlobal.some((m) => m.includes("'AppUi'")),
    `scoped UI scripts must not be bare for a global client caller, got: ${clientGlobal.join(' | ')}`
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

  // A Script Include's own name is a lint global, so its defining declaration
  // must not be reported as redeclaring a built-in.
  const ownDeclaration = lintScriptRegions(
    [
      {
        ...region,
        decodedContent: 'var customUtil = Class.create()\n',
        content: 'var customUtil = Class.create()\n',
        bodyEndOffset: 31
      }
    ],
    extras
  );
  assert.ok(
    !ownDeclaration.some((d) => d.code === 'no-redeclare'),
    `a Script Include's own declaration must not be no-redeclare, got: ${ownDeclaration
      .map((d) => d.message)
      .join(' | ')}`
  );

  const duplicateVar = 'var dupe = 1\nvar dupe = 2\n';
  const duplicates = lintScriptRegions([
    {
      ...region,
      decodedContent: duplicateVar,
      content: duplicateVar,
      bodyEndOffset: duplicateVar.length
    }
  ]);
  assert.ok(
    duplicates.some((d) => d.code === 'no-redeclare'),
    `duplicate declarations in one script must still be no-redeclare, got: ${duplicates
      .map((d) => d.message)
      .join(' | ')}`
  );

  // Shadowing a global the platform binds must still be reported, while names
  // that are globals only because the linter registers them must not be.
  const SHADOW_RULE = 'servicenow-xml/no-shadowed-platform-global';
  const shadowNames = (
    source,
    profile,
    extras,
    javascriptSupport,
    ownDeclarationName
  ) =>
    lintScriptRegions(
      [
        {
          ...region,
          decodedContent: source,
          content: source,
          profile,
          javascriptSupport: javascriptSupport ?? 'ES5',
          ownDeclarationName,
          bodyEndOffset: source.length
        }
      ],
      extras
    )
      .filter((d) => d.code === SHADOW_RULE)
      .map((d) => d.message);

  const platformShadow = shadowNames(
    'var gs = 1\nvar GlideRecord = 2\nvar current = 3\nvar Object = 4\n',
    'server'
  );
  for (const name of ['gs', 'GlideRecord', 'current', 'Object']) {
    assert.ok(
      platformShadow.some((m) => m.includes(`'${name}'`)),
      `shadowing platform global '${name}' must be reported, got: ${platformShadow.join(' | ')}`
    );
  }

  assert.strictEqual(
    shadowNames(
      'var customUtil = Class.create()\n',
      'server',
      extras,
      'ES5',
      'customUtil'
    ).length,
    0,
    "a Script Include's own declaration must not be reported as shadowing"
  );

  // Records found in the workspace are source, not platform API, so they are
  // exempt; a bundled Script Include is supplied by the instance, so declaring
  // its name shadows it.
  assert.strictEqual(
    shadowNames('var customUtil = 1\n', 'server', extras).length,
    0,
    'workspace Script Include names must not be treated as platform globals'
  );
  assert.ok(
    shadowNames("var JSUtil = 'asdf'\n", 'server').some((m) =>
      m.includes("'JSUtil'")
    ),
    'shadowing a bundled platform Script Include must be reported'
  );

  // The own-name exemption also has to hold without the record reaching the
  // declaration index, which is what happens when it is inactive.
  assert.strictEqual(
    shadowNames("var JSUtil = 'asdf'\n", 'server', [], 'ES5', 'JSUtil').length,
    0,
    'a record that overrides a bundled name must be able to declare it'
  );

  // The server profile carries client globals only to tolerate mixed code.
  assert.strictEqual(
    shadowNames('var parent = current.parent\nvar location = 1\n', 'server')
      .length,
    0,
    'client-only names must be declarable in a server script'
  );
  assert.ok(
    shadowNames('var parent = 1\n', 'client').some((m) => m.includes("'parent'")),
    'client globals must still be reported in a client script'
  );

  // A nested declaration shadows the API for its function, so it is reported
  // wherever it appears. This is the shape a Script Include method has.
  const nestedShadow = shadowNames(
    'var X = Class.create();\nX.prototype = {\n' +
      "  initialize: function () {\n    var GlideRecord = 'asdf';\n" +
      "    var JSUtil = 'asdf';\n  },\n  type: 'X'\n};\n",
    'server',
    [],
    'ES12',
    'X'
  );
  for (const name of ['GlideRecord', 'JSUtil']) {
    assert.ok(
      nestedShadow.some((m) => m.includes(`'${name}'`)),
      `a nested declaration of '${name}' must be reported, got: ${nestedShadow.join(' | ')}`
    );
  }

  // Entry-point and wrapper-idiom names are rebound in inner scopes on purpose.
  assert.strictEqual(
    shadowNames('function run(current) { return current }\n', 'server').length,
    0,
    'a helper taking current as a parameter must stay quiet'
  );
  assert.strictEqual(
    shadowNames(
      'function handler({api, event, imports}) { api.setState(event, imports) }\n',
      'client',
      [],
      'ES12'
    ).length,
    0,
    'UX client script handler parameters must stay quiet'
  );
  assert.strictEqual(
    shadowNames('(function ($) { $("#x") })(jQuery)\n', 'client').length,
    0,
    'the jQuery wrapper idiom must stay quiet'
  );
  assert.ok(
    shadowNames('var current = 1\n', 'server').some((m) =>
      m.includes("'current'")
    ),
    'a top-level entry-point declaration must still be reported'
  );

  // Assigning to a global replaces a platform or workspace value; the owning
  // record may still assign its own name without `var`.
  const globalAssign = (source, ownDeclarationName) =>
    lintScriptRegions(
      [
        {
          ...region,
          decodedContent: source,
          content: source,
          ownDeclarationName,
          bodyEndOffset: source.length
        }
      ],
      extras
    )
      .filter((d) => d.code === 'no-global-assign')
      .map((d) => d.message);

  assert.ok(
    globalAssign('customUtil = 123\n').some((m) => m.includes("'customUtil'")),
    'assigning to another record\'s global must be reported'
  );
  assert.ok(
    globalAssign('gs = 123\n').some((m) => m.includes("'gs'")),
    'assigning to a platform global must be reported'
  );
  assert.strictEqual(
    globalAssign('customUtil = Class.create()\n', 'customUtil').length,
    0,
    'a record may assign its own name without var'
  );

  // ES5 instances have no Promise, so a polyfill is a declaration, not a shadow.
  assert.strictEqual(
    shadowNames('var Promise = function () {}\n', 'server', [], 'ES5').length,
    0,
    'ES5 feature polyfills must not be reported as shadowing'
  );
  assert.ok(
    shadowNames('var Promise = function () {}\n', 'server', [], 'ES12').some((m) =>
      m.includes("'Promise'")
    ),
    'ES12 supplies Promise, so declaring it must be reported'
  );

  // A parse error suppresses every rule for the field, so the diagnostic has to
  // say that rather than leave the other checks looking clean.
  const broken = "var GlideRecord = 'a'\nvar global.JSUtil = 'b'\n";
  const brokenDiagnostics = lintScriptRegions([
    {
      ...region,
      decodedContent: broken,
      content: broken,
      javascriptSupport: 'ES12',
      bodyEndOffset: broken.length
    }
  ]);
  assert.strictEqual(
    brokenDiagnostics.length,
    1,
    `a parse error must be the only diagnostic, got: ${brokenDiagnostics
      .map((d) => d.message)
      .join(' | ')}`
  );
  assert.strictEqual(brokenDiagnostics[0].code, 'eslint-parse-error');
  assert.ok(
    brokenDiagnostics[0].message.includes('No other checks ran'),
    `a parse error must report that it suppressed the rules, got: ${brokenDiagnostics[0].message}`
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
