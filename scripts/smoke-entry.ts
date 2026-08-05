import * as fs from 'fs';
import * as path from 'path';
import { parseSnXml } from '../src/parseSnXml';
import { classifyAndValidate } from '../src/kinds';

const samples: Array<{ label: string; file: string; expect: string }> = [
  {
    label: 'Downloads script include unload',
    file: 'C:/Users/jsmith/Downloads/sys_script_include_c24cb7adc3e8471086f39f3ed40131fd.xml',
    expect: 'scoped_app_record_update'
  },
  {
    label: 'Downloads remote update set',
    file: 'C:/Users/jsmith/Downloads/sys_remote_update_set_ae59f0d9c362cf5486f39f3ed40131bf.xml',
    expect: 'customer_update'
  },
  {
    label: 'Downloads customer update',
    file: 'C:/Users/jsmith/Downloads/sys_update_xml_6204f7a0c39e8bd086f39f3ed401317e.xml',
    expect: 'customer_update'
  },
  {
    label: 'Downloads data export',
    file: 'C:/Users/jsmith/Downloads/x_1900232_eviden_0_famis_validations.xml',
    expect: 'data_record_export'
  },
  {
    label: 'Fixture record_update',
    file: path.join(__dirname, '../fixtures/scoped_app_record_update/sys_script_include_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.xml'),
    expect: 'scoped_app_record_update'
  },
  {
    label: 'Fixture unload metadata',
    file: path.join(__dirname, '../fixtures/scoped_app_record_update/unload_sys_script_include_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.xml'),
    expect: 'scoped_app_record_update'
  },
  {
    label: 'Fixture remote update set',
    file: path.join(__dirname, '../fixtures/customer_update/sys_remote_update_set_ae59f0d9c362cf5486f39f3ed40131bf.xml'),
    expect: 'customer_update'
  },
  {
    label: 'Fixture customer update',
    file: path.join(__dirname, '../fixtures/customer_update/sys_update_xml_6204f7a0c39e8bd086f39f3ed401317e.xml'),
    expect: 'customer_update'
  },
  {
    label: 'Fixture data export',
    file: path.join(__dirname, '../fixtures/data_record_export/x_example_0_staging.xml'),
    expect: 'data_record_export'
  }
];

let failed = 0;
for (const s of samples) {
  if (!fs.existsSync(s.file)) {
    console.log(`SKIP ${s.label} (missing file)`);
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
