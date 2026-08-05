/**
 * Quick classification smoke test (no vscode). Run: node scripts/smoke-classify.js
 */
const fs = require('fs');
const path = require('path');
const { build } = require('esbuild');

async function main() {
  const outfile = path.join(__dirname, '..', 'dist', 'smoke-bundle.js');
  await build({
    entryPoints: [path.join(__dirname, 'smoke-entry.ts')],
    bundle: true,
    outfile,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    logLevel: 'silent'
  });
  require(outfile);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
