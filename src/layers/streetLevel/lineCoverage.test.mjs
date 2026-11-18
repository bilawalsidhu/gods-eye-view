import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  coverageZoom,
  createLineCoverage,
  freshCoverage,
  ZOOM_IN_HINT,
} from './lineCoverage.js';
import { resolveFilter } from './filter.js';
import { encodeCoverageTile } from './providers/mapillary/coverageFixture.mjs';
import { decodeCoverageTile } from './providers/mapillary/decode.js';
import {
  drawnLineSets,
  rayCamera,
  streetPorts,
} from '../../testSupport/streetLevelFakes.mjs';
import { fakeDrawPort } from '../../testSupport/fakeDrawPort.mjs';
import { createCesiumDraw } from '../../render/cesium/draw.js';
import { bindRenderer } from '../../render/rendererOf.js';
import {
  COLORS,
  COVERAGE_TUNING,
  KEY_REJECTED_MESSAGE,
  PICK_PREFIX,
  RATE_LIMITED_MESSAGE,
} from './providers/mapillary/policy.js';
import {
  coverageZoomForHeight,
  lonToTileX,
  latToTileY,
  tileBounds,
} from './tileMath.js';

const { maxSequences: COVERAGE_MAX_SEQUENCES, maxTiles: COVERAGE_MAX_TILES } =
  COVERAGE_TUNING;

/** Line coverage as the Mapillary provider builds it, over `source`. */
function createCoverage({ state, source, zoomFor = coverageZoomForHeight }) {
  return createLineCoverage({
    state,
    fetchTile: async (tile, { signal }) =>
      decodeCoverageTile(
        await source.getTile('coverage', tile.z, tile.x, tile.y, { signal }),
        tile,
      ),
    zoomFor,
    colors: COLORS,
    pickPrefix: PICK_PREFIX.sequence,
    renderKey: 'mapillary-coverage',
    tuning: COVERAGE_TUNING,
    messages: {
      keyRejected: KEY_REJECTED_MESSAGE,
      rateLimited: RATE_LIMITED_MESSAGE,
    },
  });
}

const RAD = Math.PI / 180;
// Node has no WebGL context to report line-width limits; a browser's
// context sets these on startup, and the renderer's lines validate against them.
Cesium.ContextLimits._minimumAliasedLineWidth = 1;
Cesium.ContextLimits._maximumAliasedLineWidth = 10;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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

/** A viewer looking straight down on a 0.004° square around `view`, drawing on a fake draw port. */
function fakeViewer(view, { draw = fakeDrawPort() } = {}) {
  const viewer = {
    view,
    draw,
    scene: {
      canvas: { clientWidth: 100, clientHeight: 100 },
      globe: { show: false, ellipsoid: Cesium.Ellipsoid.WGS84 },
    },
    camera: {
      get positionCartographic() {
        return {
          longitude: view.lon * RAD,
          latitude: view.lat * RAD,
          height: view.height,
        };
      },
      get positionWC() {
        return Cesium.Cartesian3.fromDegrees(view.lon, view.lat, view.height);
      },
      pickEllipsoid(point) {
        return Cesium.Cartesian3.fromDegrees(
          view.lon - 0.002 + (point.x / 100) * 0.004,
          view.lat + 0.002 - (point.y / 100) * 0.004,
        );
      },
    },
  };
  bindRenderer(viewer, streetPorts(viewer, { camera: true, draw }));
  return viewer;
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

function setup({ zoomFor, draw } = {}) {
  const centre = tileCentre(-121.4944, 38.5816);
  const viewer = fakeViewer(
    { lon: centre.lon, lat: centre.lat, height: 900 },
    draw ? { draw } : {},
  );
  const source = deferredSource();
  const state = {
    viewer,
    services: {},
    enabled: true,
    providerOn: true,
    filter: { pano: 'all', sinceDays: 0 },
    context: {
      getFilter: () => resolveFilter(state.filter),
      isActive: () => state.enabled && state.providerOn,
      notify() {},
    },
    coverage: {
      ...freshCoverage(),
      // The key status is in.
      blocked: null,
    },
    sequence: { selectedId: null },
  };
  const coverage = createCoverage({ state, source, zoomFor });
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
    drawnLineSets(viewer, { empty: true }).filter((set) => set.items.size)
      .length;
  return { viewer, source, state, coverage, bytes, tileKey, onGlobe, centre };
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
  const { viewer, source, coverage, bytes, centre } = setup();
  coverage.refresh();
  source.calls[0].resolve(bytes);
  await settle();
  const sets = drawnLineSets(viewer, { empty: true });
  assert.equal(sets.length, 1);
  const [line] = sets[0].items.values();
  assert.equal(
    line.id,
    `${PICK_PREFIX.sequence}seq-1`,
    'it picks its sequence',
  );
  assert.equal(line.meta.pick, `${PICK_PREFIX.sequence}seq-1`);
  assert.equal(line.mode, 'draped');
  assert.equal(line.clampTo, 'both');
  assert.equal(line.widthPx, COVERAGE_TUNING.lineWidthPx);
  assert.equal(line.style.kind, 'solid');
  assert.equal(line.style.color[3], 0.92);
  assert.equal(line.positions.length, 2);
  const start = Cesium.Cartesian3.fromDegrees(centre.lon - 0.001, centre.lat);
  // Within the tile encoding's rounding.
  assert.ok(Cesium.Cartesian3.distance(line.positions[0], start) < 1);
  coverage.clear();
  assert.equal(drawnLineSets(viewer, { empty: true }).length, 0);
});

test("a sequence's parts are drawn apart, every one picking the sequence", async () => {
  const { viewer, source, coverage, centre } = setup();
  coverage.refresh();
  const part = (dLat) => [
    [centre.lon - 0.001, centre.lat + dLat],
    [centre.lon + 0.001, centre.lat + dLat],
  ];
  source.calls[0].resolve(
    encodeCoverageTile(centre.tile, {
      sequences: [{ id: 'seq-1', parts: [part(0), part(0.0005)] }],
    }),
  );
  await settle();
  const items = [...drawnLineSets(viewer, { empty: true })[0].items.values()];
  const pick = `${PICK_PREFIX.sequence}seq-1`;
  assert.deepEqual(
    items.map(({ id, meta }) => [id, meta.pick]),
    [
      [pick, pick],
      [`${pick}#1`, pick],
    ],
  );
  coverage.clear();
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

test('a zoomFor in the older {zoom, kind} shape still draws its lines', async () => {
  // Providers written before the core went slim (#1139's Vegbilder) answer
  // an object: it must not ask for no tiles and say nothing.
  const { source, coverage, bytes, onGlobe } = setup({
    zoomFor: (height) => {
      const zoom = coverageZoomForHeight(height);
      return zoom == null ? null : { zoom, kind: 'sequence' };
    },
  });
  coverage.refresh();
  assert.equal(source.calls.length, 1, 'the tile is asked for');
  assert.equal(source.calls[0].z, 14);
  source.calls[0].resolve(bytes);
  await settle();
  assert.equal(onGlobe(), 1, 'its line drawn');
  assert.equal(coverage.stats().hint, '');
  coverage.clear();
});

test('a zoom level is read from either shape; an overview or a bad answer draws nothing', () => {
  assert.equal(coverageZoom(14), 14);
  assert.equal(coverageZoom({ zoom: 15, kind: 'sequence' }), 15);
  assert.equal(coverageZoom({ zoom: 12 }), 12);
  assert.equal(coverageZoom({ zoom: 5, kind: 'overview' }), null, 'orbit');
  assert.equal(coverageZoom(null), null);
  assert.equal(coverageZoom(undefined), null);
  assert.equal(coverageZoom({}), null);
  assert.equal(coverageZoom(14.5), null);
  assert.equal(coverageZoom('14'), null);
});

test('from orbit nothing is requested or drawn, and the hint says to zoom in', async () => {
  const { viewer, source, state, coverage, bytes, onGlobe } = setup();
  coverage.refresh();
  source.calls[0].resolve(bytes);
  await settle();
  assert.ok(onGlobe() > 0, 'street lines');
  viewer.view.height = 20_000_000;
  coverage.refresh();
  assert.equal(source.calls.length, 1, 'no tile is asked for');
  assert.equal(onGlobe(), 0, 'nothing drawn');
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
    assert.equal(coverage.stats().loading, true, 'waiting reads as loading');
    state.enabled = false;
    assert.equal(coverage.stats().loading, false, 'but not while off');
    state.enabled = true;
    coverage.setKeyStatus(configured);
    if (configured)
      assert.equal(source.calls.length, 1, 'coverage loads once it is known');
    else {
      assert.equal(source.calls.length, 0, 'a key-less install never asks');
      assert.equal(coverage.stats().loading, false);
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
  const { viewer, source, coverage } = setup();
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
  assert.equal(
    entry.sequences.size,
    Math.min(300, cap),
    'every 360° line is drawn',
  );
  assert.equal(coverage.stats().count, Math.min(300, cap));
  // Picking and the highlight look sequences up among the drawn lines.
  assert.ok(entry.sequences.has('pano-0'), 'drawn lines can be looked up');
  assert.equal(entry.sequences.has('flat-699'), false);
  state.filter = { pano: 'all', sinceDays: 0 };
  coverage.rebuild();
  assert.equal(entry.sequences.size, cap, 'all imagery is capped as before');
  assert.ok(entry.sequences.has('flat-699'), 'the newest flat line is drawn');
  assert.equal(entry.sequences.has('pano-299'), false, 'over the cap');
  coverage.clear();
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
  assert.equal(coverage.stats().count, 3, 'across, plus one per tile');
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

test('the selected sequence is drawn over the coverage, and goes with the selection', async () => {
  const { viewer, source, state, coverage, bytes } = setup();
  coverage.refresh();
  source.calls[0].resolve(bytes);
  await settle();
  const lines = () => drawnLineSets(viewer, { empty: true });
  assert.equal(lines().length, 1, 'the coverage');
  const [tile] = lines();
  const own = () => [...tile.items.values()][0];
  const writes = tile.writes;
  coverage.highlight('seq-1');
  assert.equal(lines().length, 2);
  const highlight = lines().at(-1);
  assert.equal(state.coverage.highlight.set.id, highlight.spec.id);
  const [line] = highlight.items.values();
  assert.equal(line.mode, 'draped');
  assert.equal(line.clampTo, 'both');
  assert.equal(line.widthPx, COVERAGE_TUNING.lineWidthPx + 1);
  assert.equal(line.style.color, COLORS.selected);
  assert.equal(line.meta.pick, `${PICK_PREFIX.sequence}seq-1`);
  // The tile hides its own line of it, whichever set draws over which.
  assert.equal(own().show, false, 'hidden under the highlight');
  assert.equal(tile.writes, writes + 1, 'one write: only its show changed');
  // Selected again: the one highlight, redrawn in place.
  coverage.highlight('seq-1');
  assert.equal(lines().at(-1), highlight, 'the same set');
  coverage.highlight('not-drawn');
  assert.equal(lines().length, 1, 'nothing to highlight off the map');
  assert.equal(own().show, true, 'the tile draws it again');
  coverage.highlight('seq-1');
  coverage.highlight(null);
  assert.equal(state.coverage.highlight, null);
  assert.equal(own().show, true);
  coverage.clear();
  assert.equal(lines().length, 0);
});

test('parts and repeated ids each keep their own line', async () => {
  const { viewer, source, coverage, centre } = setup();
  coverage.refresh();
  const part = (dLat) => [
    [centre.lon - 0.001, centre.lat + dLat],
    [centre.lon + 0.001, centre.lat + dLat],
  ];
  source.calls[0].resolve(
    encodeCoverageTile(centre.tile, {
      sequences: [
        { id: 'a', parts: [part(0), part(0.0002)] },
        // Its id is what a second part of `a` would be numbered.
        { id: 'a#1', parts: [part(0.0004)] },
      ],
    }),
  );
  await settle();
  const items = [...drawnLineSets(viewer, { empty: true })[0].items.values()];
  assert.equal(items.length, 3, 'no line drawn over another');
  assert.deepEqual(items.map(({ meta }) => meta.sequenceId).sort(), [
    'a',
    'a',
    'a#1',
  ]);
  coverage.clear();
});

test('a rebuild draws in place, with a set more or fewer as the batches need', async () => {
  const { viewer, source, state, coverage, centre } = setup();
  const line = (n) => [
    [
      [centre.lon - 0.001, centre.lat + n * 1e-6],
      [centre.lon + 0.001, centre.lat + n * 1e-6],
    ],
  ];
  const sequences = Array.from({ length: 130 }, (_, i) => ({
    id: `s-${i}`,
    parts: line(i),
    capturedAt: 1_000 + i,
    isPano: i === 0,
  }));
  coverage.refresh();
  source.calls[0].resolve(encodeCoverageTile(centre.tile, { sequences }));
  await settle();
  const sets = () => drawnLineSets(viewer, { empty: true });
  const [first] = sets();
  assert.equal(sets().length, 2, '120 parts, then 10');
  state.sequence.selectedId = 's-0';
  coverage.highlight();
  // 360° only: one line left, in the first set, redrawn in place.
  state.filter = { pano: 'pano', sinceDays: 0 };
  coverage.rebuild();
  assert.deepEqual(
    sets().map((set) => set.spec.id),
    [first.spec.id, state.coverage.highlight.set.id],
    'the second set goes; the first draws in place',
  );
  assert.equal(first.items.get(`${PICK_PREFIX.sequence}s-0`).show, false);
  // Everything again: a set more for the second batch.
  state.filter = { pano: 'all', sinceDays: 0 };
  coverage.rebuild();
  assert.equal(sets().length, 3);
  assert.equal(sets()[0], first);
  const own = sets()
    .filter((set) => set.spec.id !== state.coverage.highlight.set.id)
    .map((set) => set.items.get(`${PICK_PREFIX.sequence}s-0`))
    .filter(Boolean);
  assert.equal(own.length, 1, 'drawn once, oldest last');
  assert.equal(own[0].show, false, 'still hidden under the highlight');
  coverage.clear();
  assert.equal(sets().length, 0);
});

test('a tile that lands with the selected sequence is highlighted, its own line hidden', async () => {
  const { viewer, source, state, coverage, bytes } = setup();
  state.sequence.selectedId = 'seq-1';
  coverage.refresh();
  assert.equal(state.coverage.highlight, null, 'nothing loaded yet');
  source.calls[0].resolve(bytes);
  await settle();
  assert.ok(state.coverage.highlight, 'highlighted once its tile is in');
  const [tile, highlight] = drawnLineSets(viewer, { empty: true });
  assert.equal(highlight.spec.id, state.coverage.highlight.set.id);
  assert.equal(
    tile.items.get(`${PICK_PREFIX.sequence}seq-1`).show,
    false,
    'the tile hides its own line of it',
  );
  coverage.clear();
});

test("a zoom change drops the old zoom's lines", async () => {
  const { viewer, source, state, coverage, bytes } = setup();
  coverage.refresh();
  source.calls[0].resolve(bytes);
  await settle();
  const [old] = drawnLineSets(viewer, { empty: true });
  assert.ok(old, 'the z14 lines are drawn');
  viewer.view.height = 3000; // zoom out to z13
  coverage.refresh();
  assert.equal(state.coverage.zoom, 13);
  assert.equal(old.disposed, true);
  assert.ok(state.coverage.pending.size > 0, 'the new zoom is loading');
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

test('a tile that fails is reported at once, never unhandled', async () => {
  const { source, state, coverage, tileKey } = setup();
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
    process.off('unhandledRejection', onUnhandled);
  }
});

test('the selected sequence is drawn and highlighted even past the per-tile cap', async () => {
  const { state, source, coverage, centre } = setup();
  const line = (n) => [
    [
      [centre.lon - 0.001, centre.lat + n * 1e-6],
      [centre.lon + 0.001, centre.lat + n * 1e-6],
    ],
  ];
  const sequences = [];
  for (let i = 0; i < 700; i++)
    sequences.push({
      id: `new-${i}`,
      parts: line(i),
      capturedAt: 2_000_000_000_000 + i,
    });
  sequences.push({
    id: 'old',
    parts: line(800),
    capturedAt: 1_000_000_000_000,
  });
  state.sequence.selectedId = 'old';
  coverage.refresh();
  source.calls[0].resolve(encodeCoverageTile(centre.tile, { sequences }));
  await settle();
  const [entry] = state.coverage.tiles.values();
  assert.ok(entry.sequences.has('old'), 'the selected line is drawn');
  coverage.highlight('old');
  assert.ok(state.coverage.highlight, 'the selected line is highlighted');
  coverage.clear();
});

test('on the Cesium renderer the lines drape on terrain and tiles, and the highlight stays on top', async () => {
  const added = [];
  const scene = {
    camera: { positionWC: new Cesium.Cartesian3(2e7, 0, 0) },
    frameState: { mode: Cesium.SceneMode.SCENE3D },
    primitives: {
      add: (primitive) => (added.push(primitive), primitive),
      remove: (primitive) => {
        const at = added.indexOf(primitive);
        if (at >= 0) added.splice(at, 1);
        return at >= 0;
      },
      get length() {
        return added.length;
      },
      get: (i) => added[i],
    },
    requestRender() {},
  };
  const { port } = createCesiumDraw({
    scene,
    report: (error) => assert.fail(error),
  });
  const { source, state, coverage, bytes } = setup({ draw: port });
  state.sequence.selectedId = 'seq-1';
  coverage.refresh();
  source.calls[0].resolve(bytes);
  await settle();
  const grounds = () => added.map((host) => host.get(host.length - 1));
  const [tile, highlight] = grounds();
  assert.equal(state.coverage.lastError, null);
  assert.equal(added.length, 2, 'the tile, then the highlight over it');
  assert.ok(tile instanceof Cesium.GroundPolylinePrimitive);
  assert.equal(tile.classificationType, Cesium.ClassificationType.BOTH);
  const [instance] = tile.geometryInstances;
  assert.equal(instance.id.id, `${PICK_PREFIX.sequence}seq-1`);
  assert.equal(instance.id.meta.pick, `${PICK_PREFIX.sequence}seq-1`);
  assert.equal(
    highlight.geometryInstances[0].geometry.width,
    COVERAGE_TUNING.lineWidthPx + 1,
  );
  assert.equal(
    added.at(-1).drawSetId,
    state.coverage.highlight.set.id,
    'drawn last, on top',
  );
  coverage.clear();
  assert.equal(added.length, 0, 'nothing left in the scene');
});

test('a new selection hands the highlight over; a filter that hides it lets the tiles go back', async () => {
  const { viewer, source, state, coverage, centre } = setup();
  const line = (dLat) => [
    [
      [centre.lon - 0.001, centre.lat + dLat],
      [centre.lon + 0.001, centre.lat + dLat],
    ],
  ];
  coverage.refresh();
  source.calls[0].resolve(
    encodeCoverageTile(centre.tile, {
      sequences: [
        { id: 'a', parts: line(0), isPano: true },
        { id: 'b', parts: line(0.0005) },
      ],
    }),
  );
  await settle();
  const [tile] = drawnLineSets(viewer, { empty: true });
  // An item drawn without a `show` shows.
  const shown = (id) =>
    tile.items.get(`${PICK_PREFIX.sequence}${id}`)?.show !== false;
  coverage.highlight('a');
  assert.deepEqual([shown('a'), shown('b')], [false, true]);
  coverage.highlight('b');
  assert.deepEqual([shown('a'), shown('b')], [true, false], 'a back, b hidden');
  const highlight = drawnLineSets(viewer).at(-1);
  assert.equal(
    [...highlight.items.values()][0].meta.sequenceId,
    'b',
    'the one set now draws b',
  );
  // 360° only: b is filtered out, so nothing is highlighted or hidden.
  state.sequence.selectedId = 'b';
  state.filter = { pano: 'pano', sinceDays: 0 };
  coverage.rebuild();
  assert.equal(state.coverage.highlight, null);
  assert.equal(shown('a'), true, 'the tile draws a itself again');
  coverage.clear();
});
