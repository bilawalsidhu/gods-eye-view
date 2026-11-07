// src/data/earthquakes.test.mjs
// Focused tests for the pure analyst-record mapper (analyst query engine seam).
// Pure function — no viewer/DOM needed; imported directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import { createFakeGroundHarness } from '../testSupport/groundDisplayEngines.mjs';
import {
  EARTHQUAKE_OVERLAY_COHORT_LIMIT,
  EARTHQUAKE_OVERLAY_COLLISION_CAPACITY,
  createEarthquakeOverlayEntry,
  createEarthquakesLayer,
  mapAnalystRecord,
  selectEarthquakeOverlayCohort,
} from './earthquakes.js';
import { DataLayerManager } from './manager.js';
import {
  getRenderGovernorDiagnostics,
  renderGovernorFor,
} from '../renderGovernor.js';
import { loadLayerRenderers } from '../app/layers/renderers.js';

// The layers draw with the manifest's displays, which load through
// import() (src/app/layers/renderers.js).
await loadLayerRenderers('cesium');

const FULL_RAW = {
  id: 'us7000abcd',
  mag: 5.2,
  place: '42 km SW of Anchorage, Alaska',
  time: 1_753_600_000_000,
  depth: 41.7,
  lat: 61.02,
  lon: -150.41,
};

test('earthquake analyst record: full record maps every contract field', () => {
  const r = mapAnalystRecord(FULL_RAW, 3);
  assert.deepEqual(r, {
    id: 'us7000abcd',
    magnitude: 5.2,
    depthKm: 41.7,
    lat: 61.02,
    lon: -150.41,
    timeMs: 1_753_600_000_000,
    place: '42 km SW of Anchorage, Alaska',
  });
});

test('earthquake analyst record: missing USGS id falls back to index-based id', () => {
  assert.equal(mapAnalystRecord({ ...FULL_RAW, id: null }, 3).id, 'QUAKE-0003');
  assert.equal(mapAnalystRecord({ ...FULL_RAW, id: '  ' }, 41).id, 'QUAKE-0041');
  assert.equal(mapAnalystRecord(undefined).id, 'QUAKE-0000');
});

test('earthquake analyst record: missing fields become null, never NaN/undefined', () => {
  const r = mapAnalystRecord({ id: 'us1', mag: NaN, depth: undefined, place: '' }, 0);
  assert.equal(r.magnitude, null);
  assert.equal(r.depthKm, null);
  assert.equal(r.place, null);
  for (const [key, value] of Object.entries(r)) {
    assert.notEqual(value, undefined, `${key} must not be undefined`);
    if (typeof value === 'number') assert.ok(Number.isFinite(value), `${key} must not be NaN`);
  }
});

test('earthquake analyst record: output is JSON-safe (no Cesium types)', () => {
  const r = mapAnalystRecord(FULL_RAW, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});

test('earthquake overlay copy keeps source-side magnitude formatting and bounded priority', () => {
  const position = Cesium.Cartesian3.fromDegrees(-150.41, 61.02);
  const entry = createEarthquakeOverlayEntry({
    id: 'us7000abcd',
    position,
    magnitude: 5.24,
    accent: '#ff0000',
  });
  assert.equal(entry.title, 'M5.2');
  assert.equal(entry.position, position);
  assert.equal(entry.variant, 'label');
  assert.equal(entry.paintLane, 'ambient-label');
  assert.equal(entry.collisionGroup, 'ambient-label');
  assert.equal(entry.protected, undefined);
  assert.equal(entry.edgeFade, 'keyhole');
  assert.equal(entry.horizonCull, true);

  const entries = Array.from({ length: EARTHQUAKE_OVERLAY_COHORT_LIMIT + 20 }, (_, index) => ({
    id: `quake-${String(index).padStart(3, '0')}`,
    priority: index,
  }));
  const cohort = selectEarthquakeOverlayCohort(entries);
  assert.equal(cohort.length, EARTHQUAKE_OVERLAY_COHORT_LIMIT);
  assert.equal(cohort[0].id, `quake-${EARTHQUAKE_OVERLAY_COHORT_LIMIT + 19}`);
  assert.equal(cohort.at(-1).id, 'quake-020');
});

test('real earthquake lifecycle draws ground discs and publishes their labels to the host', async () => {
  const originalFetch = globalThis.fetch;
  const hostCalls = [];
  const ground = createFakeGroundHarness();
  const overlayHost = {
    setEntries: (...args) => hostCalls.push(['entries', ...args]),
    setVisible: (...args) => hostCalls.push(['visible', ...args]),
    clearSource: (...args) => hostCalls.push(['clear', ...args]),
  };
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      features: [
        {
          id: 'us-runtime-1',
          geometry: { coordinates: [-150.41, 61.02, 41.7] },
          properties: { mag: 5.24, place: 'Runtime One', time: 1_753_600_000_000 },
        },
        {
          id: 'us-runtime-2',
          geometry: { coordinates: [139.7, 35.6, 310] },
          properties: { mag: 3.01, place: 'Runtime Two', time: 1_753_600_100_000 },
        },
      ],
    }),
  });
  const layer = createEarthquakesLayer({ overlayHost });
  try {
    layer.init(null, { engine: ground.engine });
    layer.enable();
    await layer.update();

    const { items } = ground.set('earthquakes');
    assert.equal(items.length, 2, 'runtime guard requires populated ground discs');
    assert.ok(items.every((item) => Object.keys(item).every((key) =>
      ['center', 'radiusM', 'fill', 'pickId'].includes(key))), 'a disc carries no label');
    const publication = hostCalls.find(([type]) => type === 'entries');
    assert.ok(publication, 'real update path must publish the overlay source');
    assert.deepEqual(publication[2].map(({ title }) => title), ['M5.2', 'M3.0']);
    assert.deepEqual(publication[3], {
      cohortLimit: EARTHQUAKE_OVERLAY_COHORT_LIMIT,
      collisionCapacity: EARTHQUAKE_OVERLAY_COLLISION_CAPACITY,
      moving: false,
    });

    layer.disable();
    assert.equal(ground.set('earthquakes').shown, false);
    assert.deepEqual(hostCalls.slice(-2), [
      ['clear', 'earthquakes'],
      ['visible', 'earthquakes', false],
    ]);
    layer.destroy();
    assert.equal(ground.sets(), 0);
    assert.deepEqual(hostCalls.slice(-2), [
      ['clear', 'earthquakes'],
      ['visible', 'earthquakes', false],
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Perf pin: the 2026-08-20 earthquakes frame-rate cliff ────────────────────
// Every disc is ground geometry. When its axes were a per-frame callback,
// Cesium re-tessellated all 58 ground primitives on EVERY frame: 32.4
// ms/frame and 30 fps for 58 contacts, against 1.4 ms/60 fps with the layer
// off. Static radii restored 60 fps. Both halves of the fix are pinned — one
// commit per refresh with a plain radius, and the source-level guards.
test('quake disc radii are STATIC — a per-frame rebuild re-tessellates ground geometry', async () => {
  const originalFetch = globalThis.fetch;
  const ground = createFakeGroundHarness();
  const layer = createEarthquakesLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      features: [{
        id: 'us-static-1',
        geometry: { coordinates: [-122.4, 37.79, 8.2] },
        properties: { mag: 5.5, place: 'Static One', time: 1_753_600_000_000 },
      }],
    }),
  });
  try {
    layer.init(null, { engine: ground.engine });
    layer.enable();
    await layer.update();

    const set = ground.set('earthquakes');
    const [disc] = set.items;
    assert.equal(set.options.kind, 'disc', 'the disc is a ground disc');
    // Magnitude 5.5 → 2^5.5 * 1000 m, unchanged by the dropped pulse.
    assert.equal(disc.radiusM, Math.pow(2, 5.5) * 1000);
    ground.engine.fake.frames(30);
    assert.equal(
      ground.set('earthquakes').commits,
      set.commits,
      'frames must not rebuild the ground discs',
    );
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy();
    ground.destroy();
  }
});

// Dropping the continuous-render hold is only safe if new poll data still reaches
// the screen. In idle mode nothing repaints on its own, so the manager's one-shot
// request after each tick is now load-bearing for this layer. Wires the REAL layer
// into the REAL manager with the governor installed, rather than trusting the
// arrangement by inspection.
test('a quake poll still reaches the screen with the render loop idle', async () => {
  const originalFetch = globalThis.fetch;
  const renderRequests = [];
  const ground = createFakeGroundHarness();
  ground.engine.render.request = () => renderRequests.push(Date.now());
  const viewer = {
    scene: { requestRenderMode: false, requestRender: () => renderRequests.push(Date.now()) },
  };
  const layer = createEarthquakesLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      features: [{
        id: 'us-idle-1',
        geometry: { coordinates: [-122.4, 37.79, 8.2] },
        properties: { mag: 4.2, place: 'Idle One', time: 1_753_600_000_000 },
      }],
    }),
  });

  renderGovernorFor(ground.engine).install();
  // Installing the governor enters idle mode, which itself paints one settling
  // frame. Drop that from the baseline or the enable assertion below can pass on
  // the install alone, without the manager ever requesting anything.
  renderRequests.length = 0;
  const manager = new DataLayerManager(viewer, { engine: ground.engine });
  // updateInterval -1 keeps the poll loop unarmed; we drive one tick by hand.
  manager.register({ ...layer, updateInterval: -1 });
  try {
    await manager.setEnabled('earthquakes', true, { origin: 'test' });

    // The whole point of the change: enabling quakes must not pin the loop on.
    assert.equal(getRenderGovernorDiagnostics(ground.engine).mode, 'idle', 'quakes must not force continuous render');
    assert.deepEqual(getRenderGovernorDiagnostics(ground.engine).holds, []);
    assert.equal(ground.engine.render.isContinuous(), false, 'the governor really is in idle mode');

    // ...and the poll that populated the discs must still have asked for a frame,
    // because in idle mode nothing repaints on its own.
    assert.ok(ground.set('earthquakes').items.length > 0, 'the enable poll produced discs');
    assert.ok(renderRequests.length > 0, 'enabling the layer must request a render in idle mode');
    // Named, not merely counted: the frame has to come from the manager's
    // visibility request, not from some incidental repaint.
    assert.ok(
      getRenderGovernorDiagnostics(ground.engine).recentRequests.some(({ reason }) => reason === 'layer-visibility'),
      'the enable frame must be the manager\'s layer-visibility request',
    );

    // A LATER poll must request its own frame too — the enable-time
    // 'layer-visibility' request cannot cover refreshes that arrive minutes later.
    const beforeRefresh = renderRequests.length;
    await manager._runPeriodicUpdate('earthquakes', manager.layers.get('earthquakes'));
    assert.ok(
      renderRequests.length > beforeRefresh,
      'each refresh tick must request its own render while the loop is idle',
    );
    const reasons = getRenderGovernorDiagnostics(ground.engine).recentRequests.map(({ reason }) => reason);
    assert.ok(
      reasons.includes('layer-tick:earthquakes'),
      `the tick request must be attributed to the layer, got ${JSON.stringify(reasons)}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await manager.setEnabled('earthquakes', false, { origin: 'test' }).catch(() => {});
    ground.destroy();
  }
});

test('the earthquakes layer installs no per-frame callback and no continuous-render hold', () => {
  const source = ['index', 'model', 'source', 'render/display'].map(name =>
    readFileSync(new URL(`../layers/earthquakes/${name}.js`, import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(
    source,
    /new Cesium\.CallbackProperty/,
    'reverting the discs to a per-frame axis callback must fail this pin',
  );
  assert.doesNotMatch(
    source,
    /holdContinuousRender/,
    'static discs have no per-frame animator, so the layer must not pin the render loop on',
  );
});

test('earthquake refresh reports failure and clears it only after a successful response', async () => {
  const originalFetch = globalThis.fetch;
  const ground = createFakeGroundHarness();
  const layer = createEarthquakesLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  try {
    layer.init(null, { engine: ground.engine });
    layer.enable();
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    assert.equal(await layer.update(), false);
    assert.equal(layer.getStats().error, 'USGS HTTP 503');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ features: [] }),
    });
    assert.equal(await layer.update(), true);
    assert.equal(layer.getStats().error, null);
    assert.ok(Number.isFinite(layer.getStats().lastUpdate));
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy();
    ground.destroy();
  }
});

test('malformed earthquake refresh preserves discs, overlays, count and timestamp', async () => {
  const originalFetch = globalThis.fetch;
  const ground = createFakeGroundHarness();
  const discs = () => ground.set('earthquakes').items;
  const publications = [];
  const layer = createEarthquakesLayer({ overlayHost: {
    setEntries(...args) { publications.push(args); }, setVisible() {}, clearSource() {},
  } });
  const good = { id: 'good', geometry: { type: 'Point', coordinates: [10, 20, 5] },
    properties: { mag: 4, time: 100, place: 'Fixture' } };
  const respond = (features) => { globalThis.fetch = async () => ({ ok: true, json: async () => ({ features }) }); };
  try {
    layer.init(null, { engine: ground.engine });
    layer.enable();
    respond([good]);
    assert.equal(await layer.update(), true);
    const drawn = discs();
    const stats = layer.getStats();
    for (const properties of ['invalid', 123, [], true]) {
      const bad = { ...good, id: 'bad-properties', properties };
      for (const features of [[bad], [good, bad]]) {
        respond(features);
        assert.equal(await layer.update(), false);
        assert.equal(discs(), drawn);
        assert.equal(layer.getStats().count, stats.count);
        assert.equal(layer.getStats().lastUpdate, stats.lastUpdate);
        assert.equal(layer.getStats().error, 'Malformed USGS response');
        assert.equal(publications.length, 1);
      }
    }
    for (const bad of [null, { ...good, geometry: null },
      { ...good, geometry: { type: 'LineString', coordinates: [1, 2] } },
      { ...good, geometry: { coordinates: [181, 20] } },
      { ...good, geometry: { coordinates: [10, -91] } },
      { ...good, geometry: { coordinates: [null, 20] } },
      { ...good, properties: { mag: '4' } },
      { ...good, properties: { mag: Infinity } }, good]) {
      respond([good, bad]);
      assert.equal(await layer.update(), false);
      assert.equal(discs(), drawn);
      assert.equal(layer.getStats().count, stats.count);
      assert.equal(layer.getStats().lastUpdate, stats.lastUpdate);
      assert.equal(layer.getStats().error, 'Malformed USGS response');
      assert.equal(publications.length, 1);
    }
    respond([{ ...good, properties: { mag: null } }]);
    assert.equal(await layer.update(), true);
    assert.equal(discs().length, 0);
    assert.equal(layer.getStats().error, null);
    assert.equal(publications.at(-1)[1].length, 0);
    respond([good]);
    assert.equal(await layer.update(), true);
    assert.equal(discs().length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy();
    ground.destroy();
  }
});
