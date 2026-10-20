const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');

async function loadProvider() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-xml-records-tree-'));
  const bundlePath = path.join(tempDir, 'tree.cjs');
  const vscodeMockPath = path.join(__dirname, 'vscode-mock-tree.cjs');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'navigator', 'tree.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
    alias: { vscode: vscodeMockPath },
    plugins: [
      {
        name: 'stub-data-json',
        setup(build) {
          build.onResolve({ filter: /[/\\]data[/\\].+\.json$/ }, (args) => ({
            path: args.path,
            namespace: 'stub-data-json'
          }));
          build.onLoad({ filter: /.*/, namespace: 'stub-data-json' }, () => ({
            // Field-kind packs are read at import. The tree test never uses them.
            contents:
              'const empty = []; module.exports = new Proxy({}, { get() { return empty; } });',
            loader: 'js'
          }));
        }
      }
    ]
  });
  await esbuild.stop();
  return require(bundlePath).RecordsTreeProvider;
}

/**
 * Catalog stand-in. RecordsTreeProvider only needs the lookup and change
 * surface the tree actually calls.
 */
function createCatalog(tableNames) {
  const listeners = new Set();
  const catalog = {
    loaded: true,
    tables: tableNames.map((name) => ({ name, records: [{}] })),
    onDidChange(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    notify() {
      for (const listener of [...listeners]) {
        listener();
      }
    },
    isEnabled() {
      return true;
    },
    isLoaded() {
      return this.loaded;
    },
    getTables() {
      return this.tables.map((table) => table.name);
    },
    getRecordsForTable(name) {
      const table = this.tables.find((entry) => entry.name === name);
      return table ? table.records : [];
    },
    getRecordsForUri() {
      return [];
    },
    async ensure() {
      return true;
    }
  };
  return catalog;
}

function treeEvents(provider) {
  const events = [];
  provider.onDidChangeTreeData((event) => {
    events.push(event);
  });
  return events;
}

async function flushMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function main() {
  const RecordsTreeProvider = await loadProvider();
  const catalog = createCatalog(['sys_script_include', 'sys_script']);
  const provider = new RecordsTreeProvider(catalog);
  const events = treeEvents(provider);
  const folders = provider.getChildren();
  assert.strictEqual(folders.length, 2);
  assert.strictEqual(folders[0].id, 'table:sys_script_include');

  catalog.tables[0].records.push({});
  catalog.notify();
  assert.strictEqual(events.length, 1, 'catalog update should refresh once');
  assert.ok(Array.isArray(events[0]), 'same folders stay an element refresh');
  assert.strictEqual(
    events[0][0],
    folders[0],
    'sys_script_include folder object must stay registered'
  );
  assert.strictEqual(events[0][1], folders[1]);

  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.strictEqual(
    events.length,
    1,
    'a same-folder catalog update must not follow with a root refresh'
  );

  catalog.tables.push({ name: 'sys_ui_script', records: [{}] });
  catalog.notify();
  catalog.notify();
  assert.strictEqual(
    events.length,
    1,
    'root refreshes in one burst must not emit immediately'
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.strictEqual(events.length, 2);
  assert.strictEqual(
    events[1],
    undefined,
    'a burst of root refreshes emits one event'
  );

  const warm = createCatalog(['sys_script_include']);
  const warmProvider = new RecordsTreeProvider(warm);
  const warmEvents = treeEvents(warmProvider);
  const warmFolders = warmProvider.getChildren();
  warmProvider.setViewVisible(true);
  await flushMicrotasks();
  assert.strictEqual(warmEvents.length, 1);
  assert.strictEqual(warmEvents[0][0], warmFolders[0]);

  provider.dispose();
  warmProvider.dispose();
}

main()
  .then(() => {
    console.log('smoke-records-tree: ok');
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
