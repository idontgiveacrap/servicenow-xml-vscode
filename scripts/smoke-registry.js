const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
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
    cachedDeclarationsToSymbols,
    loadStaticPacks,
    lintSchemaTableArgs,
    scriptCompletions,
    workspaceDeclarationsFromRegistry,
    attachScriptingDocs,
    platformGlobalsMap,
    DictionaryFieldIndex,
    mergeSchemaFields,
    extractProjectSchema,
    extractXmlReferences,
    referenceTargetState
  } = require(bundlePath);

  const mcpHarnessEntry = path.join(tempDir, 'mcp-harness.js');
  const mcpHarnessBundle = path.join(tempDir, 'mcp-harness.cjs');
  fs.writeFileSync(
    mcpHarnessEntry,
    `const { runMcpStdio } = require(${JSON.stringify(
      path.join(__dirname, '..', 'src', 'registry', 'mcpStdio.ts')
    )});
runMcpStdio({
  name: 'smoke-mcp',
  version: '1.0.0',
  tools: [],
  callTool: async () => ({ ok: true })
});
`
  );
  esbuild.buildSync({
    entryPoints: [mcpHarnessEntry],
    outfile: mcpHarnessBundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  });
  const initialize = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '1.0.0' }
    }
  });
  const mcpRun = spawnSync(process.execPath, [mcpHarnessBundle], {
    input: `${initialize}\n`,
    encoding: 'utf8',
    timeout: 5_000
  });
  assert.strictEqual(mcpRun.status, 0, mcpRun.stderr);
  assert.ok(
    !mcpRun.stdout.startsWith('Content-Length:'),
    'MCP stdio must not emit LSP Content-Length framing'
  );
  const initializeResponse = JSON.parse(mcpRun.stdout.trim());
  assert.strictEqual(initializeResponse.id, 1);
  assert.strictEqual(initializeResponse.result.serverInfo.name, 'smoke-mcp');

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

  attachScriptingDocs(registry, {
    server: [{ name: 'GlideRecord', description: 'Record API' }],
    undocumented: [{ api: 'gs', members: 'nil', description: 'nil check' }]
  });
  const glide = registry.lookup('GlideRecord').find((symbol) => symbol.doc);
  assert.strictEqual(glide.docsOnly, true);
  assert.strictEqual(glide.documentation, 'Record API');
  assert.ok(!platformGlobalsMap(registry, 'server').GlideRecord);
  const gs = registry.lookup('gs').find((symbol) => symbol.kind === 'Global');
  assert.strictEqual(gs.docSection, 'undocumented');
  assert.strictEqual(platformGlobalsMap(registry, 'server').gs, 'readonly');

  const zlib = require('zlib');
  const fieldsPath = path.join(tempDir, 'fields.json.gz');
  fs.writeFileSync(
    fieldsPath,
    zlib.gzipSync(
      Buffer.from(
        JSON.stringify({
          version: 1,
          fields: {
            incident: [
              {
                element: 'caller_id',
                label: 'Caller',
                internalType: 'reference',
                reference: 'sys_user'
              }
            ]
          }
        })
      )
    )
  );
  const fieldIndex = new DictionaryFieldIndex(registry, fieldsPath);
  const caller = fieldIndex.searchFields('Caller', 10);
  assert.strictEqual(caller[0].name, 'caller_id');
  assert.strictEqual(caller[0].label, 'Caller');
  assert.strictEqual(caller[0].type, 'reference');
  assert.strictEqual(caller[0].reference, 'sys_user');
  assert.strictEqual(fieldIndex.fieldsFor('incident').length, 1);

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

  registry.upsertMany(
    cachedDeclarationsToSymbols([
      {
        table: 'sys_script',
        profile: 'server',
        scope: 'global',
        name: 'fromBefore',
        uri: 'file:///tmp/br.xml'
      },
      {
        table: 'sys_script_include',
        profile: 'server',
        scope: 'global',
        name: 'MyUtil',
        uri: 'file:///tmp/si.xml'
      }
    ])
  );
  registry.upsert({
    kind: 'Field',
    name: 'number',
    table: 'incident',
    element: 'number',
    internalType: 'string'
  });
  const decls = workspaceDeclarationsFromRegistry(registry);
  assert.ok(decls.some((d) => d.table === 'sys_script' && d.name === 'fromBefore'));

  const code =
    "var gr = new GlideRecord('incident');\ngr.\nvar util = new MyUtil();\nutil.\nfrom\nnew My";
  const fieldAt = code.indexOf('gr.') + 'gr.'.length;
  const fields = scriptCompletions({
    code,
    cursor: fieldAt,
    profile: 'server',
    registry
  });
  assert.ok(fields.some((item) => item.label === 'number' && item.kind === 'field'));

  const methodAt = code.indexOf('util.') + 'util.'.length;
  const methods = scriptCompletions({
    code,
    cursor: methodAt,
    profile: 'server',
    registry,
    readFile: () =>
      '<script><![CDATA[var MyUtil = Class.create();\nMyUtil.prototype = { initialize: function() {}, doWork: function() {} };]]></script>'
  });
  assert.ok(methods.some((item) => item.label === 'doWork' && item.kind === 'method'));
  assert.ok(!methods.some((item) => item.label === 'type'));

  const bareAt = code.indexOf('from') + 'from'.length;
  const bare = scriptCompletions({
    code,
    cursor: bareAt,
    profile: 'server',
    registry
  });
  assert.ok(bare.some((item) => item.label === 'fromBefore' && item.kind === 'function'));

  const ctorAt = code.length;
  const ctors = scriptCompletions({
    code,
    cursor: ctorAt,
    profile: 'server',
    registry
  });
  assert.ok(ctors.some((item) => item.label === 'MyUtil'));
  assert.ok(!ctors.some((item) => item.label === 'fromBefore'));

  const outside = scriptCompletions({
    code: 'var gr = new GlideRecord(\'incident\');\n',
    cursor: 0,
    profile: 'server',
    registry
  });
  assert.deepStrictEqual(outside, []);

  const schemaXml = fs.readFileSync(
    path.join(
      __dirname,
      '..',
      'fixtures',
      'dictionary_export',
      'x_example_0_compare_row.xml'
    ),
    'utf8'
  );
  const projectSchema = extractProjectSchema(schemaXml);
  const parent = projectSchema.find((field) => field.element === 'parent');
  assert.strictEqual(parent && parent.table, 'x_example_0_compare_row');
  assert.strictEqual(parent && parent.internalType, 'reference');
  assert.strictEqual(parent && parent.reference, 'x_example_0_compare_row');
  assert.ok(!projectSchema.some((field) => field.element === 'N'));

  const merged = mergeSchemaFields(
    [
      {
        table: 'incident',
        name: 'caller_id',
        type: 'reference',
        reference: 'sys_user'
      }
    ],
    [
      {
        table: 'incident',
        element: 'caller_id',
        label: 'Caller',
        internalType: 'reference',
        reference: 'sys_user',
        uri: 'u',
        relativePath: 'u'
      },
      {
        table: 'incident',
        element: 'u_extra',
        label: 'Extra',
        internalType: 'string',
        uri: 'u',
        relativePath: 'u'
      }
    ]
  );
  const projectCaller = merged.find((field) => field.name === 'caller_id');
  assert.strictEqual(projectCaller && projectCaller.source, 'project');
  assert.strictEqual(projectCaller && projectCaller.label, 'Caller');
  assert.ok(merged.some((field) => field.name === 'u_extra' && field.source === 'project'));

  const refXml =
    '<?xml version="1.0"?><record_update>' +
    '<sys_script action="INSERT_OR_UPDATE"><sys_id>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</sys_id>' +
    '<sys_scope>bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb</sys_scope>' +
    '<script><![CDATA[var id = "dddddddddddddddddddddddddddddddd";]]></script>' +
    '</sys_script>' +
    '<sys_script action="DELETE"><sys_id>bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb</sys_id></sys_script>' +
    '</record_update>';
  const edges = extractXmlReferences(refXml, {
    uri: 'file:///t.xml',
    relativePath: 't.xml'
  });
  assert.ok(
    edges.some(
      (edge) =>
        edge.element === 'sys_scope' &&
        edge.toSysId === 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    )
  );
  assert.ok(!edges.some((edge) => edge.toSysId.startsWith('dddd')));
  assert.strictEqual(
    referenceTargetState(
      [{ sysId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', action: 'DELETE' }],
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    ),
    'deleted'
  );
  assert.strictEqual(
    referenceTargetState(
      [
        { sysId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', action: 'DELETE' },
        { sysId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', action: 'INSERT_OR_UPDATE' }
      ],
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    ),
    'in_project'
  );
  assert.strictEqual(
    referenceTargetState([], 'cccccccccccccccccccccccccccccccc'),
    'not_in_project'
  );

  registry.setProjectOverlay(
    [
      {
        table: 'x_only_table',
        element: '',
        label: 'Only',
        uri: 'u',
        relativePath: 'u'
      },
      {
        table: 'x_only_table',
        element: 'u_col',
        label: 'Col',
        internalType: 'string',
        uri: 'u',
        relativePath: 'u'
      }
    ],
    []
  );
  assert.strictEqual(registry.getTable('x_only_table').label, 'Only');
  assert.strictEqual(registry.getField('x_only_table', 'u_col').fromWorkspace, true);

  const jsBundle = path.join(tempDir, 'js.cjs');
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', 'src', 'javascriptSupport.ts')],
    outfile: jsBundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  });
  const { detectSysAppMetadata } = require(jsBundle);
  assert.strictEqual(
    detectSysAppMetadata(
      '<sys_app><scope>x_example</scope><restrict_table_access>true</restrict_table_access></sys_app>'
    ).restrictTableAccess,
    true
  );
  assert.strictEqual(
    detectSysAppMetadata(
      '<sys_app><restrict_table_access>false</restrict_table_access></sys_app>'
    ).restrictTableAccess,
    false
  );

  console.log('registry smoke tests passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
