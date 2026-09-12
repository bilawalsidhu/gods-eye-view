import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = fileURLToPath(new URL('.', import.meta.url));

/**
 * Directories under src/ that are Node-only by design: vite.config.js imports
 * them for dev-server proxies and they never reach the browser bundle. They
 * are allowed to import Node core modules, and the second test below proves
 * no browser module imports from them.
 */
const SERVER_ONLY_DIRS = new Set(['hamrig']);

/** Every browser-built module under src/ — the test files are Node-only. */
function browserModules(directory = SRC_ROOT) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (directory === SRC_ROOT && SERVER_ONLY_DIRS.has(entry.name)) continue;
      files.push(...browserModules(absolute));
    } else if (entry.isFile() && entry.name.endsWith('.js')) files.push(absolute);
  }
  return files.sort();
}

test('no browser-built module imports from a server-only directory', () => {
  const offenders = [];
  for (const file of browserModules()) {
    const source = readFileSync(file, 'utf8');
    for (const dir of SERVER_ONLY_DIRS) {
      if (new RegExp(`from\\s*['"][^'"]*/${dir}/`).test(source) || new RegExp(`import\\s*\\(\\s*['"][^'"]*/${dir}/`).test(source)) {
        offenders.push(path.relative(SRC_ROOT, file).split(path.sep).join('/'));
      }
    }
  }
  assert.deepEqual(offenders, [], `Browser modules import server-only code: ${offenders.join(', ')}`);
});

test('no browser-built module imports a Node core module', () => {
  // Vite externalizes `node:*` for the browser and only WARNS, so a stray
  // import survives the build and turns into a runtime failure the moment the
  // guard around it is wrong. src/data/naturalEarthRegions.js and
  // src/data/neighborhoodPolygons.js both carried one to read their bundled
  // JSON packs under node:test; an import attribute serves both runtimes.
  const offenders = [];
  for (const file of browserModules()) {
    const source = readFileSync(file, 'utf8');
    // Static `from 'node:fs'` and dynamic `import('node:fs')`, quoted either way.
    if (/\bfrom\s*['"]node:|\bimport\s*\(\s*(?:\/\*[^*]*\*\/\s*)?['"]node:/.test(source)) {
      offenders.push(path.relative(SRC_ROOT, file).split(path.sep).join('/'));
    }
  }

  assert.deepEqual(offenders, [], `Node core imports reached the browser build: ${offenders.join(', ')}`);
});
