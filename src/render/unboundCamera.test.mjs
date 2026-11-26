/**
 * A public entry that reaches the renderer bridge (`rendererOf.js`) may hand
 * `cameraOf` a Cesium viewer with no renderer bound. The
 * bridge builds a camera port for it with the factory the Cesium adapter
 * provides as `render/cesium/camera.js` loads, so every such entry must load
 * that module too. It loads `render/cesium/credits.js`, whose factory
 * builds `findCredits`' port for such a viewer the same way.
 * Likewise an entry that reaches a caller of `findEffects` must load
 * `render/cesium/effects.js`, which provides the effects factory, and one
 * that reaches a caller of `findGlobe` must load `render/cesium/globe.js`,
 * or be such a Cesium-free entry (below).
 * An entry that reaches a caller of `findDraw` or `drawOf` loads
 * `render/cesium/draw.js` the same way (the camera factory loads it),
 * unless it is Cesium-free: then it is listed in `DRAW_FROM_CALLER`, and
 * a caller handing it a viewer with no renderer bound loads the package's
 * `./render/cesium/unbound` export once. An entry that reaches a caller of
 * `findQuery` or `queryOf` loads `render/cesium/query.js`, and one that
 * reaches a caller of `findFrame` or `frameOf` loads
 * `render/cesium/frame.js` (the camera factory loads both), or is such a
 * Cesium-free entry.
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
const QUERY_FACTORY = 'src/render/cesium/query.js';
const FRAME_FACTORY = 'src/render/cesium/frame.js';
const INPUT_FACTORY = 'src/render/cesium/input.js';
const NATIVE_CLICK = 'src/render/cesium/nativeClick.js';
const UNBOUND = 'src/render/cesium/unbound.js';

/**
 * Entries that take their Cesium code injected: the module named here is
 * GEV's Cesium side for them, and must load the factories. Given another, the
 * entry's flight finds no camera (`findCamera`) and does nothing. None is
 * left: visual settings, once given their viewer by the application shell,
 * now leave the factories to their caller as the shell does.
 */
const INJECTED = {};

/**
 * Modules whose use of the bridge holds up without the factory: with no
 * camera port they report nothing followed.
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
  './layers/drone-airspace',
  './layers/awareness',
  './layers/submarine-cables',
  './layers/alpr',
  './layers/vessels',
  './layers/street-level',
  './layers/street-level/mapillary',
  './layers/street-level/kartaview',
  './layers/street-level/panoramax',
  './layers/air-quality',
  './layers/directions',
  // Its icons, wireframes, volumes, plane and gizmo draw through `drawOf`;
  // it picks, projects and reads the eye and the globe through the ports.
  './layers/cctv',
  // Its heat cells and fire glows draw through `drawOf`; its cards and LOD
  // watcher read the eye, projection and frames through the ports.
  './layers/firms',
  // Its station dots, clusters and selected marker draw through `drawOf`;
  // it clusters them on screen through the camera and query ports.
  './layers/radio',
  // Its site dots, outlines and selected fill draw through `drawOf`; it
  // follows a site and reads the globe through the camera and globe ports.
  './layers/installations',
  // Its dots, tracked dot and orbit rings draw through `drawOf`; it follows,
  // ticks, projects and reads the eye through the ports.
  './layers/satellites',
  // Its data packs draw through `drawOf`; its flights ask `cameraOf`, which
  // throws until then too.
  './scenes',
  // Asks `findQuery` instead, and answers null rather than throw until the
  // caller has loaded the factory.
  './queries/heights',
  // Their fleet icons draw through `drawOf`; they take clicks through the
  // dispatcher (`findInput`, `findQuery`).
  './layers/flights',
  './layers/military',
  // Its layers draw, size, fly and take clicks through the ports alone.
  './infrastructure',
  './infrastructure/geojson',
  // Its missions draw, pick and fly through the ports alone.
  './layers/launches',
  // Its world marks draw through `drawOf` and probe heights through
  // `heightsOf`; its screen marks project through the camera and query ports.
  './annotations',
  // Its pins, footprints and outlines draw through `drawOf`; its horizon
  // cull reads the camera and frame ports.
  './layers/ghostmaps',
  // Its moving and still vehicle icons draw through `drawOf`; it projects,
  // culls, follows and samples floors through the ports.
  './layers/transit',
  // Its layer draws and reads the view through the ports alone, and its mesh
  // floor sampler asks the camera, globe and query ports.
  './layers/transit/standalone',
  // Its badges, density glow and privacy cells draw through `drawOf`; it
  // takes clicks, projects and reads the eye and the globe through the ports.
  './layers/wildlife-sightings',
  // Its dots and heat-lines draw through `drawOf`; it reads the eye, the
  // surface (its identity and whether it has loaded) and heights through
  // the camera, globe and query ports.
  './layers/traffic',
  // It configures the sources of layers, the traffic layer's among them,
  // that draw and read the surface through the ports alone.
  './application/sources',
  // The layer catalog and the standalone catalog over it: their layers, the
  // weather shells and the wind flow and relief among them, draw, read the
  // eye and shade the globe through the ports alone.
  './application/layers',
  './standalone/catalog',
  // The application's tools (scene director, annotations, embed views,
  // Import): they draw, fly and take clicks through the ports.
  './application/tools',
]);

/**
 * Cesium-free entries that reach the camera port but draw nothing: given a
 * viewer with no renderer bound, they find no camera
 * (`findCamera` is null) and leave it alone until the caller loads
 * `./render/cesium/unbound`.
 */
const CAMERA_FROM_CALLER = new Set([
  // The click dispatcher: it takes input, picks and grounds through
  // `findInput`, `findQuery` and the adapter's native clicks.
  './input',
  // It loads no factory: Cockpit moves the camera on the frame port's
  // preUpdate, and
  // `frameOf` throws, naming the export, until the caller has loaded it.
  './ui/cockpit',
  './ui/navigation',
  // Its Quebec camera overlay reads the eye, projects and redraws through
  // `findCamera`, `findQuery` and `findFrame`, and shows nothing without them.
  './ui/cctv',
  './voice/commands',
  './voice/controller',
  // It loaded the camera factory only through the CCTV layer it took a
  // constant from.
  './voice/actions',
  './voice/realtime-session',
  // It flies through `findCamera` and drapes through `findGlobe`; the
  // renderer the application gives it (`rendering.js`, which draws the box
  // preview through `drawOf`) is Cesium-free too.
  './layers/recent-imagery',
  // Its ground snap, mesh floor sampler, annotation resolver and location
  // framing ask the camera, globe and query ports; it loads no factory.
  './application/operations',
  // It shows its source's credit through `findCredits`, and switches stacks
  // through the map engine that `./render/cesium/unbound` provides too.
  './maps/controller',
  // The application shell and what assembles it: their controls fly, read
  // the eye, shade the globe and set styles through the ports alone; the
  // application's renderer is bound to its viewer, and a viewer with no
  // renderer bound gets its ports from `./render/cesium/unbound`.
  './ui/shell',
  './ui/composition',
  './ui/hud',
  './ui/visual-settings',
  './application/controls',
  './application/data',
  // The opening flies the camera of the viewer it is given (`findCamera`),
  // and plays nothing without one; the view over the visitor's country only
  // reads `START_VIEW` from the camera module.
  './application/opening',
  './application/home-country',
  // The scene binds the renderer it creates (the default one loaded only
  // when it is given none), so its own viewer needs no factory.
  './application/scene',
  // The map stacks switch through the renderer's map engine or its globe
  // port (`maps/globeEngine.js`), which a viewer with no renderer bound gets
  // from `./render/cesium/unbound`.
  './maps/defaults',
  // It restores a shared view through the camera, frame and canvas of the
  // renderer bound to the viewer it is given; it loads no factory.
  './ui/share-restoration',
  // It reads the eye from the camera port's pose, and none without one.
  './agent/world-packet',
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
    if (CAMERA_FROM_CALLER.has(key)) {
      assert.ok(!loads(entry), `${key} loads the factory: unlist it`);
      continue;
    }
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
 * With `fromCaller`, the Cesium-free entries listed in
 * `DRAW_FROM_CALLER` may leave the factory to their caller.
 */
function checkLookupFactory(
  lookup,
  factory,
  { reached = true, fromCaller = false } = {},
) {
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
    if (
      fromCaller &&
      (DRAW_FROM_CALLER.has(key) || CAMERA_FROM_CALLER.has(key))
    )
      continue;
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

test('every public entry that reaches a findEffects caller loads the unbound effects factory, or its caller can', () => {
  checkLookupFactory('findEffects', EFFECTS_FACTORY, { fromCaller: true });
});

test('every public entry that reaches a findGlobe caller loads the unbound globe factory', () => {
  // A caller may take `findGlobe` as a default rather than call it, so any
  // use of the name counts. A Cesium-free entry with no globe port (its
  // caller has not loaded `./render/cesium/unbound`) reads the globe as
  // unknown.
  checkLookupFactory('findGlobe', GLOBE_FACTORY, { fromCaller: true });
});

test('every public entry that reaches a findQuery or queryOf caller loads the unbound query factory, or its caller can', () => {
  checkLookupFactory('findQuery', QUERY_FACTORY, { fromCaller: true });
  checkLookupFactory('queryOf', QUERY_FACTORY, {
    reached: false,
    fromCaller: true,
  });
});

test('every public entry that reaches a findFrame or frameOf caller loads the unbound frame factory, or its caller can', () => {
  checkLookupFactory('findFrame', FRAME_FACTORY, { fromCaller: true });
  checkLookupFactory('frameOf', FRAME_FACTORY, {
    reached: false,
    fromCaller: true,
  });
});

test('every public entry that reaches a findInput or nativeClickOf caller loads the unbound input factory and native clicks, or its caller can', () => {
  checkLookupFactory('findInput', INPUT_FACTORY, { fromCaller: true });
  checkLookupFactory('nativeClickOf', NATIVE_CLICK, { fromCaller: true });
});

test('the unbound camera factory loads the unbound query, frame and input factories and native clicks', () => {
  const loaded = reachable(FACTORY, { eager: true });
  assert.ok(loaded.has(QUERY_FACTORY));
  assert.ok(loaded.has(FRAME_FACTORY));
  assert.ok(loaded.has(INPUT_FACTORY));
  assert.ok(loaded.has(NATIVE_CLICK));
});

test('the unbound export brings every unbound factory', () => {
  const loaded = reachable(UNBOUND, { eager: true });
  for (const factory of [
    FACTORY,
    EFFECTS_FACTORY,
    DRAW_FACTORY,
    QUERY_FACTORY,
    FRAME_FACTORY,
    INPUT_FACTORY,
    NATIVE_CLICK,
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
