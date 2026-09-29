const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-xml-prune-smoke-'));
const bundlePath = path.join(tempDir, 'sncParse.cjs');
const removeRowsBundlePath = path.join(tempDir, 'removeRows.cjs');

// Real `snc record query` stdout: spinner frames and an ANSI banner precede JSON.
const ESC = '\u001b';
const SUCCESS_STDOUT = `
| Processing the request
/ Processing the request
- Processing the request
                        
${ESC}[32m
Request completed
${ESC}[0m{
   "result": [
      {
         "sys_id": "6816F79CC0A8016401C5A33BE04BE441"
      }
   ]
}

`;
const EMPTY_STDOUT = `
| Processing the request
                        
${ESC}[32m
Request completed
${ESC}[0m{
   "result": []
}
`;
const ERROR_STDOUT = `
| Processing the request
                        
${ESC}[91m
Failed to process the request
${ESC}[0m{
   "error": {
      "detail": null,
      "message": "Invalid table zz_not_a_table"
   },
   "status": "failure"
}
`;
const PROFILE_STDOUT = `{
   "admin": {
      "appversion": "1.1.2",
      "host": "https://dev320950.service-now.com",
      "loginmethod": "basic",
      "output": "json",
      "username": "cursor.admin"
   },
   "default": {
      "host": "https://dev320950.service-now.com",
      "username": "cli.read.only"
   }
}
`;

try {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
  );
  assert.ok(
    manifest.contributes.commands.some(
      (c) => c.command === 'servicenowXml.pruneRedundantDeletes'
    ),
    'prune redundant DELETE command must be registered'
  );
  assert.ok(
    manifest.contributes.configuration.properties['servicenowXml.snc.path'],
    'servicenowXml.snc.path setting must be registered'
  );
  assert.ok(
    manifest.contributes.configuration.properties['servicenowXml.snc.mcpProfiles'],
    'servicenowXml.snc.mcpProfiles setting must be registered'
  );
  assert.ok(
    !manifest.contributes.configuration.properties['servicenowXml.snc.profile'],
    'servicenowXml.snc.profile must not be registered'
  );

  esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', 'src', 'snc', 'parse.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  });
  const {
    parseSncProfileList,
    parseSncRecordQuery,
    chunkSysIds,
    selectDeleteQueryCandidates,
    classifyDeleteRows
  } = require(bundlePath);

  const profiles = parseSncProfileList(PROFILE_STDOUT);
  assert.equal(profiles.length, 2);
  assert.equal(profiles[0].name, 'admin');
  assert.equal(profiles[1].username, 'cli.read.only');
  assert.equal(parseSncProfileList('not json'), undefined);

  // The spinner/banner preamble must not be mistaken for a malformed payload.
  const hit = parseSncRecordQuery(SUCCESS_STDOUT);
  assert.equal(hit.ok, true, 'spinner preamble must not break JSON parsing');
  assert.ok(hit.sysIds.has('6816f79cc0a8016401c5a33be04be441'));

  const empty = parseSncRecordQuery(EMPTY_STDOUT);
  assert.equal(empty.ok, true);
  assert.equal(empty.sysIds.size, 0);

  // snc exits 0 on instance errors, so the payload shape is the only signal.
  const failed = parseSncRecordQuery(ERROR_STDOUT);
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /Invalid table zz_not_a_table/);

  assert.equal(parseSncRecordQuery('').ok, false);
  assert.equal(parseSncRecordQuery('Processing the request').ok, false);
  assert.equal(parseSncRecordQuery('{ not json').ok, false);
  assert.equal(parseSncRecordQuery(JSON.stringify({ result: [{ sys_id: 1 }] })).ok, false);
  assert.equal(parseSncRecordQuery(JSON.stringify({ foo: [] })).ok, false);

  const chunks = chunkSysIds(['a'.repeat(32), 'b'.repeat(32)], 20);
  assert.equal(chunks.length, 2);

  const live = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const gone = 'cccccccccccccccccccccccccccccccc';
  const mixedGone = 'dddddddddddddddddddddddddddddddd';
  const index = [
    {
      table: 'sys_script_include',
      sysId: gone,
      action: 'DELETE',
      uriString: 'file:///gone.xml',
      relativePath: 'author_elective_update/sys_script_include_gone.xml',
      displayName: 'Gone',
      startOffset: 10
    },
    {
      table: 'sys_script_include',
      sysId: live,
      action: 'DELETE',
      uriString: 'file:///live-delete.xml',
      relativePath: 'author_elective_update/sys_script_include_live.xml',
      displayName: 'LiveTwin',
      startOffset: 20
    },
    {
      table: 'sys_script_include',
      sysId: live,
      action: 'INSERT_OR_UPDATE',
      uriString: 'file:///live.xml',
      relativePath: 'update/sys_script_include_live.xml',
      displayName: 'LiveTwin',
      startOffset: 30
    },
    {
      table: 'sys_translated_text',
      sysId: mixedGone,
      action: 'DELETE',
      uriString: 'file:///mixed.xml',
      relativePath: 'update/mixed.xml',
      displayName: 'MixedDelete',
      startOffset: 40
    },
    {
      table: 'sys_script_include',
      sysId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      action: 'INSERT_OR_UPDATE',
      uriString: 'file:///mixed.xml',
      relativePath: 'update/mixed.xml',
      displayName: 'MixedLive',
      startOffset: 50
    }
  ];

  const selected = selectDeleteQueryCandidates(index);
  assert.deepStrictEqual(
    selected.candidates.map((c) => c.relativePath).sort(),
    ['author_elective_update/sys_script_include_gone.xml', 'update/mixed.xml'],
    'a file mixing DELETE with other actions is still a candidate'
  );
  assert.ok(selected.skipped.some((s) => s.reason.includes('live export')));
  assert.ok(
    !selected.skipped.some((s) => s.reason.includes('mixes')),
    'mixed files must no longer be skipped outright'
  );

  const mixedCandidate = selected.candidates.find(
    (c) => c.relativePath === 'update/mixed.xml'
  );
  assert.deepStrictEqual(mixedCandidate.rows, [
    {
      table: 'sys_translated_text',
      sysId: mixedGone,
      displayName: 'MixedDelete',
      startOffset: 40
    }
  ]);
  assert.equal(mixedCandidate.primaryRowCount, 2);

  const allMissing = classifyDeleteRows(
    selected.candidates,
    new Map([
      ['sys_script_include', new Set()],
      ['sys_translated_text', new Set()]
    ])
  );
  assert.deepStrictEqual(
    allMissing.map((row) => [row.sysId, row.status]),
    [
      [gone, 'absent'],
      [mixedGone, 'absent']
    ]
  );
  const wholeFileRow = allMissing.find((row) => row.sysId === gone);
  assert.equal(wholeFileRow.file.primaryRowCount, 1, 'whole-file row has no siblings');
  assert.equal(wholeFileRow.startOffset, 10, 'row carries its offset for opening');

  // A table whose query failed is absent from presentByTable, so its rows stay
  // unconfirmed rather than being reported as gone.
  const afterFailure = classifyDeleteRows(
    selected.candidates,
    new Map([['sys_script_include', new Set()]])
  );
  assert.deepStrictEqual(
    afterFailure.map((row) => [row.sysId, row.status]),
    [
      [gone, 'absent'],
      [mixedGone, 'unchecked']
    ]
  );

  // No query at all leaves every row reviewable but unconfirmed.
  assert.deepStrictEqual(
    classifyDeleteRows(selected.candidates, new Map()).map((row) => row.status),
    ['unchecked', 'unchecked']
  );

  const stillPresent = classifyDeleteRows(
    selected.candidates,
    new Map([
      ['sys_script_include', new Set([gone])],
      ['sys_translated_text', new Set([mixedGone])]
    ])
  );
  assert.deepStrictEqual(
    stillPresent.map((row) => row.status),
    ['present', 'present']
  );

  // A navigator selection covering only one DELETE row must not delete the file.
  const partiallySelected = selectDeleteQueryCandidates([
    {
      table: 'sys_script_include',
      sysId: gone,
      action: 'DELETE',
      uriString: 'file:///two-deletes.xml',
      relativePath: 'author_elective_update/two_deletes.xml',
      displayName: 'First',
      startOffset: 60,
      queryable: true
    },
    {
      table: 'sys_script_include',
      sysId: mixedGone,
      action: 'DELETE',
      uriString: 'file:///two-deletes.xml',
      relativePath: 'author_elective_update/two_deletes.xml',
      displayName: 'Second',
      startOffset: 70,
      queryable: false
    }
  ]);
  assert.equal(partiallySelected.candidates.length, 1);
  assert.equal(partiallySelected.candidates[0].rows.length, 1);
  assert.equal(
    partiallySelected.candidates[0].primaryRowCount,
    2,
    'unselected DELETE rows still count toward the file total'
  );
  const scopedRows = classifyDeleteRows(
    partiallySelected.candidates,
    new Map([['sys_script_include', new Set()]])
  );
  assert.equal(scopedRows.length, 1);
  assert.equal(
    scopedRows[0].file.primaryRowCount,
    2,
    'pruning the one selected row cannot take the whole file'
  );

  esbuild.buildSync({
    entryPoints: [
      path.join(__dirname, '..', 'src', 'pruneRedundantDeletes', 'removeRows.ts')
    ],
    outfile: removeRowsBundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  });
  const { removeDeleteRows } = require(removeRowsBundlePath);

  const deleteOnlyXml = `<?xml version="1.0" encoding="UTF-8"?>
<unload unload_date="2026-01-01 00:00:00">
<sys_script_include action="DELETE">
<sys_id>${gone}</sys_id>
</sys_script_include>
</unload>
`;
  assert.deepStrictEqual(removeDeleteRows(deleteOnlyXml, 'gone.xml', [gone]), {
    outcome: 'delete-file',
    removed: 1
  });

  const mixedXml = `<?xml version="1.0" encoding="UTF-8"?>
<unload unload_date="2026-01-01 00:00:00">
  <sys_translated_text action="DELETE">
    <sys_id>${mixedGone}</sys_id>
  </sys_translated_text>
  <sys_script_include action="INSERT_OR_UPDATE">
    <name>Keeper</name>
    <sys_id>eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee</sys_id>
  </sys_script_include>
</unload>
`;
  const rewritten = removeDeleteRows(mixedXml, 'mixed.xml', [mixedGone]);
  assert.equal(rewritten.outcome, 'rewrite');
  assert.equal(rewritten.removed, 1);
  assert.ok(
    !rewritten.text.includes(mixedGone),
    'the pruned DELETE row must be gone from the rewritten XML'
  );
  assert.ok(
    rewritten.text.includes('<name>Keeper</name>'),
    'the surviving record must be untouched'
  );
  assert.ok(
    !/\n\s*\n\s*<\/unload>/.test(rewritten.text),
    'removing a row must not leave a blank line behind'
  );
  assert.equal(
    rewritten.text.split('\n').length,
    mixedXml.split('\n').length - 3,
    'only the three lines of the DELETE row are removed'
  );

  // A sys_id no longer on disk means the file changed since the scan.
  assert.deepStrictEqual(
    removeDeleteRows(mixedXml, 'mixed.xml', [mixedGone, gone]),
    { outcome: 'mismatch', removed: 1, expected: 2 }
  );

  console.log('prune DELETE smoke tests passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
