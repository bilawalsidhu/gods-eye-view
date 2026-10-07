import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createCoverage, ZOOM_IN_HINT } from './coverage.js';
import { freshCoverage } from '../../state.js';
import { encodeCoverageTile } from './coverageFixture.mjs';
import { rayCamera } from '../../../../testSupport/streetLevelFakes.mjs';
import {
  COLORS,
  COVERAGE_MAX_SEQUENCES,
  COVERAGE_MAX_TILES,
} from './policy.js';
import { lonToTileX, latToTileY, tileBounds } from '../../tileMath.js';

const RAD = Math.PI / 180;
// Node has no WebGL context to report line-width limits; a browser's
// context sets these on startup, and appearances validate against them.
Cesium.ContextLimits._minimumAliasedLineWidth = 1;
Cesium.ContextLimits._maximumAliasedLineWidth = 10;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A scene collection that remembers what is on the globe. */
function collection() {
  const items = new Set();
  return {
    items,
    add(primitive) {
      items.add(primitive);
      return primitive;
    },
    remove(primitive) {
      return items.delete(primitive);
    },
  };
}

/** The centre of the z14 tile holding a point, so a small view is one tile. */
function tileCentre(lon, lat) {
  const x = lonToTileX(lon, 14);
  const y = latToTileY(lat, 14);
  const { west, east, south, north } = tileBounds(x, y, 14);
  return {
    tile: { x, y, z: 14 },
    lon: (west + east) / 2,
    lat: (south + north) / 2,
  };
}

/** A viewer looking straight down on a 0.004° square around `view`. */
function fakeViewer(view) {
  const postRender = new Set();
  const preRender = new Set();
  return {
    view,
    postRender,
    preRender,
    scene: {
      canvas: { clientWidth: 100, clientHeight: 100 },
      globe: { show: false, ellipsoid: Cesium.Ellipsoid.WGS84 },
      groundPrimitives: collection(),
      primitives: collection(),
      postRender: {
        addEventListener(listener) {
          postRender.add(listener);
          return () => postRender.delete(listener);
        },
      },
      preRender: {
        addEventListener(listener) {
          preRender.add(listener);
          return () => preRender.delete(listener);
        },
      },
    },
    camera: {
      get positionCartographic() {
        return {
          longitude: view.lon * RAD,
          latitude: view.lat * RAD,
          height: view.height,
        };
      },
      pickEllipsoid(point) {
        return Cesium.Cartesian3.fromDegrees(
          view.lon - 0.002 + (point.x / 100) * 0.004,
          view.lat + 0.002 - (point.y / 100) * 0.004,
        );
      },
      computeViewRectangle: () => undefined,
    },
  };
}

/** A source whose tile requests the test resolves, one call at a time. */
function deferredSource() {
  const calls = [];
  return {
    calls,
    getTile(layer, z, x, y, { signal } = {}) {
      return new Promise((resolve, reject) => {
        calls.push({ key: `${z}/${x}/${y}`, z, signal, resolve, reject });
      });
    },
  };
}

function setup() {
  const centre = tileCentre(-121.4944, 38.5816);
  const viewer = fakeViewer({ lon: centre.lon, lat: centre.lat, height: 900 });
  const source = deferredSource();
  const state = {
    viewer,
    services: {},
    enabled: true,
    providerOn: true,
    filter: { pano: 'all', sinceDays: 0 },
    notify() {},
    coverage: {
      ...freshCoverage(),
      // The key status is in; skip Cesium's one-time terrain table download.
      blocked: null,
      terrainReady: Promise.resolve(),
    },
    sequence: { selectedId: null },
  };
  const coverage = createCoverage({ state, source });
  const bytes = encodeCoverageTile(centre.tile, {
    sequences: [
      {
        id: 'seq-1',
        parts: [
          [
            [centre.lon - 0.001, centre.lat],
            [centre.lon + 0.001, centre.lat],
          ],
        ],
      },
    ],
  });
  const tileKey = `14/${centre.tile.x}/${centre.tile.y}`;
  const onGlobe = () =>
    viewer.scene.groundPrimitives.items.size +
    viewer.scene.primitives.items.size;
  return { viewer, source, state, coverage, bytes, tileKey, onGlobe, centre };
}

/** Run one frame's listeners, as Cesium's render loop would. */
function frame(listeners) {
  for (const listener of [...listeners]) listener();
}

test('a superseded tile request cannot strand lines on the globe', async () => {
  const { viewer, source, state, coverage, bytes, tileKey, onGlobe } = setup();
  const forTile = () => source.calls.filter((call) => call.key === tileKey);

  coverage.refresh(); // street zoom: request #1 for the tile
  assert.equal(forTile().length, 1);
  viewer.view.height = 100_000; // zoom out: clear() drops request #1
  coverage.refresh();
  viewer.view.height = 900; // back in before #1 settles: request #2
  coverage.refresh();
  assert.equal(forTile().length, 2);
  await settle();

  // The superseded request finishes late. It must not settle request #2's
  // key, or the next refresh would start a duplicate load.
  forTile()[0].resolve(bytes);
  await settle();
  assert.equal(
    state.coverage.pending.has(tileKey),
    true,
    '#2 still owns the key',
  );
  assert.equal(state.coverage.pending.size, 1, 'still loading');
  coverage.refresh();
  assert.equal(forTile().length, 2, 'no duplicate request');

  forTile()[1].resolve(bytes);
  await settle();
  assert.equal(state.coverage.tiles.size, 1);
  assert.ok(onGlobe() > 0, 'the tile drew its lines');

  // Everything drawn can be removed: nothing is orphaned.
  coverage.clear();
  assert.equal(onGlobe(), 0);
});

test('sequence lines are draped on the globe and on 3D tiles alike', async () => {
  const { viewer, source, coverage, bytes } = setup();
  coverage.refresh();
  source.calls[0].resolve(bytes);
  await settle();
  const { groundPrimitives, primitives } = viewer.scene;
  assert.equal(primitives.items.size, 0);
  assert.equal(groundPrimitives.items.size, 1);
  const [line] = groundPrimitives.items;
  assert.ok(line instanceof Cesium.GroundPolylinePrimitive);
  assert.equal(line.classificationType, Cesium.ClassificationType.BOTH);
  coverage.clear();
  assert.equal(groundPrimitives.items.size, 0);
});

test('panning off a tile that is still loading stops counting it as loading', async () => {
  const { viewer, source, state, coverage } = setup();
  coverage.refresh();
  assert.equal(state.coverage.pending.size, 1);
  // Same zoom, two tiles east: the first request is dropped, a new one starts.
  viewer.view.lon += 0.05;
  coverage.refresh();
  assert.equal(source.calls.length, 2);
  assert.equal(source.calls[0].signal.aborted, true);
  assert.equal(
    state.coverage.pending.size,
    1,
    'only the live request counts as loading',
  );
  source.calls[0].reject(new DOMException('aborted', 'AbortError'));
  source.calls[1].resolve(new Uint8Array());
  await settle();
  assert.equal(state.coverage.pending.size, 0, 'LOADING clears');
  coverage.clear();
});

test('from orbit nothing is requested or drawn, and the hint says to zoom in', async () => {
  const { viewer, source, state, coverage, bytes } = setup();
  coverage.refresh();
  source.calls[0].resolve(bytes);
  await settle();
  assert.ok(viewer.scene.groundPrimitives.items.size > 0, 'street lines');
  viewer.view.height = 20_000_000;
  coverage.refresh();
  assert.equal(source.calls.length, 1, 'no tile is asked for');
  assert.equal(viewer.scene.groundPrimitives.items.size, 0, 'nothing drawn');
  assert.equal(state.coverage.zoom, null);
  assert.equal(coverage.stats().hint, ZOOM_IN_HINT);
  viewer.view.height = 900;
  coverage.refresh();
  assert.equal(coverage.stats().hint, '', 'back at street zoom');
  assert.equal(source.calls.length, 2);
  coverage.clear();
});

test('the key status gates coverage: nothing before it answers, nothing without a key', () => {
  for (const configured of [false, true]) {
    const { source, state, coverage } = setup();
    state.coverage.blocked = 'status';
    coverage.refresh();
    assert.equal(source.calls.length, 0, 'nothing before the status answers');
    coverage.setKeyStatus(configured);
    if (configured)
      assert.equal(source.calls.length, 1, 'coverage loads once it is known');
    else {
      assert.equal(source.calls.length, 0, 'a key-less install never asks');
      assert.equal(coverage.stats().keyRequired, true);
      assert.equal(coverage.stats().keyRejected, false);
      coverage.unblock();
      assert.equal(
        coverage.stats().keyRequired,
        true,
        'kept: it is no refusal',
      );
    }
    coverage.clear();
  }
});

test('a rejected key stops coverage requests until the layer goes off', async () => {
  const { viewer, source, state, coverage } = setup();
  coverage.refresh();
  const rejected = Object.assign(
    new Error('Mapillary rejected the access token'),
    {
      keyRejected: true,
    },
  );
  source.calls[0].reject(rejected);
  await settle();
  assert.equal(state.coverage.blocked, 'rejected');
  assert.equal(coverage.stats().keyRequired, true, 'gated like a missing key');
  assert.equal(coverage.stats().keyRejected, true);
  assert.match(coverage.stats().error, /rejected MAPILLARY_CLIENT_TOKEN/);
  viewer.view.lon += 0.05;
  coverage.refresh();
  assert.equal(source.calls.length, 1, 'panning asks for nothing more');
  // Turning the layer off forgets the verdict; the next run asks again.
  coverage.clear();
  coverage.unblock();
  assert.equal(coverage.stats().keyRejected, false);
  assert.equal(coverage.stats().error, null);
  coverage.refresh();
  assert.equal(source.calls.length, 2);
  coverage.clear();
});

test('a rate limit keeps the drawn tiles and asks again once the wait is over', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { viewer, source, state, coverage } = setup();
  coverage.refresh();
  source.calls[0].reject(
    Object.assign(new Error('rate limited'), { retryAfterSec: 30 }),
  );
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.match(coverage.stats().error, /rate-limited/);
  assert.equal(coverage.stats().keyRequired, false);
  viewer.view.lon += 0.05;
  coverage.refresh();
  assert.equal(source.calls.length, 1, 'held: nothing is requested');
  t.mock.timers.tick(30_000);
  assert.equal(source.calls.length, 2, 'one refresh once the wait is over');
  assert.equal(coverage.stats().error, null);
  coverage.clear();
  coverage.unblock();
});

test('the per-tile cap applies after the imagery filter, so a dense tile keeps its 360° lines', async () => {
  const { state, source, coverage, centre } = setup();
  const line = (n) => [
    [
      [centre.lon - 0.001, centre.lat + n * 1e-6],
      [centre.lon + 0.001, centre.lat + n * 1e-6],
    ],
  ];
  // 700 newer flat sequences, then 300 older 360° ones.
  const sequences = [];
  for (let i = 0; i < 700; i++)
    sequences.push({
      id: `flat-${i}`,
      parts: line(i),
      capturedAt: 2_000_000_000_000 + i,
    });
  for (let i = 0; i < 300; i++)
    sequences.push({
      id: `pano-${i}`,
      parts: line(i),
      capturedAt: 1_000_000_000_000 + i,
      isPano: true,
    });
  state.filter = { pano: 'pano', sinceDays: 0 };
  coverage.refresh();
  source.calls[0].resolve(encodeCoverageTile(centre.tile, { sequences }));
  await settle();
  const [entry] = state.coverage.tiles.values();
  const cap = Math.floor(COVERAGE_MAX_SEQUENCES / COVERAGE_MAX_TILES);
  assert.equal(entry.count, Math.min(300, cap), 'every 360° line is drawn');
  assert.equal(coverage.sequenceCount(), Math.min(300, cap));
  // Picking and recolouring look sequences up among the drawn lines.
  assert.ok(entry.sequences.has('pano-0'), 'drawn lines can be looked up');
  assert.equal(entry.sequences.has('flat-699'), false);
  state.filter = { pano: 'all', sinceDays: 0 };
  coverage.rebuild();
  assert.equal(entry.count, cap, 'all imagery is capped as before');
  assert.ok(entry.sequences.has('flat-699'), 'the newest flat line is drawn');
  assert.equal(entry.sequences.has('pano-299'), false, 'over the cap');
  coverage.clear();
});

/** The colour attribute value of a line, selected or not. */
function colourValue(selected) {
  return Array.from(
    Cesium.ColorGeometryInstanceAttribute.toValue(
      selected
        ? Cesium.Color.fromCssColorString(COLORS.selected)
        : Cesium.Color.fromCssColorString(COLORS.coverage).withAlpha(0.92),
    ),
  );
}

/** Take over a drawn primitive's readiness and seq-1's colour attribute. */
function controlled(record, ready) {
  const control = { ready, attributes: { color: undefined } };
  Object.defineProperty(record.primitive, 'ready', {
    get: () => control.ready,
  });
  record.primitive.getGeometryInstanceAttributes = (id) =>
    id === 'mly:seq:seq-1' ? control.attributes : undefined;
  return control;
}

test('a selection made or cleared while a tile builds is applied once it is ready', async () => {
  const { viewer, source, state, coverage, bytes } = setup();
  coverage.refresh();
  source.calls[0].resolve(bytes);
  await settle();
  const [entry] = state.coverage.tiles.values();
  // Selected while its line is still building: nothing to recolour yet...
  const first = controlled(entry.primitives[0], false);
  state.sequence.selectedId = 'seq-1';
  coverage.recolorSequence('seq-1', true);
  assert.equal(first.attributes.color, undefined);
  // ...so the highlight lands once it is ready.
  first.ready = true;
  frame(viewer.postRender);
  assert.deepEqual(Array.from(first.attributes.color), colourValue(true));

  // Rebuilt with the highlight baked in, then cleared mid-build: not stuck.
  coverage.rebuild();
  const second = controlled(entry.primitives[0], false);
  coverage.recolorSequence('seq-1', false);
  state.sequence.selectedId = null;
  second.ready = true;
  frame(viewer.postRender);
  assert.deepEqual(Array.from(second.attributes.color), colourValue(false));
  coverage.clear();
  assert.equal(viewer.postRender.size, 0, 'the selection watch is gone');
});

test('a sequence that crosses a tile edge is counted once', async () => {
  const { viewer, source, coverage, centre } = setup();
  // Look straight down on the edge between this tile and its east neighbour.
  const { east } = tileBounds(centre.tile.x, centre.tile.y, 14);
  viewer.view.lon = east;
  coverage.refresh();
  assert.equal(source.calls.length, 2, 'two tiles in view');
  const across = [
    [
      [east - 0.001, centre.lat],
      [east + 0.001, centre.lat],
    ],
  ];
  for (const call of source.calls) {
    const [, x, y] = call.key.split('/').map(Number);
    call.resolve(
      encodeCoverageTile(
        { x, y, z: 14 },
        {
          sequences: [
            { id: 'across', parts: across },
            { id: `only-${x}`, parts: across },
          ],
        },
      ),
    );
  }
  await settle();
  assert.equal(coverage.sequenceCount(), 3, 'across, plus one per tile');
  coverage.clear();
});

/** A camera over a 100×100 canvas with a 60°×40° view (see rayCamera). */
function tiltedCamera({ lon, lat, height, heading, pitch }) {
  return rayCamera({
    lon,
    lat,
    altitude: height,
    heading,
    pitch,
    width: 100,
    height: 100,
    fovX: 60,
    fovY: 40,
  });
}

/**
 * Denver: 300 m above a street 1,600 m up, at a z14 tile centre, looking east
 * at ground `aheadM` metres out; the globe terrain knows the ground.
 */
function denverStreetView(aheadM) {
  const z = 14;
  const x = lonToTileX(-104.99, z);
  const y = latToTileY(39.74, z);
  const tile = tileBounds(x, y, z);
  const lon = (tile.west + tile.east) / 2;
  const lat = (tile.south + tile.north) / 2;
  const ground = 1600;
  const above = 300;
  const context = setup();
  context.viewer.scene.globe = {
    show: true,
    ellipsoid: Cesium.Ellipsoid.WGS84,
    getHeight: () => ground,
  };
  const tileWidthM = (tile.east - tile.west) * 111_320 * Math.cos(lat * RAD);
  context.viewer.camera = tiltedCamera({
    lon,
    lat,
    height: ground + above,
    heading: 90,
    pitch: -Math.atan(above / aheadM(tileWidthM)) / RAD,
  });
  context.coverage.refresh();
  const keys = context.source.calls.map((call) => call.key);
  /** Requested tiles as [dx, dy] from the tile under the camera. */
  const offsets = keys.map((k) => {
    const [, tx, ty] = k.split('/').map(Number);
    return [tx - x, ty - y];
  });
  return {
    ...context,
    keys,
    offsets,
    key: (dx, dy) => `${z}/${x + dx}/${y + dy}`,
  };
}

test('a tilted street view over ground 1,600 m up asks for the ground it looks at, nearest the camera first', () => {
  // The screen centre meets the ground at the centre of the next tile east.
  const { state, coverage, keys, offsets, key } = denverStreetView(
    (tileWidthM) => tileWidthM,
  );
  assert.equal(state.coverage.zoom, 14, 'height measured from the ground');
  assert.equal(keys[0], key(0, 0), 'the tile under the camera first');
  assert.ok(keys.includes(key(1, 0)), 'the tile the screen centre looks at');
  for (const [dx, dy] of offsets)
    assert.ok(dx >= 0 && dx <= 2 && Math.abs(dy) <= 1, `${dx},${dy} in view`);
  coverage.clear();
});

test('a street view toward the horizon asks only for the ground within range', () => {
  // The screen centre meets the ground 6 km out, past the 3 km range.
  const { coverage, keys, offsets, key } = denverStreetView(() => 6000);
  assert.equal(keys[0], key(0, 0), 'the tile under the camera first');
  for (const [dx, dy] of offsets)
    assert.ok(dx >= 0 && dx <= 1 && Math.abs(dy) <= 1, `${dx},${dy} near it`);
  coverage.clear();
});

test('a selection cleared while the old zoom is still shown uncolours its lines', async () => {
  const { viewer, source, state, coverage, bytes } = setup();
  coverage.refresh();
  source.calls[0].resolve(bytes);
  await settle();
  const [entry] = state.coverage.tiles.values();
  const line = controlled(entry.primitives[0], true);
  state.sequence.selectedId = 'seq-1';
  coverage.recolorSequence('seq-1', true);
  assert.deepEqual(Array.from(line.attributes.color), colourValue(true));
  // Zoom out: the street tile stays on screen while the new zoom loads...
  viewer.view.height = 3000;
  coverage.refresh();
  assert.equal(state.coverage.stale.size, 1, 'the old zoom is kept');
  // ...and the selection is cleared meanwhile.
  state.sequence.selectedId = null;
  coverage.recolorSequence('seq-1', false);
  assert.deepEqual(
    Array.from(line.attributes.color),
    colourValue(false),
    'the retained line is not left cyan',
  );
  coverage.clear();
});

test('a selection made while the old zoom is still building is applied once it is ready', async () => {
  const { viewer, source, state, coverage, bytes } = setup();
  coverage.refresh();
  source.calls[0].resolve(bytes);
  await settle();
  const [entry] = state.coverage.tiles.values();
  const line = controlled(entry.primitives[0], false);
  viewer.view.height = 3000;
  coverage.refresh();
  assert.equal(state.coverage.stale.size, 1);
  frame(viewer.postRender);
  state.sequence.selectedId = 'seq-1';
  coverage.recolorSequence('seq-1', true);
  line.ready = true;
  frame(viewer.postRender);
  assert.deepEqual(
    line.attributes.color && Array.from(line.attributes.color),
    colourValue(true),
    'the highlight lands on the retained line',
  );
  coverage.clear();
  assert.equal(viewer.postRender.size, 0, 'the selection watch is gone');
});

test('the old zoom goes as soon as the new zoom has loaded, not after the stale wait', async () => {
  const { viewer, source, state, coverage, bytes } = setup();
  coverage.refresh();
  source.calls[0].resolve(bytes);
  await settle();
  const [old] = viewer.scene.groundPrimitives.items;
  assert.ok(old, 'the z14 lines are drawn');
  viewer.view.height = 3000; // zoom out to z13
  coverage.refresh();
  assert.equal(state.coverage.zoom, 13);
  const fresh = source.calls.slice(1);
  assert.ok(fresh.length > 0, 'the new zoom is loading');
  assert.equal(state.coverage.stale.size, 1, 'the old zoom stays meanwhile');
  assert.ok(viewer.scene.groundPrimitives.items.has(old));
  for (const call of fresh) {
    assert.ok(
      viewer.scene.groundPrimitives.items.has(old),
      'kept while a new tile is still loading',
    );
    call.resolve(new Uint8Array());
    await settle();
  }
  // The last new tile is in: the old lines go now, long before the wait.
  assert.equal(state.coverage.pending.size, 0);
  assert.equal(state.coverage.stale.size, 0);
  assert.equal(viewer.scene.groundPrimitives.items.has(old), false);
  assert.equal(state.coverage.staleTimer, null, 'the stale wait is cancelled');
  coverage.clear();
});

test('a rate limit holds every refresh inside its wait, not only the first', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { viewer, source, coverage } = setup();
  coverage.refresh();
  source.calls[0].reject(
    Object.assign(new Error('rate limited'), { retryAfterSec: 30 }),
  );
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(1000);
  viewer.view.lon += 0.05;
  coverage.refresh();
  assert.equal(source.calls.length, 1, 'held 1 s into a 30 s wait');
  t.mock.timers.tick(28_000);
  viewer.view.lon += 0.05;
  coverage.refresh();
  assert.equal(source.calls.length, 1, 'held 29 s into a 30 s wait');
  t.mock.timers.tick(1000);
  assert.ok(source.calls.length > 1, 'asked again once the wait is over');
  coverage.clear();
  coverage.unblock();
});

test('a tile that fails before the terrain table loads is reported at once, never unhandled', async () => {
  const { source, state, coverage, tileKey } = setup();
  let terrainLoaded;
  state.coverage.terrainReady = new Promise((resolve) => {
    terrainLoaded = resolve;
  });
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    coverage.refresh();
    source.calls
      .find((call) => call.key === tileKey)
      .reject(new Error('Mapillary tiles HTTP 500'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(state.coverage.lastError, 'Mapillary tiles HTTP 500');
    assert.deepEqual(unhandled, []);
  } finally {
    terrainLoaded();
    await settle();
    process.off('unhandledRejection', onUnhandled);
  }
});
