const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

// eslint's package entry (lib/api.js) also loads RuleTester, whose top-level
// require.resolve('espree') has no bundled equivalent and throws at lint time.
// Only the Linter is used here, so point the bundler at that entry; the deep
// path is needed because eslint's exports map hides lib/.
const eslintLinterEntry = path.join(
  __dirname,
  'node_modules',
  'eslint',
  'lib',
  'linter',
  'index.js'
);
if (!fs.existsSync(eslintLinterEntry)) {
  throw new Error(
    `Cannot bundle eslint: expected Linter entry at ${eslintLinterEntry}. Run npm install, or update this path for the installed eslint version.`
  );
}

/** @type {import('esbuild').BuildOptions} */
const extensionOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  alias: { eslint: eslintLinterEntry },
  sourcemap: !production,
  minify: production,
  legalComments: 'none',
  logLevel: 'info'
};

/** @type {import('esbuild').BuildOptions} */
const mcpOptions = {
  entryPoints: ['src/registry/mcpServer.ts'],
  bundle: true,
  outfile: 'dist/registryMcp.js',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !production,
  minify: production,
  legalComments: 'none',
  logLevel: 'info'
};

async function main() {
  // Schema packs stay external (gzipped fields are ~12MB uncompressed).
  const dataSrc = path.join(__dirname, 'src', 'data');
  const dataDest = path.join(__dirname, 'dist', 'data');
  fs.mkdirSync(dataDest, { recursive: true });
  for (const name of [
    'dictionaryTables.json',
    'dictionaryFields.json.gz',
    'fieldKinds.json',
    'platformGlobals.json',
    'scriptIncludes.json',
    'scopes.json',
    'scripting_reference.json.gz',
    'js_performance.json'
  ]) {
    const from = path.join(dataSrc, name);
    if (fs.existsSync(from)) {
      fs.copyFileSync(from, path.join(dataDest, name));
    }
  }

  if (watch) {
    const ctx = await esbuild.context(extensionOptions);
    const mcpCtx = await esbuild.context(mcpOptions);
    await Promise.all([ctx.watch(), mcpCtx.watch()]);
    console.log('watching…');
  } else {
    await Promise.all([
      esbuild.build(extensionOptions),
      esbuild.build(mcpOptions)
    ]);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

// Exported so smoke tests can bundle single modules with the shipping settings.
module.exports = { options: extensionOptions };
