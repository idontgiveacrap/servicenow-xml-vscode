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
    referenceTargetState,
    extractCallCandidates,
    buildCachedDependencies,
    queryDependencies,
    pickCanonicalRecord,
    parseExportRecordRow,
    aggregateRecords,
    outlineScriptMethods,
    methodSourceExcerpt,
    loadWorkspaceSnapshot,
    syncWorkspaceCache,
    RECORD_EXCERPT_CHARS
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
  const diag = registry.getDiagnosticsContext();
  assert.strictEqual(diag.projectFieldCount, 1);
  assert.ok(diag.projectTableCount >= 1);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(diag, 'fieldCount'), false);

  const dbObject = extractProjectSchema(
    '<sys_db_object><name>x_app_task</name><label>App task</label>' +
      '<super_class display_value="Task" name="task">bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb</super_class>' +
      '</sys_db_object>'
  );
  const appTask = dbObject.find((field) => field.table === 'x_app_task' && !field.element);
  assert.strictEqual(appTask && appTask.extends, 'task');
  assert.strictEqual(appTask && appTask.label, 'App task');
  const extendRegistry = new Registry();
  extendRegistry.setProjectOverlay(
    [
      {
        table: 'x_app_task',
        element: '',
        label: 'App task',
        uri: 'u',
        relativePath: 'u'
      },
      {
        table: 'x_app_task',
        element: '',
        extends: 'task',
        uri: 'u',
        relativePath: 'u'
      }
    ],
    []
  );
  assert.strictEqual(extendRegistry.projectTableExtends('x_app_task'), 'task');
  const databaseExtends = extractProjectSchema(
    '<database><element name="x_ext" type="collection" label="Ext" extends="task">' +
      '<element name="u_note" type="string" label="Note"/>' +
      '</element></database>'
  );
  assert.strictEqual(
    databaseExtends.find((field) => !field.element) &&
      databaseExtends.find((field) => !field.element).extends,
    'task'
  );

  const scriptXml =
    '<sys_script_include action="INSERT_OR_UPDATE"><sys_id>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</sys_id>' +
    '<script><![CDATA[var row = new Helper();]]></script></sys_script_include>';
  const calls = extractCallCandidates(
    scriptXml,
    [
      {
        table: 'sys_script_include',
        sysId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        startOffset: 0,
        action: 'INSERT_OR_UPDATE'
      }
    ],
    { uri: 'file:///t.xml', relativePath: 't.xml' }
  );
  const dependencyEdges = buildCachedDependencies({
    schemaFields: [
      {
        table: 'x_child',
        element: '',
        extends: 'task',
        uri: 'file:///t.xml',
        relativePath: 't.xml'
      }
    ],
    calls,
    declarationNames: new Set(['Helper'])
  });
  assert.ok(dependencyEdges.some((edge) => edge.kind === 'calls' && edge.to === 'Helper'));
  assert.ok(dependencyEdges.some((edge) => edge.kind === 'extends' && edge.from === 'x_child'));
  assert.strictEqual(
    buildCachedDependencies({
      schemaFields: [],
      calls,
      declarationNames: new Set(['Other'])
    }).length,
    0
  );
  const filtered = queryDependencies({
    kind: 'extends',
    from: 'x_child',
    limit: 10,
    references: [],
    dependencies: dependencyEdges
  });
  assert.strictEqual(filtered.total, 1);
  assert.strictEqual(filtered.dependencies[0].to, 'task');

  const rowXml =
    '<sys_script action="INSERT_OR_UPDATE"><short_description>Hello</short_description>' +
    '<assigned_to display_value="Abel">aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</assigned_to>' +
    '<script><![CDATA[' +
    'z'.repeat(RECORD_EXCERPT_CHARS + 50) +
    ']]></script></sys_script>';
  const omitted = parseExportRecordRow(rowXml, 'sys_script', false);
  assert.strictEqual(omitted.short_description, 'Hello');
  assert.deepStrictEqual(omitted.assigned_to, {
    value: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    display: 'Abel'
  });
  assert.strictEqual(omitted.script.language, 'javascript');
  assert.strictEqual(omitted.script.chars, RECORD_EXCERPT_CHARS + 50);
  assert.strictEqual(omitted.script.excerpt, undefined);
  const embedded = parseExportRecordRow(rowXml, 'sys_script', true);
  assert.strictEqual(embedded.script.excerpt.length, RECORD_EXCERPT_CHARS);
  assert.strictEqual(embedded.script.truncated, true);

  const older = {
    kind: 'Record',
    name: 'Rule',
    table: 'sys_script',
    displayName: 'Rule',
    sysId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    action: 'INSERT_OR_UPDATE',
    sysUpdatedOn: '2020-01-01 00:00:00',
    startOffset: 0
  };
  const newer = {
    ...older,
    sysUpdatedOn: '2024-06-01 00:00:00',
    relativePath: 'update/sys_script_new.xml'
  };
  assert.strictEqual(
    pickCanonicalRecord([older, newer], { sysId: older.sysId }).sysUpdatedOn,
    newer.sysUpdatedOn
  );
  const counted = aggregateRecords([
    { table: 'sys_script', action: 'INSERT_OR_UPDATE' },
    { table: 'sys_script', action: 'DELETE' },
    { table: 'sys_script_include', action: 'INSERT_OR_UPDATE' }
  ]);
  assert.strictEqual(counted.total, 3);
  assert.strictEqual(counted.tables[0].table, 'sys_script');
  assert.strictEqual(counted.tables[0].total, 2);
  assert.strictEqual(counted.tables[0].byAction.DELETE, 1);

  const outlined = outlineScriptMethods(
    'var Helper = Class.create();\nHelper.prototype.doWork = function(task, extra) {\n  return task;\n};\n'
  );
  assert.strictEqual(outlined[0] && outlined[0].name, 'doWork');
  assert.deepStrictEqual(outlined[0] && outlined[0].params, ['task', 'extra']);
  const longMethod =
    'Helper.prototype.doWork = function() {\n' + 'var a = 1;\n'.repeat(100) + '};\n';
  const excerpt = methodSourceExcerpt(longMethod, 'doWork');
  assert.ok(excerpt && excerpt.truncated);
  assert.ok(excerpt.excerpt.split(/\n/).length <= 80);

  const cacheRegistry = new Registry();
  const cacheFile = path.join(tempDir, 'registry-cache.json');
  const cacheDoc = (table) =>
    JSON.stringify({
      version: 2,
      workspaceKey: 'k',
      configKey: 'c',
      records: [
        {
          table: 'sys_script',
          displayName: 'Rule',
          sysId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          action: 'INSERT_OR_UPDATE',
          sysUpdatedOn: '2024-01-01 00:00:00',
          startOffset: 0,
          uri: 'file:///r.xml',
          relativePath: 'r.xml'
        },
        {
          table: 'sys_script',
          displayName: 'Rule old',
          sysId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          action: 'INSERT_OR_UPDATE',
          sysUpdatedOn: '2020-01-01 00:00:00',
          startOffset: 0,
          uri: 'file:///old.xml',
          relativePath: 'old.xml'
        }
      ],
      declarations: [],
      schemaFields: [
        {
          table,
          element: '',
          label: table,
          extends: 'task',
          uri: 'u',
          relativePath: 'u'
        },
        {
          table,
          element: 'u_col',
          internalType: 'string',
          uri: 'u',
          relativePath: 'u'
        }
      ],
      dependencies: [
        {
          kind: 'calls',
          from: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          to: 'Helper'
        }
      ]
    });
  fs.writeFileSync(cacheFile, cacheDoc('x_one'));
  const previousCachePath = process.env.REGISTRY_CACHE_PATH;
  process.env.REGISTRY_CACHE_PATH = cacheFile;
  const cacheState = { duplicateSysIds: [], cacheMtimeMs: 0 };
  assert.strictEqual(syncWorkspaceCache(cacheRegistry, cacheState), true);
  assert.strictEqual(cacheRegistry.getTable('x_one').fromWorkspace, true);
  assert.strictEqual(cacheRegistry.projectTableExtends('x_one'), 'task');
  assert.strictEqual(cacheState.duplicateSysIds.length, 1);
  assert.strictEqual(cacheState.duplicateSysIds[0].count, 2);
  assert.strictEqual(
    cacheRegistry.listDependencyEdges().some((edge) => edge.kind === 'calls'),
    true
  );
  assert.strictEqual(syncWorkspaceCache(cacheRegistry, cacheState), false);
  fs.writeFileSync(cacheFile, cacheDoc('x_two'));
  const touched = new Date(Date.now() + 10000);
  fs.utimesSync(cacheFile, touched, touched);
  assert.strictEqual(syncWorkspaceCache(cacheRegistry, cacheState), true);
  assert.strictEqual(cacheRegistry.getTable('x_one'), undefined);
  assert.strictEqual(cacheRegistry.getTable('x_two').name, 'x_two');
  loadWorkspaceSnapshot(cacheRegistry, cacheFile);
  if (previousCachePath === undefined) {
    delete process.env.REGISTRY_CACHE_PATH;
  } else {
    process.env.REGISTRY_CACHE_PATH = previousCachePath;
  }

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
  assert.strictEqual(
    detectSysAppMetadata(
      '<sys_app><scope>x_example</scope><version>1.2.3</version><short_description>My app</short_description></sys_app>'
    ).version,
    '1.2.3'
  );
  assert.strictEqual(
    detectSysAppMetadata(
      '<sys_app><scope>x_example</scope><version>1.2.3</version><short_description>My app</short_description></sys_app>'
    ).shortDescription,
    'My app'
  );

  console.log('registry smoke tests passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
