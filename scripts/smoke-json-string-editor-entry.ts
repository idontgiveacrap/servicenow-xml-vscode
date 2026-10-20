import * as assert from 'node:assert/strict';
import {
  buildDecodedToRawMap,
  buildNormalizedDecodedToRawMap,
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
  encodeXmlEntities,
  parseSnXml
} from '../src/parseSnXml';
import { encodeHit, jsonFieldAt, scriptAt } from '../src/scriptHits';
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
  // Quotes decode but are not re-encoded: text nodes only need & < > escaped.
  assert.equal(encodeXmlEntities(decoded), 'a&amp;b&lt;c"d');
  const map = buildDecodedToRawMap(raw, decodeXmlEntities);
  assert.ok(map);
  assert.equal(map!.length, decoded.length);
  const range = mapDecodedRangeToRaw(map!, 0, decoded.length, raw.length);
  assert.deepEqual(range, { rawStart: 0, rawEnd: raw.length });

  // CRLF collapse must not drop the first character of the next line.
  const crlf = 'ab\r\ncd';
  const crlfNorm = buildNormalizedDecodedToRawMap(crlf, (s) => s);
  assert.ok(crlfNorm);
  assert.equal(crlfNorm!.normalized, 'ab\ncd');
  assert.equal(crlfNorm!.normalizedToRaw[crlfNorm!.normalized.indexOf('c')], crlf.indexOf('c'));

  // A literal `&` in CDATA is not an entity, even when a `;` follows later.
  const script = 'if (a && b) {\r\n  return;\r\n}';
  const scriptNorm = buildNormalizedDecodedToRawMap(script, (s) => s);
  assert.ok(scriptNorm);
  assert.equal(scriptNorm!.normalized, 'if (a && b) {\n  return;\n}');
  const amp = scriptNorm!.normalized.indexOf('&');
  assert.equal(scriptNorm!.normalizedToRaw[amp], script.indexOf('&'));

  // `&#13;` plus a file newline is one logical line break, and the next
  // character keeps its raw index.
  const encoded = 'var x;&#13;\nvar y;';
  const encodedNorm = buildNormalizedDecodedToRawMap(encoded, decodeXmlEntities);
  assert.ok(encodedNorm);
  assert.equal(encodedNorm!.normalized, 'var x;\nvar y;');
  const yAt = encodedNorm!.normalized.indexOf('y');
  assert.equal(encodedNorm!.normalizedToRaw[yAt], encoded.indexOf('y'));
}

section('eligibility + draft keys');
{
  // Content, not the property name: a value under a *Script key that is only a
  // scalar is not a script, and a script under any other key still is.
  assert.equal(isEligibleScriptString('x'), false);
  assert.equal(isEligibleScriptString('function f(){ return 1; }'), true);
  assert.equal(isEligibleScriptString('nope'), false);
  assert.equal(isEligibleScriptString('evidence_submission_field sys_id'), false);
  // An explicit javascript(…) wrapper is its own evidence, even when the inner
  // source is just a member lookup.
  assert.equal(isEligibleScriptString('javascript(current.number)'), true);
  const k1 = makeDraftKey('a.xml', 'composition', 'events.[0].clientTransformScript');
  const k2 = makeDraftKey('a.xml', 'composition', 'events.[1].clientTransformScript');
  assert.notEqual(k1, k2);
}

section('whole JSON field at the caret');
{
  const propsJson = [
    '[',
    '  {',
    '    "name": "sys_id",',
    '    "label": "Entity sys_id",',
    '    "description": "evidence_submission_field sys_id",',
    '    "mandatory": true',
    '  }',
    ']'
  ].join('\n');
  // ServiceNow writes a CR entity before each newline in a text-node field.
  const rawProps = propsJson.split('\n').join('&#13;\n');
  const xml = `<?xml version="1.0"?>
<record_update table="sys_ux_data_broker_transform">
  <sys_ux_data_broker_transform action="INSERT_OR_UPDATE">
    <sys_id>cccccccccccccccccccccccccccccccc</sys_id>
    <props>${rawProps}</props>
    <data>{"onLoad":"function go(){ return 1; }"}</data>
    <script><![CDATA[function transform(input){ return input; }]]></script>
  </sys_ux_data_broker_transform>
</record_update>
`;
  const opts = { hostPath: 'broker.xml', hostVersion: 1, includeJsonFields: true };

  const inProps = xml.indexOf('"label"');
  const fieldHit = scriptAt(xml, inProps, opts);
  assert.ok(fieldHit, 'expected the enclosing JSON field');
  assert.equal(fieldHit!.role, 'jsonField');
  assert.equal(fieldHit!.fieldName, 'props');
  assert.equal(fieldHit!.code, propsJson);
  assert.equal(xml.slice(fieldHit!.hostStart, fieldHit!.hostEnd), rawProps);

  // Opt-in only: lint and range formatting must not see data as a script.
  assert.equal(scriptAt(xml, inProps, { hostPath: 'broker.xml' }), null);

  // A plain string inside the field is data, so the field still wins.
  const onDescription = xml.indexOf('evidence_submission_field sys_id');
  assert.equal(scriptAt(xml, onDescription, opts)!.role, 'jsonField');

  // A string that reads as code wins over the field that contains it.
  const onEmbeddedScript = xml.indexOf('function go');
  const stringHit = scriptAt(xml, onEmbeddedScript, opts);
  assert.equal(stringHit!.role, 'jsonString');
  assert.equal(stringHit!.keyPath, 'onLoad');
  assert.equal(stringHit!.code, 'function go(){ return 1; }');

  // A script-typed field still resolves as a script.
  assert.equal(
    scriptAt(xml, xml.indexOf('function transform'), opts)!.role,
    'scriptField'
  );

  // Write-back re-encodes the whole body, which drops the &#13; noise.
  const edited = propsJson.replace('"mandatory": true', '"mandatory": false');
  const encoded = encodeHit(fieldHit!, edited);
  assert.ok(encoded.ok, 'expected the field to encode');
  const next =
    xml.slice(0, fieldHit!.hostStart) +
    (encoded as { text: string }).text +
    xml.slice(fieldHit!.hostEnd);
  assert.ok(!next.includes('&#13;'), 'CR entities should be gone after write-back');
  const roundTrip = jsonFieldAt(parseSnXml(next), fieldHit!.hostStart);
  assert.ok(roundTrip, 'expected to re-find the field after the splice');
  assert.equal(roundTrip!.code, edited);
  assert.equal(
    (JSON.parse(roundTrip!.code) as Array<{ mandatory: boolean }>)[0].mandatory,
    false
  );
}

section('CDATA JSON offsets with entity-like text and empty array values');
{
  const composition =
    '{\r\n' +
    '  "handlers": [{}, [], {"clientTransformScript": "function later(){ return 1; }"}],\r\n' +
    '  "literal": "function literal(){ return \\"&amp;\\"; }"\r\n' +
    '}';
  const xml = `<?xml version="1.0"?>
<record_update table="sys_ux_macroponent">
  <sys_ux_macroponent action="INSERT_OR_UPDATE">
    <sys_id>dddddddddddddddddddddddddddddddd</sys_id>
    <composition><![CDATA[${composition}]]></composition>
  </sys_ux_macroponent>
</record_update>
`;
  const laterAt = xml.indexOf('function later');
  const later = detectJsonStringAtOffset(xml, laterAt, 'edge.xml', 1, 'edge.xml');
  assert.ok(later, 'expected a hit after empty array values');
  assert.equal(later!.keyPath, 'handlers.[2].clientTransformScript');
  assert.equal(later!.absoluteStart, xml.indexOf('"function later'));

  const literalAt = xml.indexOf('function literal');
  const literal = detectJsonStringAtOffset(xml, literalAt, 'edge.xml', 1, 'edge.xml');
  assert.ok(literal, 'CDATA literal entity-like text must remain detectable');
  assert.equal(literal!.keyPath, 'literal');
  assert.equal(literal!.absoluteStart, xml.indexOf('"function literal'));
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
