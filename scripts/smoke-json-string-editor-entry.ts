import * as assert from 'node:assert/strict';
import {
  buildDecodedToRawMap,
  hasJavascriptWrapper,
  mapDecodedRangeToRaw,
  restoreJavascriptWrapper,
  stripJavascriptWrapper,
  toJsonStringToken,
  unescapeJsonStringContents,
  wouldBreakCdata
} from '../src/jsonStringEditor/escape';
import {
  detectJsonStringAtOffset,
  isEligibleScriptString,
  makeDraftKey
} from '../src/jsonStringEditor/detect';
import {
  decodeXmlEntities,
  encodeXmlEntities
} from '../src/parseSnXml';
import {
  ensureGitignoreEntry,
  gitignoreHasEntry,
  saveDraft,
  loadDraft,
  deleteDraft
} from '../src/jsonStringEditor/drafts';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function section(name: string): void {
  console.log(`\n== ${name}`);
}

section('javascript wrapper');
{
  const wrapped =
    'javascript(function evaluateEvent({ api }) { return 1; })';
  assert.equal(hasJavascriptWrapper(wrapped), true);
  const stripped = stripJavascriptWrapper(wrapped);
  assert.equal(stripped.hadWrapper, true);
  assert.equal(stripped.code, 'function evaluateEvent({ api }) { return 1; }');
  assert.equal(
    restoreJavascriptWrapper(stripped.code, true),
    wrapped
  );
  assert.equal(restoreJavascriptWrapper(wrapped, true), wrapped);
  assert.equal(stripJavascriptWrapper('plain').hadWrapper, false);
}

section('JSON escape round-trip');
{
  const samples = [
    'line1\nline2',
    'say "hi"',
    'path\\to\\file',
    'unicode café'
  ];
  for (const s of samples) {
    const token = toJsonStringToken(s);
    assert.ok(token.startsWith('"') && token.endsWith('"'));
    const inner = token.slice(1, -1);
    assert.equal(unescapeJsonStringContents(inner), s);
    assert.equal(JSON.parse(token), s);
  }
}

section('CDATA / XML entities');
{
  assert.equal(wouldBreakCdata('ok'), false);
  assert.equal(wouldBreakCdata('bad ]]> here'), true);
  const raw = 'a&amp;b&lt;c&quot;d';
  const decoded = decodeXmlEntities(raw);
  assert.equal(decoded, 'a&b<c"d');
  assert.equal(encodeXmlEntities(decoded), 'a&amp;b&lt;c&quot;d');
  const map = buildDecodedToRawMap(raw, decodeXmlEntities);
  assert.ok(map);
  assert.equal(map!.length, decoded.length);
  const range = mapDecodedRangeToRaw(map!, 0, decoded.length, raw.length);
  assert.deepEqual(range, { rawStart: 0, rawEnd: raw.length });
}

section('eligibility + draft keys');
{
  assert.equal(isEligibleScriptString('clientTransformScript', 'x'), true);
  assert.equal(isEligibleScriptString('label', 'javascript(foo)'), true);
  assert.equal(isEligibleScriptString('label', 'nope'), false);
  const k1 = makeDraftKey('a.xml', 'composition', 'events.[0].clientTransformScript');
  const k2 = makeDraftKey('a.xml', 'composition', 'events.[1].clientTransformScript');
  assert.notEqual(k1, k2);
}

section('detect in composition XML');
{
  const script =
    'javascript(/**\\n * @param {params} params\\n */\\nfunction evaluateEvent({ api, event }) {\\n  return { action: \\"expand\\" };\\n})';
  const composition = `{"handlers":[{"clientTransformScript":"${script}"},{"clientTransformScript":"javascript(function other(){})"}]}`;
  const xml = `<?xml version="1.0"?>
<record_update table="sys_ux_macroponent">
  <sys_ux_macroponent action="INSERT_OR_UPDATE">
    <sys_id>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</sys_id>
    <composition><![CDATA[${composition}]]></composition>
  </sys_ux_macroponent>
</record_update>
`;
  const marker = 'clientTransformScript';
  const firstValueAt = xml.indexOf(marker) + marker.length + 2; // into the string
  const hit = detectJsonStringAtOffset(xml, firstValueAt, 'macro.xml', 1, 'macro.xml');
  assert.ok(hit, 'expected hit on first script');
  assert.equal(hit!.fieldName, 'composition');
  assert.equal(hit!.keyPath, 'handlers.[0].clientTransformScript');
  assert.equal(hit!.hadJavascriptWrapper, true);
  assert.ok(hit!.editorCode.includes('evaluateEvent'));

  const secondMarker = xml.indexOf('function other');
  const hit2 = detectJsonStringAtOffset(xml, secondMarker, 'macro.xml', 1, 'macro.xml');
  assert.ok(hit2);
  assert.equal(hit2!.keyPath, 'handlers.[1].clientTransformScript');
  assert.notEqual(hit!.draftKey, hit2!.draftKey);

  // Write-back splice simulation: replace token and parse field.
  const token = toJsonStringToken(
    restoreJavascriptWrapper('function evaluateEvent(){ return 2; }', true)
  );
  const next =
    xml.slice(0, hit!.absoluteStart) + token + xml.slice(hit!.absoluteEnd);
  const bodyStart = next.indexOf(composition.slice(0, 12)); // fragile — use CDATA instead
  const cdataStart = next.indexOf('<![CDATA[') + '<![CDATA['.length;
  const cdataEnd = next.indexOf(']]>', cdataStart);
  const body = next.slice(cdataStart, cdataEnd);
  const parsed = JSON.parse(body) as {
    handlers: Array<{ clientTransformScript: string }>;
  };
  assert.ok(parsed.handlers[0].clientTransformScript.includes('return 2'));
  assert.ok(parsed.handlers[1].clientTransformScript.includes('other'));
  void bodyStart;
}

section('entity-encoded composition field');
{
  const inner = '{"clientTransformScript":"javascript(function x(){ return 1; })"}';
  const encoded = encodeXmlEntities(inner);
  const xml = `<?xml version="1.0"?>
<record_update table="sys_ux_macroponent">
  <sys_ux_macroponent action="INSERT_OR_UPDATE">
    <sys_id>bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb</sys_id>
    <composition>${encoded}</composition>
  </sys_ux_macroponent>
</record_update>
`;
  const at = xml.indexOf('javascript');
  assert.ok(at > 0);
  const hit = detectJsonStringAtOffset(xml, at, 'enc.xml', 1, 'enc.xml');
  assert.ok(hit, 'expected hit in entity-encoded field');
  assert.equal(hit!.hadJavascriptWrapper, true);
  const token = encodeXmlEntities(
    toJsonStringToken(restoreJavascriptWrapper('function x(){ return 9; }', true))
  );
  const next =
    xml.slice(0, hit!.absoluteStart) + token + xml.slice(hit!.absoluteEnd);
  const open = next.indexOf('<composition>') + '<composition>'.length;
  const close = next.indexOf('</composition>');
  const decoded = decodeXmlEntities(next.slice(open, close));
  const obj = JSON.parse(decoded) as { clientTransformScript: string };
  assert.ok(obj.clientTransformScript.includes('return 9'));
}

section('drafts + gitignore helper');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-xml-draft-'));
  try {
    assert.equal(gitignoreHasEntry('node_modules/\n', '.servicenow-xml/'), false);
    ensureGitignoreEntry(tmp);
    const gi = fs.readFileSync(path.join(tmp, '.gitignore'), 'utf8');
    assert.ok(gitignoreHasEntry(gi, '.servicenow-xml/'));
    ensureGitignoreEntry(tmp); // idempotent
    const gi2 = fs.readFileSync(path.join(tmp, '.gitignore'), 'utf8');
    assert.equal(
      gi2.split('\n').filter((l) => l.trim() === '.servicenow-xml/').length,
      1
    );

    const draftsDir = path.join(tmp, '.servicenow-xml', 'json-string-drafts');
    fs.mkdirSync(draftsDir, { recursive: true });
    const key = 'abc123';
    saveDraft(draftsDir, key, 'function a(){}', {
      hostPath: 'x.xml',
      fieldName: 'composition',
      keyPath: 'clientTransformScript',
      hadJavascriptWrapper: true,
      lastError: 'test'
    });
    const loaded = loadDraft(draftsDir, key);
    assert.ok(loaded);
    assert.equal(loaded!.code, 'function a(){}');
    deleteDraft(draftsDir, key);
    assert.equal(loadDraft(draftsDir, key), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('\nAll json-string-editor smoke checks passed.');
