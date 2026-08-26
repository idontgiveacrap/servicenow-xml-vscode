/**
 * Smoke tests for shared script extract/encode (no vscode formatter).
 * Run: node scripts/smoke-scripts.js
 */
const path = require('path');
const { build } = require('esbuild');

async function main() {
  const outfile = path.join(__dirname, '..', 'dist', 'smoke-scripts.js');
  await build({
    entryPoints: [path.join(__dirname, 'smoke-scripts-entry.ts')],
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
