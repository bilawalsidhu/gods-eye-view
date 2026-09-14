import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = fileURLToPath(new URL('.', import.meta.url));

/**
 * `src/server/` is reached only from `vite.config.js` — it is the dev/preview
 * server's own code and is never part of a browser bundle. The second test
 * below is what makes that safe to assert rather than merely assume.
 */
const SERVER_ONLY = 'server/';

/** Every module under `src/`, as repo-relative POSIX paths. Test files are Node-only. */
function modules(directory = SRC_ROOT) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...modules(absolute));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(absolute);
  }
  return files.sort();
}

const relative = (file) => path.relative(SRC_ROOT, file).split(path.sep).join('/');

test('no browser-built module imports a Node core module', () => {
  // Vite externalizes `node:*` for the browser and only WARNS, so a stray
  // import survives the build and turns into a runtime failure the moment the
  // guard around it is wrong. src/data/naturalEarthRegions.js and
  // src/data/neighborhoodPolygons.js both carried one to read their bundled
  // JSON packs under node:test; an import attribute serves both runtimes.
  //
  // A binary asset has no such trick, so `data/landSeaMask.js` (browser, fetch)
  // and `server/landSeaMaskNode.js` (Node, node:fs) are two modules over one
  // pure codec rather than one module branching on `isNode`.
  const offenders = [];
  for (const file of modules()) {
    const name = relative(file);
    if (name.startsWith(SERVER_ONLY)) continue;
    const source = readFileSync(file, 'utf8');
    // Static `from 'node:fs'` and dynamic `import('node:fs')`, quoted either way.
    if (/\bfrom\s*['"]node:|\bimport\s*\(\s*(?:\/\*[^*]*\*\/\s*)?['"]node:/.test(source)) {
      offenders.push(name);
    }
  }

  assert.deepEqual(offenders, [], `Node core imports reached the browser build: ${offenders.join(', ')}`);
});

test('no browser-built module imports from src/server/', () => {
  // The carve-out above is only sound while this holds: the moment a browser
  // module reaches into `src/server/`, the Node builtins that tree is allowed
  // to use become browser imports again, and the first test would wave them
  // through. Checked here rather than trusted.
  const offenders = [];
  for (const file of modules()) {
    const name = relative(file);
    if (name.startsWith(SERVER_ONLY)) continue;
    const source = readFileSync(file, 'utf8');
    if (/\bfrom\s*['"][^'"]*\/server\/|\bimport\s*\(\s*['"][^'"]*\/server\//.test(source)) {
      offenders.push(name);
    }
  }

  assert.deepEqual(offenders, [], `browser modules importing server-only code: ${offenders.join(', ')}`);
});
