const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const esbuild = require('esbuild');
const { options } = require('../esbuild.js');

// Guards two things that only break on real update-set exports:
//  1. script regions inside an entity-encoded <payload> must land on the right
//     bytes (decoded offsets are shorter than the raw text they came from)
//  2. the layer walk must find scripts by content, and re-encode them back into
//     the exact bytes it replaced
const repoRoot = path.join(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-layers-'));
const bundlePath = path.join(tempDir, 'layers.cjs');

try {
  const entry = [
    "export { parseSnXml, encodeXmlEntities, decodeXmlEntities } from './src/parseSnXml';",
    "export { extractScriptRegions } from './src/scriptRegions';",
    "export { detectEmbeddedScriptAtOffset, encodeThroughLayers } from './src/embedded/layers';",
    "export { looksLikeJavaScript } from './src/embedded/jsLikeness';"
  ].join('\n');

  const buildOptions = { ...options };
  delete buildOptions.entryPoints;

  esbuild.buildSync({
    ...buildOptions,
    stdin: { contents: entry, resolveDir: repoRoot, loader: 'ts' },
    outfile: bundlePath,
    sourcemap: false,
    minify: false,
    logLevel: 'silent'
  });

  const {
    parseSnXml,
    encodeXmlEntities,
    decodeXmlEntities,
    extractScriptRegions,
    detectEmbeddedScriptAtOffset,
    encodeThroughLayers,
    looksLikeJavaScript
  } = require(bundlePath);

  // --- JS-likeness -------------------------------------------------------
  // Values that are valid JavaScript but are ordinary ServiceNow field data.
  for (const notCode of [
    'general',
    'true',
    '300000',
    'false',
    'f4f6be86c37f321086f39f3ed40131b9',
    '{}',
    '[1, 2, 3]',
    ''
  ]) {
    assert.ok(
      !looksLikeJavaScript(notCode).ok,
      `must not treat ${JSON.stringify(notCode)} as a script`
    );
  }
  for (const code of [
    "response.sendRedirect(gs.getProperty('glide.servlet.uri'));",
    'var UsefulStuff = Class.create();',
    'function onClick(g_form) {\n}',
    'if (current.active) { current.update(); }'
  ]) {
    assert.ok(
      looksLikeJavaScript(code).ok,
      `must treat ${JSON.stringify(code.slice(0, 30))} as a script`
    );
  }

  // --- Fixture -----------------------------------------------------------
  const includeScript =
    'var RecordExportSerializer = Class.create();\n' +
    'RecordExportSerializer.prototype = {\n' +
    '    initialize: function() {},\n' +
    '    type: "RecordExportSerializer"\n' +
    '};';
  const processingScript =
    "response.sendRedirect(gs.getProperty('glide.servlet.uri') + '/nav_to.do');";
  const clientScript =
    "addLoadEvent(function() {\n  var e = gel('dynamic_field');\n  Field.activate(e);\n});";

  const uiPagePayload =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<record_update table="sys_ui_page">' +
    '<sys_ui_page action="INSERT_OR_UPDATE">' +
    '<category>general</category>' +
    // Self-closing siblings: if the tag scanner leaves these on its stack, every
    // later field looks like their child and the table name comes out wrong.
    '<endpoint/><description/>' +
    `<client_script><![CDATA[${clientScript}]]></client_script>` +
    `<processing_script><![CDATA[${processingScript}]]></processing_script>` +
    '<sys_id>76657ec2c37f321086f39f3ed40131cf</sys_id>' +
    '</sys_ui_page></record_update>';

  const includePayload =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<record_update table="sys_script_include">' +
    '<sys_script_include action="INSERT_OR_UPDATE">' +
    '<name>RecordExportSerializer</name>' +
    `<script><![CDATA[${includeScript}]]></script>` +
    '<sys_id>50b8a468c3bb761086f39f3ed401310a</sys_id>' +
    '</sys_script_include></record_update>';

  // ServiceNow emits both forms in one file: entity-encoded here, CDATA below.
  const text =
    '<?xml version="1.0" encoding="UTF-8"?>\n<unload unload_date="2026-01-01 00:00:00">\n' +
    '<sys_update_xml action="INSERT_OR_UPDATE">\n' +
    '<action>INSERT_OR_UPDATE</action>\n' +
    '<name>sys_ui_page_76657ec2c37f321086f39f3ed40131cf</name>\n' +
    `<payload>${encodeXmlEntities(uiPagePayload)}</payload>\n` +
    '<sys_id>45664692c372cb1086f39f3ed4013100</sys_id>\n' +
    '</sys_update_xml>\n' +
    '<sys_update_xml action="INSERT_OR_UPDATE">\n' +
    '<action>INSERT_OR_UPDATE</action>\n' +
    '<name>sys_script_include_50b8a468c3bb761086f39f3ed401310a</name>\n' +
    `<payload>${encodeXmlEntities(includePayload)}</payload>\n` +
    '<sys_id>45664692c372cb1086f39f3ed4013101</sys_id>\n' +
    '</sys_update_xml>\n' +
    '</unload>\n';

  // --- Script region offsets --------------------------------------------
  const doc = parseSnXml(text);
  const regions = extractScriptRegions(doc, { includeDelete: true });
  const includeRegion = regions.find((r) => r.fieldName === 'script');
  assert.ok(includeRegion, 'must find the <script> region inside the payload');
  assert.strictEqual(
    text.slice(
      includeRegion.bodyStartOffset,
      includeRegion.bodyStartOffset + 20
    ),
    encodeXmlEntities(includeScript).slice(0, 20),
    'script region offset must point at the raw (encoded) script body'
  );

  // --- Layer detection ---------------------------------------------------
  const encodedProcessing = encodeXmlEntities(processingScript);
  const processingAt = text.indexOf(encodedProcessing);
  assert.ok(processingAt > 0, 'fixture must contain the encoded processing script');

  const hit = detectEmbeddedScriptAtOffset(text, processingAt + 10);
  assert.ok(hit, 'must detect a script inside the entity-encoded payload');
  assert.strictEqual(hit.fieldName, 'processing_script');
  assert.strictEqual(hit.tableName, 'sys_ui_page');
  assert.strictEqual(hit.code, processingScript);
  assert.strictEqual(
    hit.profile,
    'server',
    'processing_script runs server side even though the table also holds client code'
  );

  // The replaced range must be exactly what the layers re-encode to.
  const reEncoded = encodeThroughLayers(hit.code, hit.layers);
  assert.ok(reEncoded.ok, 'layers must re-encode');
  assert.strictEqual(
    reEncoded.text,
    text.slice(hit.absoluteStart, hit.absoluteEnd),
    'round-trip must reproduce the exact bytes being replaced'
  );

  // --- Profile comes from the field, not the table ----------------------
  const clientAt = text.indexOf(encodeXmlEntities(clientScript));
  const clientHit = detectEmbeddedScriptAtOffset(text, clientAt + 10);
  assert.ok(clientHit, 'must detect the client_script body');
  assert.strictEqual(clientHit.fieldName, 'client_script');
  assert.strictEqual(clientHit.profile, 'client');

  // --- Editing round-trip ------------------------------------------------
  const edited = processingScript.replace('/nav_to.do', '/home.do');
  const spliced = encodeThroughLayers(edited, hit.layers);
  assert.ok(spliced.ok, 'edited code must re-encode');
  const updated =
    text.slice(0, hit.absoluteStart) + spliced.text + text.slice(hit.absoluteEnd);
  const reread = detectEmbeddedScriptAtOffset(updated, hit.absoluteStart + 10);
  assert.ok(reread, 'edited script must still be detectable');
  assert.strictEqual(reread.code, edited, 'edit must survive the round-trip');

  // --- Non-script fields stay closed ------------------------------------
  const categoryAt = text.indexOf(encodeXmlEntities('<category>general<'));
  assert.ok(categoryAt > 0, 'fixture must contain the category field');
  assert.strictEqual(
    detectEmbeddedScriptAtOffset(text, categoryAt + 25),
    null,
    'a scalar field value must not open as a script'
  );

  // Structure between fields: the row body holds a CDATA script, so a body that
  // merely contains CDATA must not be mistaken for a CDATA leaf.
  const rowAt = text.indexOf(encodeXmlEntities('<sys_ui_page action='));
  assert.ok(rowAt > 0, 'fixture must contain the row element');
  assert.strictEqual(
    detectEmbeddedScriptAtOffset(text, rowAt + 30),
    null,
    'markup between fields must not open as a script'
  );

  // A CDATA script that builds HTML must still open, despite closing tags.
  const htmlBuilder =
    "var out = '';\nout += '<div class=\"x\">' + name + '</div>';\ncurrent.setValue('html', out);";
  const htmlPayload =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<record_update table="sys_script_include">' +
    '<sys_script_include action="INSERT_OR_UPDATE">' +
    `<script><![CDATA[${htmlBuilder}]]></script>` +
    '</sys_script_include></record_update>';
  const htmlText =
    '<?xml version="1.0" encoding="UTF-8"?>\n<unload>\n<sys_update_xml action="INSERT_OR_UPDATE">\n' +
    `<payload>${encodeXmlEntities(htmlPayload)}</payload>\n` +
    '</sys_update_xml>\n</unload>\n';
  const htmlAt = htmlText.indexOf(encodeXmlEntities("var out = ''"));
  const htmlHit = detectEmbeddedScriptAtOffset(htmlText, htmlAt + 5);
  assert.ok(htmlHit, 'a CDATA script containing HTML strings must be detected');
  assert.strictEqual(htmlHit.code, htmlBuilder);

  // --- JSON string in an entity-encoded text node ------------------------
  // sys_ux_macroponent <composition> is plain JSON in a text node, so a JSON
  // string's own quotes sit raw in the file. Re-encoding must leave them raw:
  // turning them into &quot; still decodes to the same value but rewrites
  // every quote in the token, which shows up as a bogus diff against the
  // instance export.
  const inlineScript =
    'function evaluateEvent({ api, event }) {\n' +
    "    // chars that do need escaping: < > &\n" +
    '    return { propName: "cardStates", value: api.state.cardStates };\n' +
    '}';
  const composition = JSON.stringify({ events: [{ inlineScript }] }, null, 4);
  const macroponentText =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<record_update table="sys_ux_macroponent">\n' +
    '<sys_ux_macroponent action="INSERT_OR_UPDATE">\n' +
    `<composition>${encodeXmlEntities(composition)}</composition>\n` +
    '<sys_id>195f22bcc354c31086f39f3ed4013127</sys_id>\n' +
    '</sys_ux_macroponent>\n</record_update>\n';

  const inlineAt = macroponentText.indexOf('evaluateEvent');
  assert.ok(inlineAt > 0, 'fixture must contain the inline script');
  const inlineHit = detectEmbeddedScriptAtOffset(macroponentText, inlineAt);
  assert.ok(inlineHit, 'must detect a script inside a JSON string in a text node');
  assert.strictEqual(inlineHit.fieldName, 'composition');
  assert.strictEqual(inlineHit.code, inlineScript);
  assert.strictEqual(
    encodeThroughLayers(inlineHit.code, inlineHit.layers).text,
    macroponentText.slice(inlineHit.absoluteStart, inlineHit.absoluteEnd),
    'an untouched JSON string must re-encode to the exact bytes it replaces'
  );

  const editedInline = inlineScript.replace('cardStates', 'nextCardStates');
  const inlineSpliced = encodeThroughLayers(editedInline, inlineHit.layers);
  assert.ok(inlineSpliced.ok, 'edited inline script must re-encode');
  assert.ok(
    !inlineSpliced.text.includes('&quot;'),
    'JSON string quotes must not be entity-encoded'
  );
  const updatedMacroponent =
    macroponentText.slice(0, inlineHit.absoluteStart) +
    inlineSpliced.text +
    macroponentText.slice(inlineHit.absoluteEnd);
  const bodyOpen =
    updatedMacroponent.indexOf('<composition>') + '<composition>'.length;
  const bodyClose = updatedMacroponent.indexOf('</composition>');
  const reparsed = JSON.parse(
    decodeXmlEntities(updatedMacroponent.slice(bodyOpen, bodyClose))
  );
  assert.strictEqual(
    reparsed.events[0].inlineScript,
    editedInline,
    'the spliced JSON must decode back to exactly what was edited'
  );

  console.log('embedded layers smoke test passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
