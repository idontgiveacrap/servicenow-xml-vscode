/**
 * Smoke tests for embedded JSON string editor helpers (no vscode).
 * Run: node scripts/smoke-json-string-editor.js
 */
const path = require('path');
const { build } = require('esbuild');

async function main() {
  const outfile = path.join(__dirname, '..', 'dist', 'smoke-json-string-editor.js');
  await build({
    entryPoints: [path.join(__dirname, 'smoke-json-string-editor-entry.ts')],
    bundle: true,
    outfile,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    logLevel: 'silent',
    alias: {
      vscode: path.join(__dirname, 'vscode-mock.js')
    }
  });
  require(outfile);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
