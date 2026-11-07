/**
 * A public entry that reaches the renderer bridge (`rendererOf.js`) may hand
 * `cameraOf` a viewer of the caller's own, with no renderer bound. The
 * bridge builds a camera port for it with the factory the Cesium adapter
 * provides as `render/cesium/camera.js` loads, so every such entry must load
 * that module too. It loads `render/cesium/credits.js`, whose factory
 * builds `findCredits`' port for such a viewer the same way.
 * Likewise an entry that reaches a caller of `findEffects` must load
 * `render/cesium/effects.js`, which provides the effects factory, and one
 * that reaches a caller of `findGlobe` must load `render/cesium/globe.js`.
 * An entry that reaches a caller of `findDraw` or `drawOf` loads
 * `render/cesium/draw.js` the same way (the camera factory loads it),
 * unless it is Cesium-free: then it is listed in `DRAW_FROM_CALLER`, and
 * a caller handing it a viewer with no renderer bound loads the package's
 * `./render/cesium/unbound` export once.
 *
 * The graph is every static import, re-export and literal dynamic import of
 * the entry's module and those it reaches, read by the parsers the Cesium
 * ratchet uses; bare specifiers (packages) end the walk.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsers } from 'prettier/plugins/babel.mjs';
import { parse as parseSfc } from 'vue/compiler-sfc';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const BRIDGE = 'src/render/rendererOf.js';
const FACTORY = 'src/render/cesium/camera.js';
const EFFECTS_FACTORY = 'src/render/cesium/effects.js';
const GLOBE_FACTORY = 'src/render/cesium/globe.js';
const DRAW_FACTORY = 'src/render/cesium/draw.js';
const UNBOUND = 'src/render/cesium/unbound.js';

/**
 * Entries that take their Cesium code injected: the module named here is
 * GEV's Cesium side for them, and must load the factories. Given another, the
 * entry's flight finds no camera (`findCamera`) and does nothing. Visual
 * settings are given their viewer by the application shell, which loads
 * both factories; without it, their styles keep records and draw nothing.
 */
const INJECTED = {
  './layers/recent-imagery': 'src/layers/recentImagery/rendering.js',
  './ui/visual-settings': 'src/ui/applicationShell.js',
};

/**
 * Modules whose use of the bridge holds up without the factory: with no
 * port they read Cesium's `trackedEntity` instead, which is all an unbound
 * viewer can follow by.
 */
const FALLS_BACK = new Set(['src/data/followed.js']);

/**
 * Cesium-free entries that draw through `drawOf`: their own modules cannot
 * load the Cesium adapter (the Cesium ratchet), so a viewer with no
 * renderer bound draws once its owner has loaded `./render/cesium/unbound`;
 * until then `drawOf` throws, naming it, rather than draw nothing. That
 * export loads the camera factory too, so these entries' camera is the
 * caller's to load the same way.
 */
const DRAW_FROM_CALLER = new Set([
  './layers/earthquakes',
  './layers/bikeshare',
  './layers/gnss',
  './layers/perimeters',
]);

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

/** The browser module an export resolves to, or null for Node-only ones. */
function browserTarget(declaration) {
  if (typeof declaration === 'string') return declaration;
  if (!declaration || typeof declaration !== 'object') return null;
  for (const condition of ['browser', 'import', 'default']) {
    const target = browserTarget(declaration[condition]);
    if (target) return target;
  }
  return null;
}

function specifiersOf(file) {
  let code = readFileSync(path.join(root, file), 'utf8');
  if (file.endsWith('.vue')) {
    const { descriptor } = parseSfc(code, { filename: file });
    code = [descriptor.script, descriptor.scriptSetup]
      .filter(Boolean)
      .map((block) => block.content)
      .join('\n');
  }
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (
      (node.type === 'ImportDeclaration' ||
        node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportAllDeclaration') &&
      node.source
    )
      found.push({ specifier: node.source.value, lazy: false });
    if (
      node.type === 'ImportExpression' &&
      node.source?.type === 'StringLiteral'
    )
      found.push({ specifier: node.source.value, lazy: true });
    if (
      node.type === 'CallExpression' &&
      node.callee?.type === 'Import' &&
      node.arguments[0]?.type === 'StringLiteral'
    )
      found.push({ specifier: node.arguments[0].value, lazy: true });
    for (const key of Object.keys(node))
      if (key !== 'loc' && key !== 'start' && key !== 'end') walk(node[key]);
  };
  walk(parsers.babel.parse(code));
  return found;
}

/** A relative specifier as a repository file, or null when it is a package. */
function resolve(from, specifier) {
  const bare = specifier.split('?')[0];
  if (!bare.startsWith('.')) return null;
  const base = path.join(path.dirname(from), bare);
  const candidates = ['', '.js', '.mjs', '.vue', '/index.js', '/index.mjs'];
  for (const suffix of candidates) {
    const full = path.join(root, base + suffix);
    if (existsSync(full) && statSync(full).isFile())
      return path.normalize(base + suffix);
  }
  // A subgraph dropped here would hide a missing factory.
  throw new Error(`${from}: cannot resolve ${specifier}`);
}

/**
 * The modules `entry` reaches. With `eager`, only through static imports:
 * what has loaded once the entry has, before any lazy import resolves.
 */
function reachable(entry, { eager = false } = {}) {
  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (!/\.(m?js|vue)$/.test(file)) continue;
    for (const { specifier, lazy } of specifiersOf(file)) {
      if (eager && lazy) continue;
      const next = resolve(file, specifier);
      if (next === BRIDGE && FALLS_BACK.has(file)) continue;
      if (next && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

test('the unbound camera factory loads the unbound credits factory', () => {
  assert.ok(
    reachable(FACTORY, { eager: true }).has('src/render/cesium/credits.js'),
  );
});

test('every public entry that reaches the renderer bridge loads the unbound camera factory', () => {
  const missing = [];
  let bridged = 0;
  for (const [key, declaration] of Object.entries(pkg.exports)) {
    const target = browserTarget(declaration);
    if (typeof target !== 'string' || !target.startsWith('./src/')) continue;
    const entry = path.normalize(target.slice(2));
    const graph = reachable(entry);
    // Any path to the bridge counts, lazy or not; only an eager one loads
    // the factory in time for the first `cameraOf`.
    if (!graph.has(BRIDGE)) continue;
    bridged += 1;
    const carrier = INJECTED[key];
    const loads = (file) => reachable(file, { eager: true }).has(FACTORY);
    if (DRAW_FROM_CALLER.has(key)) continue;
    if (!loads(entry) && !(carrier && loads(carrier))) missing.push(key);
  }
  assert.ok(bridged > 0, 'no entry reaches the bridge: the walk is broken');
  assert.deepEqual(
    missing,
    [],
    `These entries can reach cameraOf without ${FACTORY}; import it where the entry first reaches the bridge.`,
  );
});

/**
 * Every public entry reaching a caller of `lookup` loads `factory`. With
 * `reached`, at least one entry must reach one, or the walk is broken.
 */
function checkLookupFactory(lookup, factory, { reached = true } = {}) {
  const missing = [];
  let reaching = 0;
  const calls = (file) =>
    !file.startsWith('src/render/') &&
    /\.(m?js|vue)$/.test(file) &&
    new RegExp(`\\b${lookup}\\b`).test(
      readFileSync(path.join(root, file), 'utf8'),
    );
  for (const [key, declaration] of Object.entries(pkg.exports)) {
    const target = browserTarget(declaration);
    if (typeof target !== 'string' || !target.startsWith('./src/')) continue;
    const entry = path.normalize(target.slice(2));
    if (![...reachable(entry)].some(calls)) continue;
    reaching += 1;
    const carrier = INJECTED[key];
    const loads = (file) => reachable(file, { eager: true }).has(factory);
    if (!loads(entry) && !(carrier && loads(carrier))) missing.push(key);
  }
  if (reached)
    assert.ok(reaching > 0, `no entry reaches ${lookup}: the walk is broken`);
  assert.deepEqual(
    missing,
    [],
    `These entries can reach ${lookup} without ${factory}; import it where the entry first reaches the lookup.`,
  );
}

test('every public entry that reaches a findEffects caller loads the unbound effects factory', () => {
  checkLookupFactory('findEffects', EFFECTS_FACTORY);
});

test('every public entry that reaches a findGlobe caller loads the unbound globe factory', () => {
  // A caller may take `findGlobe` as a default rather than call it, so any
  // use of the name counts.
  checkLookupFactory('findGlobe', GLOBE_FACTORY);
});

test('the unbound export brings every unbound factory', () => {
  const loaded = reachable(UNBOUND, { eager: true });
  for (const factory of [
    FACTORY,
    EFFECTS_FACTORY,
    DRAW_FACTORY,
    'src/render/cesium/credits.js',
  ])
    assert.ok(loaded.has(factory), factory);
});

test('every public entry that reaches a findDraw caller loads the unbound draw factory, or its caller can', () => {
  const missing = [];
  const callsFindDraw = (file) =>
    !file.startsWith('src/render/') &&
    /\.(m?js|vue)$/.test(file) &&
    /\b(findDraw|drawOf)\(/.test(readFileSync(path.join(root, file), 'utf8'));
  assert.equal(
    pkg.exports['./render/cesium/unbound'],
    `./${UNBOUND}`,
    'the factory loads through this export',
  );
  for (const [key, declaration] of Object.entries(pkg.exports)) {
    const target = browserTarget(declaration);
    if (typeof target !== 'string' || !target.startsWith('./src/')) continue;
    const entry = path.normalize(target.slice(2));
    if (![...reachable(entry)].some(callsFindDraw)) continue;
    const carrier = INJECTED[key];
    const loads = (file) => reachable(file, { eager: true }).has(DRAW_FACTORY);
    if (DRAW_FROM_CALLER.has(key)) {
      assert.ok(!loads(entry), `${key} loads the factory: unlist it`);
      continue;
    }
    if (!loads(entry) && !(carrier && loads(carrier))) missing.push(key);
  }
  assert.deepEqual(
    missing,
    [],
    `These entries can reach findDraw without ${DRAW_FACTORY}; import it, or list a Cesium-free entry in DRAW_FROM_CALLER.`,
  );
});
