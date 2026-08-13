import * as fs from 'fs';
import * as path from 'path';
import { parseSnXml } from '../src/parseSnXml';
import { classifyAndValidate } from '../src/kinds';

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
  }
];

let failed = 0;
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
