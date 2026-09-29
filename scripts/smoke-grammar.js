/**
 * Injection grammar smoke test. Run: node scripts/smoke-grammar.js
 *
 * Tokenizes sample export XML with the real TextMate engine, the vendored XML
 * host and JSON grammars from fixtures/grammars, and stub grammars for the
 * remaining embedded languages (the assertions here only care about where an
 * embedded region starts and stops, not how its body tokenizes).
 *
 * Guards two regressions that left the rest of a document uncolored:
 *   - a self-closing tag such as <required_translations/> opening an embedded
 *     region that never closes
 *   - injected tag names missing the meta.tag.xml parent that the XML grammar
 *     puts on every other tag, so themes scoping tag color under meta.tag
 *     render them as plain text
 */
const fs = require('fs');
const path = require('path');
const vsctm = require('vscode-textmate');
const oniguruma = require('vscode-oniguruma');

const ROOT = path.join(__dirname, '..');
const GRAMMARS = path.join(ROOT, 'fixtures', 'grammars');

/** Embedded languages whose bodies these assertions do not inspect. */
const STUB_SCOPES = ['source.js', 'source.css'];

let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log('  ok   ' + name);
    return;
  }
  failures++;
  console.log('  FAIL ' + name + (detail ? ' -- ' + detail : ''));
}

function loadGrammar(scopeName) {
  if (scopeName === 'servicenow-xml.injection') {
    const p = path.join(
      ROOT,
      'syntaxes',
      'servicenow-xml.injection.tmLanguage.json'
    );
    return vsctm.parseRawGrammar(fs.readFileSync(p, 'utf8'), p);
  }
  if (scopeName === 'text.xml' || scopeName === 'source.json') {
    const file = scopeName === 'text.xml' ? 'xml' : 'json';
    const p = path.join(GRAMMARS, file + '.tmLanguage.json');
    return vsctm.parseRawGrammar(fs.readFileSync(p, 'utf8'), p);
  }
  if (STUB_SCOPES.includes(scopeName)) {
    return { scopeName, patterns: [] };
  }
  return null;
}

/** Tokenize `xml` into one array of { text, scopes } per line. */
async function tokenize(grammar, xml) {
  const lines = xml.split('\n');
  const out = [];
  let stack = vsctm.INITIAL;
  for (const line of lines) {
    const r = grammar.tokenizeLine(line, stack);
    stack = r.ruleStack;
    out.push(
      r.tokens.map((t) => ({
        text: line.substring(t.startIndex, t.endIndex),
        scopes: t.scopes
      }))
    );
  }
  return out;
}

function scopesOf(lineTokens, text) {
  return lineTokens.find((t) => t.text === text)?.scopes ?? [];
}

function anyScope(lineTokens, needle) {
  return lineTokens.some((t) => t.scopes.some((s) => s.startsWith(needle)));
}

async function main() {
  const wasm = fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
  await oniguruma.loadWASM(wasm.buffer);

  const registry = new vsctm.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (s) => new oniguruma.OnigScanner(s),
      createOnigString: (s) => new oniguruma.OnigString(s)
    }),
    loadGrammar: async (scopeName) => loadGrammar(scopeName),
    getInjections: (scopeName) =>
      scopeName === 'text.xml' ? ['servicenow-xml.injection'] : undefined
  });
  const grammar = await registry.loadGrammar('text.xml');

  console.log('== self-closing tags do not open an embedded region');
  for (const tag of [
    'data',
    'props',
    'required_translations',
    'css',
    'script_true'
  ]) {
    const lines = await tokenize(
      grammar,
      '<r>\n<' + tag + '/>\n<sys_id>abc</sys_id>\n</r>'
    );
    check(
      '<' + tag + '/> leaves the next element as plain XML',
      !anyScope(lines[2], 'meta.embedded.'),
      JSON.stringify(lines[2].map((t) => t.scopes.join(' ')))
    );
  }

  const spaced = await tokenize(
    grammar,
    '<r>\n<props />\n<sys_id>abc</sys_id>\n</r>'
  );
  check(
    '<props /> with a space before the slash also stays plain',
    !anyScope(spaced[2], 'meta.embedded.')
  );

  console.log('== injected tags carry meta.tag.xml');
  const json = await tokenize(
    grammar,
    '<r>\n<output_schema>{&#13;\n  "a": 1&#13;\n}</output_schema>\n' +
      '<sys_id>abc</sys_id>\n</r>'
  );
  check(
    'open tag name is scoped like a normal XML tag',
    scopesOf(json[1], 'output_schema').includes('meta.tag.xml') &&
      scopesOf(json[1], 'output_schema').includes(
        'entity.name.tag.localname.xml'
      ),
    scopesOf(json[1], 'output_schema').join(' ')
  );
  check(
    'close tag name is scoped like a normal XML tag',
    scopesOf(json[3], 'output_schema').includes('meta.tag.xml'),
    scopesOf(json[3], 'output_schema').join(' ')
  );

  console.log('== embedded regions still open and then close');
  check(
    'entity-encoded JSON body is embedded JSON',
    anyScope(json[2], 'meta.embedded.block.json')
  );
  check(
    'element after the JSON field is back to plain XML',
    !anyScope(json[4], 'meta.embedded.'),
    JSON.stringify(json[4].map((t) => t.scopes.join(' ')))
  );

  const script = await tokenize(
    grammar,
    '<r>\n<script><![CDATA[var a = 1;]]></script>\n<sys_id>abc</sys_id>\n</r>'
  );
  check(
    'CDATA script body is embedded JavaScript',
    anyScope(script[1], 'meta.embedded.block.javascript')
  );
  check(
    'element after the script field is back to plain XML',
    !anyScope(script[2], 'meta.embedded.')
  );

  if (failures > 0) {
    console.error(failures + ' grammar smoke check(s) failed');
    process.exit(1);
  }
  console.log('grammar smoke test passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
