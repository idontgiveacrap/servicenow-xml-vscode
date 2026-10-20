import * as fs from 'fs';
import * as path from 'path';
import { parseSnXml } from '../src/parseSnXml';
import { classifyAndValidate } from '../src/kinds';
import { detectJavaScriptSupport, detectSysAppMetadata } from '../src/javascriptSupport';

const samples: Array<{ label: string; file: string; expect: string; required?: boolean }> = [
  {
    label: 'Fixture record_update',
    file: path.join(__dirname, '../fixtures/scoped_app_record_update/sys_script_include_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.xml'),
    expect: 'scoped_app_record_update',
    required: true
  },
  {
    label: 'Fixture unload metadata',
    file: path.join(__dirname, '../fixtures/scoped_app_record_update/unload_sys_script_include_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.xml'),
    expect: 'scoped_app_record_update',
    required: true
  },
  {
    label: 'Fixture remote update set',
    file: path.join(__dirname, '../fixtures/customer_update/sys_remote_update_set_00000000000000000000000000000000.xml'),
    expect: 'customer_update',
    required: true
  },
  {
    label: 'Fixture customer update',
    file: path.join(__dirname, '../fixtures/customer_update/sys_update_xml_00000000000000000000000000000000.xml'),
    expect: 'customer_update',
    required: true
  },
  {
    label: 'Fixture data export',
    file: path.join(__dirname, '../fixtures/data_record_export/x_example_0_staging.xml'),
    expect: 'data_record_export',
    required: true
  },
  {
    label: 'Fixture UX client script include CDATA',
    file: path.join(
      __dirname,
      '../fixtures/scoped_app_record_update/sys_ux_client_script_include_cccccccccccccccccccccccccccccccc.xml'
    ),
    expect: 'scoped_app_record_update',
    required: true
  },
  {
    label: 'Fixture UX macroponent JSON-in-XML',
    file: path.join(
      __dirname,
      '../fixtures/scoped_app_record_update/sys_ux_macroponent_dddddddddddddddddddddddddddddddd.xml'
    ),
    expect: 'scoped_app_record_update',
    required: true
  },
  {
    label: 'Fixture unload split-CDATA script',
    file: path.join(
      __dirname,
      '../fixtures/scoped_app_record_update/unload_sys_script_include_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.xml'
    ),
    expect: 'scoped_app_record_update',
    required: true
  },
  {
    label: 'Fixture CDATA fake nested script tags',
    file: path.join(
      __dirname,
      '../fixtures/scoped_app_record_update/sys_script_include_ffffffffffffffffffffffffffffffff.xml'
    ),
    expect: 'scoped_app_record_update',
    required: true
  },
  {
    label: 'Fixture UI page processing_script',
    file: path.join(
      __dirname,
      '../fixtures/scoped_app_record_update/sys_ui_page_11111111111111111111111111111111.xml'
    ),
    expect: 'scoped_app_record_update',
    required: true
  },
  {
    label: 'Fixture flow action entity-encoded script step',
    file: path.join(
      __dirname,
      '../fixtures/scoped_app_record_update/sys_hub_action_type_definition_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.xml'
    ),
    expect: 'scoped_app_record_update',
    required: true
  },
  {
    label: 'Fixture dictionary export',
    file: path.join(
      __dirname,
      '../fixtures/dictionary_export/x_example_0_compare_row.xml'
    ),
    expect: 'dictionary_export',
    required: true
  }
];

let failed = 0;

const supportSamples: Array<[string, string, 'ES5' | 'ES12']> = [
  [
    'ES latest scoped app',
    '<sys_app><scope>x_example_app</scope><js_level>es_latest</js_level></sys_app>',
    'ES12'
  ],
  [
    'ES latest global app',
    '<sys_app><scope>global</scope><js_level>es_latest</js_level></sys_app>',
    'ES5'
  ],
  [
    'ES latest app without scope',
    '<sys_app><js_level>es_latest</js_level></sys_app>',
    'ES5'
  ],
  ['ES5 app', '<sys_app><js_level>helsinki_es5</js_level></sys_app>', 'ES5'],
  ['missing metadata', '<sys_script><script>var x = 1;</script></sys_script>', 'ES5'],
  [
    'js_level text outside sys_app',
    '<sys_script><script><![CDATA[var x = "<js_level>es_latest</js_level>";]]></script></sys_script>',
    'ES5'
  ]
];
for (const [label, xml, expected] of supportSamples) {
  const actual = detectJavaScriptSupport(xml);
  if (actual !== expected) {
    console.log(`FAIL ${label}: JavaScript support=${actual}, expected ${expected}`);
    failed++;
  }
}

{
  const meta = detectSysAppMetadata(
    '<sys_app><sys_id>bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb</sys_id><scope>x_example</scope><js_level>es_latest</js_level></sys_app>'
  );
  if (meta?.scope !== 'x_example' || meta?.sysId !== 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') {
    console.log(`FAIL sys_app metadata: ${JSON.stringify(meta)}`);
    failed++;
  }
}

{
  const result = classifyAndValidate(
    parseSnXml('<database><element label="Unnamed"/></database>')
  );
  const codes = result.diagnostics.map((d) => d.code);
  if (
    result.kind !== 'dictionary_export' ||
    !codes.includes('dictionary-no-table-element')
  ) {
    console.log(
      `FAIL dictionary root without a named table element: kind=${result.kind} [${codes.join(', ')}]`
    );
    failed++;
  }
}

{
  const sysId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const result = classifyAndValidate(
    parseSnXml(
      `<record_update><sys_script_include action="INSERT_OR_UPDATE"><sys_id>${sysId}</sys_id><sys_scope>bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb</sys_scope><sys_update_name>sys_script_include_cccccccccccccccccccccccccccccccc</sys_update_name></sys_script_include></record_update>`,
      `sys_script_include_${sysId}.xml`
    )
  );
  const codes = result.diagnostics.map((d) => d.code);
  if (!codes.includes('scoped-sys-update-name-mismatch')) {
    console.log(
      `FAIL mismatched sys_update_name: kind=${result.kind} [${codes.join(', ')}]`
    );
    failed++;
  }
}

{
  // sys_update_version payload CDATA embeds the source record's sys_update_name;
  // that must not be compared to sys_update_version_{version_sys_id}.
  const versionId = '5a4eced987a30350498aa9b70cbb356d';
  const sourceName = 'sys_security_acl_a8f82b311dbb5bd1acb4fd1e162f354b';
  const result = classifyAndValidate(
    parseSnXml(
      `<record_update table="sys_security_acl"><sys_update_version action="INSERT_OR_UPDATE"><name>${sourceName}</name><payload><![CDATA[<record_update><sys_security_acl action="INSERT_OR_UPDATE"><sys_id>a8f82b311dbb5bd1acb4fd1e162f354b</sys_id><sys_update_name>${sourceName}</sys_update_name></sys_security_acl></record_update>]]></payload><sys_id>${versionId}</sys_id></sys_update_version><sys_metadata_delete action="INSERT_OR_UPDATE"><sys_id>100ece5f4955403481db6ba52602f144</sys_id><sys_metadata>a8f82b311dbb5bd1acb4fd1e162f354b</sys_metadata><sys_db_object name="sys_security_acl">sys_security_acl</sys_db_object><sys_scope>bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb</sys_scope><sys_update_name>${sourceName}</sys_update_name></sys_metadata_delete></record_update>`,
      `sys_security_acl_a8f82b311dbb5bd1acb4fd1e162f354b.xml`
    )
  );
  const codes = result.diagnostics.map((d) => d.code);
  if (codes.includes('scoped-sys-update-name-mismatch')) {
    console.log(
      `FAIL version/delete-metadata sys_update_name false positive: kind=${result.kind} [${codes.join(', ')}]`
    );
    failed++;
  }
}

{
  const sysId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const payload = `<record_update><sys_script_include action="INSERT_OR_UPDATE"><sys_id>${sysId}</sys_id><sys_update_name>sys_script_include_cccccccccccccccccccccccccccccccc</sys_update_name></sys_script_include></record_update>`;
  const result = classifyAndValidate(
    parseSnXml(
      `<unload><sys_update_xml action="INSERT_OR_UPDATE"><name>sys_script_include_${sysId}</name><payload><![CDATA[${payload}]]></payload><sys_id>bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb</sys_id><type>Script Include</type></sys_update_xml></unload>`
    )
  );
  const codes = result.diagnostics.map((d) => d.code);
  if (!codes.includes('cu-payload-sys-update-name-mismatch')) {
    console.log(
      `FAIL mismatched payload sys_update_name: kind=${result.kind} [${codes.join(', ')}]`
    );
    failed++;
  }
}

for (const s of samples) {
  if (!fs.existsSync(s.file)) {
    if (s.required) {
      console.log(`FAIL ${s.label}: required fixture missing`);
      failed++;
    } else {
      console.log(`SKIP ${s.label} (missing file)`);
    }
    continue;
  }
  const text = fs.readFileSync(s.file, 'utf8');
  const parsed = parseSnXml(text, s.file);
  const result = classifyAndValidate(parsed);
  const ok = result.kind === s.expect;
  const rowCount = parsed.rows.length;
  const jsonFields = parsed.rows.reduce(
    (n, r) => n + r.embeddedFields.filter((f) => f.language === 'json').length,
    0
  );
  const codes = result.diagnostics.map((d) => d.code).filter(Boolean);
  console.log(
    `${ok ? 'OK' : 'FAIL'} ${s.label}: kind=${result.kind} rows=${rowCount} jsonFields=${jsonFields} diags=${result.diagnostics.length} [${codes.join(', ')}]`
  );
  if (!ok) {
    failed++;
    console.log(`  expected ${s.expect}`);
  }
}

process.exit(failed ? 1 : 0);
