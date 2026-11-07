/**
 * A public entry that reaches the renderer bridge (`rendererOf.js`) may hand
 * `cameraOf` a viewer of the consumer's own, with no renderer bound. The
 * bridge builds a camera port for it with the factory the Cesium adapter
 * provides as `render/cesium/camera.js` loads, so every such entry must load
 * that module too. It loads `render/cesium/credits.js`, whose factory
 * builds `findCredits`' port for such a viewer the same way.
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

/**
 * Entries that take their Cesium code injected: the module named here is
 * GEV's Cesium side for them, and must load the factory. Given another, the
 * entry's flight finds no camera (`findCamera`) and does nothing.
 */
const INJECTED = {
  './layers/recent-imagery': 'src/layers/recentImagery/rendering.js',
};

/**
 * Modules whose use of the bridge holds up without the factory: with no
 * port they read Cesium's `trackedEntity` instead, which is all an unbound
 * viewer can follow by.
 */
const FALLS_BACK = new Set(['src/data/followed.js']);

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
    if (!loads(entry) && !(carrier && loads(carrier))) missing.push(key);
  }
  assert.ok(bridged > 0, 'no entry reaches the bridge: the walk is broken');
  assert.deepEqual(
    missing,
    [],
    `These entries can reach cameraOf without ${FACTORY}; import it where the entry first reaches the bridge.`,
  );
});
