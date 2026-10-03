import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readModule, staticImportGraph } from './config/importGraph.js';

/**
 * Boot-payload boundary guard (Phase 15A — docs/PLAN.md).
 *
 * src/main.js's static import closure IS the entry bundle's app-code share,
 * and the entry chunk is the one file every visitor parses before first
 * paint (plus the workbox precache shell). The voice, scenes, and
 * annotations subsystems are first-use features; they ride behind the
 * dynamic `import()` seams declared at the top of main.js and the
 * `manualChunks` pinning in vite.config.js.
 *
 * This test is the enforcement half of that design: if ANY module reachable
 * statically from the entry imports back into a lazy boundary, the seam is
 * dead — the bundler pulls the async chunk's code straight back into the
 * entry chunk and the split silently stops existing (that is exactly how
 * the two original back edges, hud.js → voice/gevActions.js and
 * locations.js → annotations/annotationResolver.js, would have defeated it).
 * A failure names the offending module and who imports it; the fix is a
 * dynamic import at the first-use site, or moving the genuinely shared
 * helper out of the boundary directory into a leaf module.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mainEntry = resolve(repoRoot, 'src/main.js');

/** Modules/directories that must stay OUT of the entry chunk's static graph. */
const LAZY_BOUNDARY = Object.freeze({
  directories: Object.freeze(['src/voice/', 'src/scenes/', 'src/annotations/']),
  files: Object.freeze([
    'src/cockpitCloudEffects.js',
    'src/firstRunExperience.js',
  ]),
});

const inBoundary = (relativePath) => (
  LAZY_BOUNDARY.files.includes(relativePath)
  || LAZY_BOUNDARY.directories.some((dir) => relativePath.startsWith(dir))
);

const graph = staticImportGraph(mainEntry, repoRoot);
const relative = (absolutePath) => absolutePath.slice(repoRoot.length + 1);

test('entry closure stays outside the lazy seam boundary', () => {
  const offenders = [...graph.files]
    .map(([file]) => relative(file))
    .filter(inBoundary);
  assert.deepEqual(
    offenders,
    [],
    `Boot boundary violated — these lazy-seam modules are back in the entry `
    + `chunk's static graph: ${offenders.join(', ')}. Cut the static import `
    + `(dynamic-import at the first-use site) or move the shared helper out `
    + `of the boundary directory; a static edge anywhere in the closure `
    + `silently re-inlines the async chunk into boot.`,
  );
});

test('every lazy seam is declared as a dynamic import in main.js', () => {
  const mainModule = graph.files.get(mainEntry);
  const dynamicTargets = new Set(mainModule.dynamicDeps.map(relative));
  const declared = [
    'src/voice/gevRealtime.js',
    'src/scenes/director.js',
    'src/annotations/index.js',
    'src/cockpitCloudEffects.js',
    'src/firstRunExperience.js',
  ];
  const missing = declared.filter((seam) => !dynamicTargets.has(seam));
  assert.deepEqual(
    missing,
    [],
    `Seam chunks lost their dynamic import in src/main.js: ${missing.join(', ')}. `
    + `The seams object at the top of the file must fetch every boundary `
    + `subsystem; without it the feature loads never start and the chunk `
    + `only loads on (possibly never) first use.`,
  );
});

test('when the boundary is breached, the failure names the importing closure file', () => {
  // Self-test of the guard's diagnostic value: synthesise the importer scan
  // the failure message promises, so a future regression is triageable from
  // the assertion output alone. No boundary breach exists on the green path
  // (previous test), so this walk asserts the SCAN ITSELF stays sound: every
  // static edge it reports is real, and it reports none inside boundary dirs
  // that are not themselves closure members.
  const closureMembers = new Set([...graph.files.keys()]);
  for (const [file, module] of graph.files) {
    for (const dep of module.staticDeps) {
      assert.ok(
        closureMembers.has(dep),
        `static edge ${relative(file)} -> ${relative(dep)} resolved outside the walked closure`,
      );
    }
  }
});

test('the seams are the only dynamic exits main.js needs', () => {
  const mainModule = graph.files.get(mainEntry);
  // geoid.js-style lazy DATASET chunks are declared in the modules that use
  // them, not here; main.js's own dynamic graph should be exactly the five
  // seams — anything else appearing here is a new seam decision that belongs
  // in this test and the budget table, not a silent addition.
  const dynamicTargets = mainModule.dynamicDeps.map(relative).sort();
  assert.deepEqual(dynamicTargets, [
    'src/annotations/index.js',
    'src/cockpitCloudEffects.js',
    'src/firstRunExperience.js',
    'src/scenes/director.js',
    'src/voice/gevRealtime.js',
  ]);
});

test('main.js parses with the same edge set the bundler sees', () => {
  // The walker is regex-based; this pins its output against a drift that
  // would matter: main.js must have static deps (it is not a leaf) and at
  // least the cesium external, and every resolved dep must exist on disk
  // (resolveSpecifier only returns existing files — asserted for the whole
  // closure in the previous test; here for the entry's own parse shape).
  const mainModule = readModule(mainEntry, repoRoot);
  assert.ok(mainModule.staticDeps.length > 10, 'entry still statically wires the app together');
  assert.ok(mainModule.externals.includes('cesium'));
});

/** Boundary directories pinned to one manual chunk each (vite.config.js). */
const PINNED_CHUNK_DIRS = Object.freeze({
  voice: 'src/voice/',
  scenes: 'src/scenes/',
  annotations: 'src/annotations/',
});

const chunkDirOf = (relativePath) => (
  Object.entries(PINNED_CHUNK_DIRS).find(([, dir]) => relativePath.startsWith(dir))?.[0] ?? null
);

/** Every repo module inside one boundary directory. */
const modulesInDir = (dir) => (
  readdirSync(resolve(repoRoot, dir), { recursive: true })
    .filter((name) => /\.m?js$/.test(name))
    .map((name) => resolve(repoRoot, dir, name))
);

// One parse per module, shared across all four walks below — the closures
// overlap heavily and each boundary walk would otherwise re-read the shared
// data-layer modules.
const parseCache = new Map();
const parse = (file) => {
  if (!parseCache.has(file)) parseCache.set(file, readModule(file, repoRoot));
  return parseCache.get(file);
};

test('pinned chunks never reach each other statically (no manual-chunk cycle)', () => {
  // Rollup breaks a cycle between manual chunks by hoisting their shared
  // imports (the whole of Cesium, for one) into one of them and making the
  // entry load that chunk statically — which is precisely how the first seam
  // build regressed into a 4.75 MB annotations chunk with a boot waterfall.
  // The one real edge of that shape was voice/gevActions.js ->
  // annotations/annotationResolver.js; it is now a lazy import at the call
  // site. This test keeps every future cross-chunk edge out at source level,
  // where the fix is cheap, instead of in build output, where it is a
  // surprise.
  const crossings = [];
  for (const [chunkName, dir] of Object.entries(PINNED_CHUNK_DIRS)) {
    const visited = new Set();
    const queue = modulesInDir(dir);
    while (queue.length) {
      const file = queue.pop();
      if (visited.has(file)) continue;
      visited.add(file);
      const module = parse(file);
      for (const dep of module.staticDeps) {
        const depChunk = chunkDirOf(relative(dep));
        if (depChunk && depChunk !== chunkName) {
          crossings.push(`${relative(file)} -> ${relative(dep)} (${chunkName} -> ${depChunk})`);
        }
        if (!visited.has(dep)) queue.push(dep);
      }
    }
  }
  assert.deepEqual(
    crossings,
    [],
    `Manual-chunk cycle detected — static edges between pinned chunks: `
    + `${crossings.join('; ')}. Cut the edge with a lazy import() at the `
    + `first-use site (both modules' consumers await async providers, so a `
    + `promise-returning wrapper is contract-identical), or move the shared `
    + `helper into a leaf module outside the pinned directories.`,
  );
});
