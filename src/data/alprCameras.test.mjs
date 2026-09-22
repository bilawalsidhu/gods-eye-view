// src/data/alprCameras.test.mjs
// Pure helpers and actual layer lifecycle with a minimal viewer/input harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import alprCamerasLayer, { createAlprCamerasLayer } from './alprCameras.js';
import { DATA_CREDITS } from './dataCredits.js';
import {
  clearSelectedEntityContextForLayer,
  getContextStore,
  getSelectedEntityContext,
  registerEntityContext,
  selectEntityContext,
} from './contextStore.js';
import {
  MAX_RENDERED,
  QUERY_LIMIT,
  QUERY_SNAP_DEGREES,
  QUERY_REUSE_MS,
  alprRetryDelayMs,
  boxContains,
  buildOverpassQuery,
  snapAlprBox,
  destinationPointDeg,
  isAlprSurveillanceType,
  normalizeAlprNode,
} from './alprCameras.js';

test('normalizeAlprNode: maps a full OSM node to a plain record', () => {
  const record = normalizeAlprNode({
    type: 'node',
    id: 12345,
    lat: 30.2672,
    lon: -97.7431,
    tags: {
      man_made: 'surveillance',
      'surveillance:type': 'ALPR',
      operator: 'Flock Safety',
      'camera:type': 'fixed',
      'surveillance:zone': 'traffic',
      'camera:direction': '270',
      ref: 'ATX-001',
      check_date: '2026-06-01',
    },
  });
  assert.deepEqual(record, {
    id: 'alpr:12345',
    osmId: 12345,
    latitude: 30.2672,
    longitude: -97.7431,
    operator: 'Flock Safety',
    manufacturer: null,
    cameraType: 'fixed',
    zone: 'traffic',
    directionDeg: 270,
    ref: 'ATX-001',
    lastVerified: '2026-06-01',
    source: null,
  });
});

test('normalizeAlprNode: rejects non-node elements and missing coordinates', () => {
  assert.equal(normalizeAlprNode(null), null);
  assert.equal(normalizeAlprNode({ type: 'way', id: 1, tags: {} }), null);
  assert.equal(
    normalizeAlprNode({ type: 'node', id: 1, lat: NaN, lon: 1, tags: {} }),
    null,
  );
});

test('normalizeAlprNode: a present-but-blank direction tag reads as missing, not zero', () => {
  const record = normalizeAlprNode({
    type: 'node',
    id: 1,
    lat: 30,
    lon: -97,
    tags: {
      man_made: 'surveillance',
      'surveillance:type': 'ALPR',
      'camera:direction': '',
    },
  });
  assert.equal(record.directionDeg, null);
});

test('destinationPointDeg: due-north offset increases latitude, keeps longitude', () => {
  const dest = destinationPointDeg(30, -97, 0, 100);
  assert.ok(dest.latitude > 30);
  assert.ok(Math.abs(dest.longitude - -97) < 1e-6);
});

test('alprRetryDelayMs: doubles from a 30s floor to a 240s ceiling', () => {
  assert.equal(alprRetryDelayMs(0), 30000);
  assert.equal(alprRetryDelayMs(30000), 60000);
  assert.equal(alprRetryDelayMs(200000), 240000);
  assert.equal(alprRetryDelayMs(240000), 240000);
});

test('isAlprSurveillanceType: accepts semicolon multi-values and mixed case, rejects other cameras', () => {
  assert.equal(isAlprSurveillanceType('ALPR'), true);
  assert.equal(isAlprSurveillanceType('alpr'), true);
  assert.equal(isAlprSurveillanceType('camera;ALPR'), true);
  assert.equal(isAlprSurveillanceType('ALPR; camera'), true);
  assert.equal(isAlprSurveillanceType('camera'), false);
  assert.equal(isAlprSurveillanceType('ALPRX'), false);
  assert.equal(isAlprSurveillanceType(undefined), false);
});

test('normalizeAlprNode: keeps a camera;ALPR multi-value node and drops a plain camera', () => {
  const multi = normalizeAlprNode({
    type: 'node',
    id: 2,
    lat: 30,
    lon: -97,
    tags: { man_made: 'surveillance', 'surveillance:type': 'camera;ALPR' },
  });
  assert.equal(multi?.id, 'alpr:2');
  const plain = normalizeAlprNode({
    type: 'node',
    id: 3,
    lat: 30,
    lon: -97,
    tags: { man_made: 'surveillance', 'surveillance:type': 'camera' },
  });
  assert.equal(plain, null);
});

test('buildOverpassQuery: matches multi-value tags case-insensitively and asks for the full cap', () => {
  const query = buildOverpassQuery(30, -98, 31, -97);
  assert.match(
    query,
    /\["surveillance:type"~"[^"]*ALPR[^"]*",i\]/,
    'regex, case-insensitive match',
  );
  assert.doesNotMatch(
    query,
    /"surveillance:type"="ALPR"/,
    'no exact-only match',
  );
  assert.ok(query.endsWith(`out body ${QUERY_LIMIT};`));
  assert.ok(
    QUERY_LIMIT > 0 && QUERY_LIMIT <= 1500,
    'bounded query, not a global camera catalog',
  );
  assert.ok(
    MAX_RENDERED >= QUERY_LIMIT,
    'a render cap below the query cap silently hides cameras while count reports them',
  );
});

test('normalizeAlprNode: a whitespace-only direction tag reads as missing, not due north', () => {
  const record = normalizeAlprNode({
    type: 'node',
    id: 9,
    lat: 30,
    lon: -97,
    tags: {
      man_made: 'surveillance',
      'surveillance:type': 'ALPR',
      'camera:direction': '   ',
    },
  });
  assert.equal(record.directionDeg, null);
});

test('snapAlprBox: snaps outward to the query grid and clamps to valid ranges', () => {
  const snapped = snapAlprBox({
    south: 30.2671,
    west: -97.7431,
    north: 30.3012,
    east: -97.7002,
  });
  assert.deepEqual(snapped, {
    south: 30.25,
    west: -97.75,
    north: 30.35,
    east: -97.7,
  });
  assert.ok(
    snapped.south <= 30.2671 &&
      snapped.north >= 30.3012 &&
      snapped.west <= -97.7431 &&
      snapped.east >= -97.7002,
  );
  assert.equal(
    snapAlprBox({ south: 89.99, west: 179.99, north: 90, east: 180 }).north,
    90,
  );
  assert.equal(
    snapAlprBox({ south: -90, west: -180, north: -89.99, east: -179.99 }).west,
    -180,
  );
  assert.ok(
    QUERY_SNAP_DEGREES > 0 && QUERY_SNAP_DEGREES <= 0.1,
    'grid stays a fraction of a metro so reuse cannot over-fetch',
  );
});

test('boxContains: a nudged view stays inside its snapped box; a real pan leaves it', () => {
  const outer = snapAlprBox({
    south: 30.2671,
    west: -97.7431,
    north: 30.3012,
    east: -97.7002,
  });
  assert.equal(
    boxContains(outer, {
      south: 30.27,
      west: -97.74,
      north: 30.3,
      east: -97.71,
    }),
    true,
  );
  assert.equal(
    boxContains(outer, {
      south: 30.36,
      west: -97.74,
      north: 30.4,
      east: -97.71,
    }),
    false,
  );
  assert.equal(boxContains(null, outer), false);
});

const cameraNode = (id = 42, extra = {}) => ({
  type: 'node',
  id,
  lat: 30.2672,
  lon: -97.7431,
  tags: {
    man_made: 'surveillance',
    'surveillance:type': 'ALPR',
    manufacturer: 'Flock Safety',
  },
  ...extra,
});
const cameraResponse = (elements = [cameraNode()], stale = false) => ({
  ok: true,
  status: 200,
  headers: {
    get: (name) => (name === 'x-overpass-cache' && stale ? 'STALE' : null),
  },
  json: async () => ({ elements }),
});

// Real layer, Cesium entities and context store. Only the DOM, upstream fetch,
// camera rectangle and input event delivery are substituted (no GL in Node).
function cameraHarness(layer = alprCamerasLayer) {
  const originals = {
    document: globalThis.document,
    window: globalThis.window,
    fetch: globalThis.fetch,
    now: Date.now,
  };
  const events = new EventTarget();
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  globalThis.window = events;
  let now = originals.now();
  Date.now = () => now;
  let response = async () => cameraResponse();
  const requests = [];
  globalThis.fetch = (...args) => {
    requests.push(args);
    return response(...args);
  };
  let box = { south: 30.26, west: -97.75, north: 30.28, east: -97.73 };
  let source, click, picked;
  const credits = new Set();
  const viewer = {
    creditDisplay: {
      addStaticCredit: (credit) => credits.add(credit),
      removeStaticCredit: (credit) => credits.delete(credit),
    },
    camera: {
      moveEnd: new Cesium.Event(),
      computeViewRectangle: () =>
        box
          ? Cesium.Rectangle.fromDegrees(
              box.west,
              box.south,
              box.east,
              box.north,
            )
          : null,
    },
    scene: {
      canvas: { addEventListener() {}, removeEventListener() {} },
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
      postRender: new Cesium.Event(),
      pick: () => picked,
    },
    dataSources: {
      add: (value) => {
        source = value;
      },
      remove() {},
    },
  };
  const setInput = Cesium.ScreenSpaceEventHandler.prototype.setInputAction;
  Cesium.ScreenSpaceEventHandler.prototype.setInputAction = function (
    fn,
    type,
    modifier,
  ) {
    if (type === Cesium.ScreenSpaceEventType.LEFT_CLICK) click = fn;
    return setInput.call(this, fn, type, modifier);
  };
  try {
    layer.init(viewer);
  } finally {
    Cesium.ScreenSpaceEventHandler.prototype.setInputAction = setInput;
  }
  layer.enable();
  return {
    viewer,
    requests,
    credits,
    get source() {
      return source;
    },
    setFetch(fn) {
      response = fn;
    },
    setBox(value) {
      box = value;
    },
    expire() {
      now += QUERY_REUSE_MS + 1;
    },
    advance(ms) {
      now += ms;
    },
    click(id) {
      const entity = typeof id === 'string' ? source.entities.getById(id) : id;
      picked = entity ? { id: entity } : undefined;
      click({ position: new Cesium.Cartesian2() });
    },
    restore() {
      layer.destroy(viewer);
      Date.now = originals.now;
      for (const name of ['window', 'document', 'fetch']) {
        if (originals[name] === undefined) delete globalThis[name];
        else globalThis[name] = originals[name];
      }
    },
  };
}

test('OSM attribution introduces displayed data for five seconds, then stays discoverable in the overflow', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = cameraHarness();
  try {
    assert.equal(
      h.credits.size,
      0,
      'do not use up the introduction while data is still loading',
    );
    await alprCamerasLayer.update();
    assert.equal(h.credits.size, 1);
    const [credit] = h.credits;
    assert.equal(credit.showOnScreen, true);
    assert.match(credit.html, /class="gev-alpr-credit">ALPR:/);
    assert.match(
      credit.html,
      /href="https:\/\/www.openstreetmap.org\/copyright"/,
    );
    assert.match(credit.html, /© OpenStreetMap<\/a>/);
    t.mock.timers.tick(4999);
    assert.equal(h.credits.size, 1);
    t.mock.timers.tick(1);
    assert.equal(h.credits.size, 0);
    const overflow = DATA_CREDITS.find((entry) => entry.key === 'alpr-osm');
    assert.match(
      overflow.html,
      /ALPR camera locations \(automatic license plate readers\)/,
    );
    assert.match(
      overflow.html,
      /href="https:\/\/www.openstreetmap.org\/copyright"/,
    );
    assert.match(overflow.html, /ODbL 1\.0/);
    await alprCamerasLayer.update();
    assert.equal(
      h.credits.size,
      0,
      'refresh must not keep reintroducing the credit',
    );
    alprCamerasLayer.disable();
    assert.equal(h.credits.size, 0);
    alprCamerasLayer.enable();
    await alprCamerasLayer.update();
    t.mock.timers.tick(4000);
    alprCamerasLayer.enable();
    assert.equal(h.credits.size, 1);
    t.mock.timers.tick(1000);
    assert.equal(
      h.credits.size,
      0,
      'duplicate enable must not restart the timer',
    );
    alprCamerasLayer.disable();
    alprCamerasLayer.enable();
    await alprCamerasLayer.update();
    assert.equal(h.credits.size, 1);
  } finally {
    h.restore();
  }
  assert.equal(h.credits.size, 0);
  t.mock.timers.tick(5000);
  assert.equal(h.credits.size, 0, 'destroy cancels the presentation timer');
});

test('disabling midway through the introduction cancels its timer before a new enable', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = cameraHarness();
  try {
    await alprCamerasLayer.update();
    t.mock.timers.tick(3000);
    alprCamerasLayer.disable();
    assert.equal(h.credits.size, 0);
    alprCamerasLayer.enable();
    await alprCamerasLayer.update();
    t.mock.timers.tick(2000);
    assert.equal(
      h.credits.size,
      1,
      'old deadline must not hide the new presentation',
    );
    t.mock.timers.tick(3000);
    assert.equal(h.credits.size, 0);
  } finally {
    h.restore();
  }
});

test('all manufacturers share one ALPR title and color; only supplied metadata appears underneath', async () => {
  const h = cameraHarness();
  try {
    h.setFetch(async () =>
      cameraResponse([
        cameraNode(42, {
          tags: {
            'surveillance:type': 'ALPR',
            manufacturer: 'Flock Safety',
            operator: 'City Police',
            'camera:type': 'fixed',
          },
        }),
        cameraNode(43, {
          tags: {
            'surveillance:type': 'ALPR',
            manufacturer: 'Motorola Solutions',
          },
        }),
        cameraNode(44, { tags: { 'surveillance:type': 'ALPR' } }),
      ]),
    );
    await alprCamerasLayer.update();
    const entities = h.source.entities.values;
    assert.equal(alprCamerasLayer.name, 'ALPR Cameras');
    assert.deepEqual(
      entities.map((entity) => entity.gevLabelModel.title),
      ['ALPR-0042', 'ALPR-0043', 'ALPR-0044'],
    );
    assert.equal(
      new Set(entities.map((entity) => entity.billboard.image.getValue())).size,
      1,
    );
    assert.deepEqual(entities[0].gevLabelModel.details, [
      'OSM MAPPED',
      'FLOCK SAFETY · CITY POLICE · FIXED',
      'PUBLIC MAP DATA',
    ]);
    assert.deepEqual(entities[1].gevLabelModel.details, [
      'OSM MAPPED',
      'MOTOROLA SOLUTIONS',
      'PUBLIC MAP DATA',
    ]);
    assert.deepEqual(
      entities[2].gevLabelModel.details,
      ['OSM MAPPED', 'PUBLIC MAP DATA'],
      'unknown metadata is not guessed, but the source is always named',
    );
    for (const entity of entities) {
      h.click(entity.id);
      assert.equal(getSelectedEntityContext().label, 'ALPR camera');
      assert.equal(getSelectedEntityContext().layerName, 'ALPR Cameras');
    }
  } finally {
    h.restore();
  }
});

test('invalid OSM ids and out-of-range coordinates never become camera entities', () => {
  for (const id of [undefined, null, 0, -1, 1.5, '42', NaN])
    assert.equal(normalizeAlprNode(cameraNode(id, { id })), null);
  for (const coords of [
    { lat: 95 },
    { lat: -95 },
    { lon: 181 },
    { lon: -181 },
  ]) {
    assert.equal(normalizeAlprNode(cameraNode(42, coords)), null);
  }
});

test('clicking the selected camera or empty map deselects, including after refresh', async () => {
  const h = cameraHarness();
  try {
    await alprCamerasLayer.update();
    for (const next of ['alpr:42', null]) {
      h.click('alpr:42');
      assert.equal(getSelectedEntityContext()?.id, 'alpr:42');
      h.click(next);
      assert.equal(getSelectedEntityContext(), null);
      h.expire();
      await alprCamerasLayer.update();
      assert.equal(getSelectedEntityContext(), null);
      assert.equal(
        h.source.entities.getById('alpr:42').billboard.width.getValue(),
        38,
      );
    }
  } finally {
    h.restore();
  }
});

test('a refresh cannot reclaim selection from another layer or an explicit clear', async () => {
  const h = cameraHarness();
  try {
    await alprCamerasLayer.update();
    h.click('alpr:42');
    const aircraft = { id: 'flight:TEST' };
    registerEntityContext(aircraft, { id: aircraft.id, layerId: 'flights' });
    selectEntityContext(aircraft);
    h.expire();
    await alprCamerasLayer.update();
    assert.equal(getSelectedEntityContext()?.id, aircraft.id);
    h.click('alpr:42');
    clearSelectedEntityContextForLayer('alpr-cameras');
    h.expire();
    await alprCamerasLayer.update();
    assert.equal(getSelectedEntityContext(), null);
  } finally {
    h.restore();
  }
});

test('only a surviving selected camera keeps selection through a dataset refresh', async () => {
  const h = cameraHarness();
  try {
    await alprCamerasLayer.update();
    h.click('alpr:42');
    h.expire();
    await alprCamerasLayer.update();
    assert.equal(getSelectedEntityContext()?.id, 'alpr:42');
    h.setFetch(async () => cameraResponse([cameraNode(43)]));
    h.expire();
    await alprCamerasLayer.update();
    assert.equal(getSelectedEntityContext(), null);
  } finally {
    h.restore();
  }
});

test('disable removes contexts and highlight; cache reuse after re-enable does not reselect', async () => {
  const h = cameraHarness();
  try {
    await alprCamerasLayer.update();
    h.click('alpr:42');
    alprCamerasLayer.disable();
    assert.equal(getSelectedEntityContext(), null);
    assert.equal(getContextStore().entities.size, 0);
    alprCamerasLayer.enable();
    await alprCamerasLayer.update();
    assert.equal(getSelectedEntityContext(), null);
    assert.equal(
      h.source.entities.getById('alpr:42').billboard.width.getValue(),
      38,
    );
  } finally {
    h.restore();
  }
});

test('retry clears the old terminal error while the new request is loading', async () => {
  const h = cameraHarness();
  try {
    h.setFetch(async () => ({ ...cameraResponse(), ok: false, status: 429 }));
    await alprCamerasLayer.update();
    assert.equal(alprCamerasLayer.getStats().status, 'unavailable');
    let resolve;
    h.setFetch(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const pending = alprCamerasLayer.update();
    assert.equal(alprCamerasLayer.getStats().loading, true);
    assert.equal(alprCamerasLayer.getStats().error, null);
    assert.equal(alprCamerasLayer.getStats().status, 'loading');
    resolve(cameraResponse());
    await pending;
    assert.equal(alprCamerasLayer.getStats().status, 'ready');
  } finally {
    h.restore();
  }
});

test('a cancelled older request cannot overwrite a newer request with a late network error', async () => {
  const h = cameraHarness();
  try {
    let rejectOld, resolveNew;
    h.setFetch(
      () =>
        new Promise((resolve, reject) => {
          rejectOld = reject;
        }),
    );
    const old = alprCamerasLayer.update();
    h.setBox({ south: 31, west: -98, north: 31.02, east: -97.98 });
    h.setFetch(
      () =>
        new Promise((resolve) => {
          resolveNew = resolve;
        }),
    );
    const fresh = alprCamerasLayer.update();
    rejectOld(new TypeError('Network error on a cancelled request'));
    await old;
    assert.equal(alprCamerasLayer.getStats().status, 'loading');
    assert.equal(alprCamerasLayer.getStats().error, null);
    resolveNew(cameraResponse([]));
    await fresh;
    assert.equal(alprCamerasLayer.getStats().status, 'empty');
  } finally {
    h.restore();
  }
});

test('invalid or partial successful payloads are failures, not an empty all-clear', async () => {
  const h = cameraHarness();
  try {
    for (const payload of [
      {},
      { elements: null },
      { elements: [], remark: 'runtime error: Query timed out' },
    ]) {
      h.setFetch(async () => ({
        ...cameraResponse(),
        json: async () => payload,
      }));
      await alprCamerasLayer.update();
      assert.equal(alprCamerasLayer.getStats().status, 'unavailable');
    }
  } finally {
    h.restore();
  }
});

test('duplicate nodes render once with a count that agrees with the entity set', async () => {
  const h = cameraHarness();
  try {
    h.setFetch(async () => cameraResponse([cameraNode(), cameraNode()]));
    await alprCamerasLayer.update();
    assert.equal(alprCamerasLayer.getStats().status, 'ready');
    assert.equal(alprCamerasLayer.getStats().count, 1);
    assert.equal(h.source.entities.values.length, 1);
  } finally {
    h.restore();
  }
});

test('zooming out hides local markers, releases selection and makes no unbounded request', async () => {
  const h = cameraHarness();
  try {
    await alprCamerasLayer.update();
    h.click('alpr:42');
    h.setBox(null);
    await alprCamerasLayer.update();
    assert.equal(alprCamerasLayer.getStats().status, 'zoom-in');
    assert.equal(alprCamerasLayer.getStats().count, 0);
    assert.equal(getSelectedEntityContext(), null);
    assert.equal(h.source.entities.values.length, 0);
    assert.equal(h.requests.length, 1);
  } finally {
    h.restore();
  }
});

test('state, country and dateline views never request data; returning to the city reuses its cache', async () => {
  const h = cameraHarness();
  const city = { south: 30.26, west: -97.75, north: 30.28, east: -97.73 };
  const wideViews = [
    { south: 26, west: -107, north: 36, east: -93 },
    { south: 24, west: -125, north: 50, east: -66 },
    { south: 30, west: -99, north: 31, east: -95 },
    { south: -1, west: 179, north: 1, east: -179 },
  ];
  try {
    for (const box of wideViews) {
      h.setBox(box);
      await alprCamerasLayer.update();
      assert.equal(h.requests.length, 0, 'fresh wide view must not query');
      assert.equal(alprCamerasLayer.getStats().status, 'zoom-in');
      assert.equal(h.credits.size, 0, 'no data presentation has occurred');
    }
    h.setBox(city);
    await alprCamerasLayer.update();
    h.click('alpr:42');
    for (const box of wideViews) {
      h.setBox(box);
      await alprCamerasLayer.update();
      const stats = alprCamerasLayer.getStats();
      assert.equal(stats.status, 'zoom-in');
      assert.equal(stats.loading, false);
      assert.equal(stats.error, null);
      assert.equal(stats.retryAt, 0);
      assert.equal(stats.count, 0);
      assert.equal(getSelectedEntityContext(), null);
      assert.equal(h.requests.length, 1, 'zoom out must not query');
    }
    h.setBox(city);
    await alprCamerasLayer.update();
    assert.equal(alprCamerasLayer.getStats().count, 1);
    assert.equal(h.requests.length, 1, 'return uses fresh cached city data');
  } finally {
    h.restore();
  }
});

test('nearby camera moves reuse the snapped query but count and register only in-view nodes', async () => {
  const h = cameraHarness();
  try {
    h.setFetch(async () =>
      cameraResponse([cameraNode(), cameraNode(43, { lon: -97.71 })]),
    );
    await alprCamerasLayer.update();
    assert.equal(alprCamerasLayer.getStats().count, 1);
    h.setBox({ south: 30.26, west: -97.72, north: 30.28, east: -97.7 });
    await alprCamerasLayer.update();
    assert.equal(h.requests.length, 1);
    assert.deepEqual(
      h.source.entities.values.map((e) => e.id),
      ['alpr:43'],
    );
    assert.deepEqual([...getContextStore().entities.keys()], ['alpr:43']);
    h.expire();
    await alprCamerasLayer.update();
    assert.equal(h.requests.length, 2);
  } finally {
    h.restore();
  }
});

test('empty mapped coverage, stale data and a saturated response remain distinct', async () => {
  const h = cameraHarness();
  try {
    h.setFetch(async () => cameraResponse([]));
    await alprCamerasLayer.update();
    assert.equal(alprCamerasLayer.getStats().status, 'empty');
    assert.match(
      alprCamerasLayer.getStats().loadingLabel,
      /coverage is incomplete/,
    );
    h.expire();
    h.setFetch(async () =>
      cameraResponse(
        Array.from({ length: QUERY_LIMIT }, (_, i) => cameraNode(i + 1)),
        true,
      ),
    );
    await alprCamerasLayer.update();
    assert.equal(alprCamerasLayer.getStats().status, 'stale');
    assert.equal(alprCamerasLayer.getStats().error, null);
    assert.equal(alprCamerasLayer.getStats().saturated, true);
    assert.match(
      alprCamerasLayer.getStats().loadingLabel,
      /cached.*Coverage limited/,
    );
  } finally {
    h.restore();
  }
});

test('selected readout samples the rendered ground, not zero elevation or the direction line midpoint', async () => {
  const h = cameraHarness();
  try {
    let samples = 0;
    h.viewer.scene.sampleHeightSupported = true;
    h.viewer.scene.sampleHeight = (point, excluded) => {
      samples += 1;
      assert.equal(excluded[0].id, 'alpr:42');
      return 187;
    };
    h.setFetch(async () =>
      cameraResponse([
        cameraNode(42, {
          tags: { 'surveillance:type': 'ALPR', 'camera:direction': '90' },
        }),
      ]),
    );
    await alprCamerasLayer.update();
    h.click('alpr:42');
    const entity = h.source.entities.getById('alpr:42');
    const anchor = Cesium.Cartographic.fromCartesian(
      entity.gevDisplayPosition(),
    );
    assert.ok(Math.abs(anchor.height - 187) < 0.001);
    assert.ok(
      Math.abs(Cesium.Math.toDegrees(anchor.longitude) + 97.7431) < 1e-7,
    );
    for (let i = 0; i < 60; i++) {
      h.viewer.scene.postRender.raiseEvent();
      entity.gevDisplayPosition();
    }
    assert.equal(samples, 1, 'no per-frame raycasts');
    h.advance(1000);
    h.viewer.scene.postRender.raiseEvent();
    assert.equal(samples, 2);
    h.click(null);
    h.advance(1000);
    h.viewer.scene.postRender.raiseEvent();
    assert.equal(samples, 2, 'no terrain sampling without a selection');
  } finally {
    h.restore();
  }
});

test('a late network failure after disable cannot resurrect retries or an error state', async () => {
  const h = cameraHarness();
  try {
    let reject;
    h.setFetch(
      () =>
        new Promise((resolve, rejectRequest) => {
          reject = rejectRequest;
        }),
    );
    const pending = alprCamerasLayer.update();
    alprCamerasLayer.disable();
    reject(new TypeError('cancelled connection'));
    await pending;
    assert.equal(alprCamerasLayer.getStats().status, 'idle');
    assert.equal(alprCamerasLayer.getStats().error, null);
    assert.equal(alprCamerasLayer.getStats().retryAt, 0);
  } finally {
    h.restore();
  }
});

test('two factories keep their requests, records and destruction independent', async () => {
  const services = {
    render: { governorRequestRender() {} },
    picking: { registerPickOwner() {}, unregisterPickOwner() {} },
    groundFloor: {
      cachedGroundFloor() {
        return null;
      },
    },
    context: {
      clearSelectedEntityContextForLayer() {},
      getSelectedEntityContext() {
        return null;
      },
      registerEntityContext() {},
      removeEntityContextsForLayer() {},
      selectEntityContext() {},
    },
  };
  let resolveFirst, firstSignal;
  const first = createAlprCamerasLayer({
    services,
    source: {
      fetch: (_box, signal) => {
        firstSignal = signal;
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      },
    },
  });
  const second = createAlprCamerasLayer({
    services,
    source: {
      label: 'Test camera directory',
      attribution: { name: 'Test directory' },
      fetch: async () => ({
        records: [
          { id: 'directory:99', latitude: 30.2672, longitude: -97.7431 },
        ],
        stale: false,
        saturated: false,
      }),
    },
  });
  const a = cameraHarness(first),
    b = cameraHarness(second);
  try {
    const pending = first.update();
    await second.update();
    first.destroy();
    assert.equal(firstSignal.aborted, true);
    resolveFirst({
      records: [normalizeAlprNode(cameraNode(42))],
      stale: false,
      saturated: false,
    });
    await pending;
    assert.equal(first.getStats().count, 0);
    assert.equal(second.getStats().count, 1);
    assert.equal(b.source.entities.values[0].id, 'directory:99');
    assert.equal(second.source, 'Test camera directory');
    assert.ok(
      b.source.entities.values[0].gevLabelModel.details.includes(
        'Source: Test directory',
      ),
    );
    assert.equal(a.viewer.camera.moveEnd.numberOfListeners, 0);
    assert.equal(a.viewer.scene.postRender.numberOfListeners, 0);
  } finally {
    b.restore();
    a.restore();
  }
});

test('orbit cache hits and metadata refreshes preserve marker geometry and selection events', async () => {
  const h = cameraHarness();
  try {
    h.setFetch(async () =>
      cameraResponse([
        cameraNode(42, {
          tags: { 'surveillance:type': 'ALPR', 'camera:direction': '90' },
        }),
      ]),
    );
    await alprCamerasLayer.update();
    h.click('alpr:42');
    const entity = h.source.entities.getById('alpr:42');
    const position = entity.position,
      line = entity.polyline;
    let selections = 0,
      clears = 0,
      collectionChanges = 0;
    window.addEventListener('gev:entity-selected', () => selections++);
    window.addEventListener('gev:entity-selection-cleared', () => clears++);
    h.source.entities.collectionChanged.addEventListener(
      (_collection, added, removed) => {
        collectionChanges += added.length + removed.length;
      },
    );
    h.setBox({ south: 30.261, west: -97.749, north: 30.279, east: -97.731 });
    await alprCamerasLayer.update();
    h.expire();
    h.setFetch(async () =>
      cameraResponse([
        cameraNode(42, {
          tags: {
            'surveillance:type': 'ALPR',
            'camera:direction': '90',
            operator: 'Updated directory',
          },
        }),
      ]),
    );
    await alprCamerasLayer.update();
    assert.equal(h.source.entities.getById('alpr:42'), entity);
    assert.equal(entity.position, position);
    assert.equal(entity.polyline, line);
    assert.equal(
      getSelectedEntityContext().properties.operator,
      'Updated directory',
    );
    assert.equal(selections, 0);
    assert.equal(clears, 0);
    assert.equal(collectionChanges, 0);
    assert.equal(h.requests.length, 2, 'only expiry needs another request');
    h.expire();
    h.setFetch(async () => cameraResponse([cameraNode(42, { lon: -97.742 })]));
    await alprCamerasLayer.update();
    assert.equal(h.source.entities.getById('alpr:42'), entity);
    assert.equal(
      entity.polyline,
      undefined,
      'removed direction must not persist',
    );
    assert.ok(
      Cesium.Cartesian3.equals(
        entity.position.getValue(),
        Cesium.Cartesian3.fromDegrees(-97.742, 30.2672),
      ),
    );
  } finally {
    h.restore();
  }
});

test('moves inside a pending query do not restart it; moving to another city cancels it', async () => {
  const h = cameraHarness();
  try {
    let resolve;
    h.setFetch(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const first = alprCamerasLayer.update();
    const signal = h.requests[0][1].signal;
    h.setBox({ south: 30.261, west: -97.749, north: 30.279, east: -97.731 });
    await alprCamerasLayer.update();
    assert.equal(h.requests.length, 1);
    assert.equal(signal.aborted, false);
    assert.equal(alprCamerasLayer.getStats().loading, true);
    const finishFirst = resolve;
    h.setBox({ south: 51.49, west: -0.14, north: 51.5, east: -0.12 });
    const second = alprCamerasLayer.update();
    assert.equal(signal.aborted, true);
    assert.equal(h.requests.length, 2);
    finishFirst(cameraResponse());
    await first;
    assert.equal(
      alprCamerasLayer.getStats().loading,
      true,
      'late old response cannot finish current request',
    );
    resolve(cameraResponse([cameraNode(43, { lat: 51.495, lon: -0.13 })]));
    await second;
    assert.deepEqual(
      h.source.entities.values.map((e) => e.id),
      ['alpr:43'],
    );
  } finally {
    h.restore();
  }
});

test('ground-centered orbits ignore horizon rectangles while sky, distant and dateline views stay bounded', async () => {
  const h = cameraHarness();
  const camera = h.viewer.camera;
  const focus = Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672);
  h.viewer.scene.canvas.clientWidth = 1440;
  h.viewer.scene.canvas.clientHeight = 900;
  camera.pickEllipsoid = () => focus;
  camera.positionWC = Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 1200);
  try {
    await alprCamerasLayer.update();
    const entity = h.source.entities.getById('alpr:42');
    h.click('alpr:42');
    for (const box of [null, { south: 31, west: -99, north: 36, east: -95 }]) {
      h.setBox(box);
      await alprCamerasLayer.update();
      assert.equal(h.source.entities.getById('alpr:42'), entity);
      assert.equal(getSelectedEntityContext().id, 'alpr:42');
      assert.equal(h.requests.length, 1);
    }
    camera.positionWC = Cesium.Cartesian3.fromDegrees(
      -97.7431,
      30.2672,
      800000,
    );
    await alprCamerasLayer.update();
    assert.equal(alprCamerasLayer.getStats().status, 'zoom-in');
    assert.equal(h.source.entities.values.length, 0);
    camera.pickEllipsoid = () => undefined;
    await alprCamerasLayer.update();
    assert.equal(alprCamerasLayer.getStats().status, 'zoom-in');
    camera.pickEllipsoid = () => Cesium.Cartesian3.fromDegrees(179.999, 0);
    camera.positionWC = Cesium.Cartesian3.fromDegrees(179.999, 0, 1200);
    await alprCamerasLayer.update();
    assert.equal(alprCamerasLayer.getStats().status, 'zoom-in');
    assert.equal(h.requests.length, 1);
  } finally {
    h.restore();
  }
});

test('nearby count and discovery control frame a real loaded camera without fetching or stealing tracking', async () => {
  const h = cameraHarness();
  const flights = [];
  h.viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(
    -97.7431,
    30.2672,
    600,
  );
  h.viewer.camera.flyToBoundingSphere = (sphere, options) =>
    flights.push({ sphere, options });
  h.viewer.scene.globe.show = true;
  h.viewer.scene.globe.getHeight = () => 312;
  try {
    assert.equal(alprCamerasLayer.getRowControls().chips[0].disabled, true);
    await alprCamerasLayer.update();
    assert.equal(alprCamerasLayer.getStats().countLabel, '1 nearby');
    const controls = alprCamerasLayer.getRowControls();
    assert.equal(controls.legend[0].label, 'Camera badges');
    assert.equal(controls.chips[0].onClick(), true);
    assert.equal(flights.length, 1);
    assert.equal(getSelectedEntityContext().id, 'alpr:42');
    const center = Cesium.Cartographic.fromCartesian(flights[0].sphere.center);
    assert.ok(
      Math.abs(Cesium.Math.toDegrees(center.latitude) - 30.2672) < 1e-9,
    );
    assert.ok(
      Math.abs(center.height - 312) < 1e-6,
      'use the rendered globe floor on keyless basemaps',
    );
    assert.equal(flights[0].options.offset.range, 800);
    assert.equal(h.requests.length, 1);
    h.viewer.trackedEntity = {};
    assert.equal(alprCamerasLayer.getRowControls().chips[0].disabled, true);
    assert.equal(
      controls.chips[0].onClick(),
      false,
      'a stale button cannot steal the follow camera',
    );
    h.viewer.trackedEntity = undefined;
    alprCamerasLayer.disable();
    assert.equal(alprCamerasLayer.getStats().countLabel, '');
    assert.equal(controls.chips[0].onClick(), false);
    assert.equal(flights.length, 1);
  } finally {
    h.restore();
  }
});

test('analyst records snapshot the loaded cameras and vanish when disabled', async () => {
  const h = cameraHarness();
  try {
    h.setFetch(async () =>
      cameraResponse([
        cameraNode(42, {
          tags: {
            'surveillance:type': 'ALPR',
            manufacturer: 'Flock Safety',
            operator: 'City Police',
            'camera:type': 'fixed',
            'surveillance:zone': 'traffic',
            ref: 'CAM-9',
            direction: '135',
          },
        }),
        cameraNode(43, { tags: { 'surveillance:type': 'ALPR' } }),
      ]),
    );
    await alprCamerasLayer.update();
    const records = alprCamerasLayer.getAnalystRecords();
    assert.equal(records.length, 2);
    assert.deepEqual(records[0], {
      id: 'alpr:42',
      lat: 30.2672,
      lon: -97.7431,
      operator: 'City Police',
      manufacturer: 'Flock Safety',
      cameraType: 'fixed',
      zone: 'traffic',
      ref: 'CAM-9',
      directionDeg: 135,
    });
    assert.equal(
      alprCamerasLayer.getAnalystRecords(1).length,
      1,
      'maxCount truncates',
    );
    alprCamerasLayer.disable();
    assert.deepEqual(
      alprCamerasLayer.getAnalystRecords(),
      [],
      'a disabled layer answers with no records',
    );
  } finally {
    h.restore();
  }
});

test('FIX ON OSM follows the selected camera to its OpenStreetMap node', async () => {
  const h = cameraHarness();
  const opened = [];
  globalThis.window.open = (...args) => {
    opened.push(args);
  };
  try {
    await alprCamerasLayer.update();
    const chip = () =>
      alprCamerasLayer.getRowControls().chips.find((c) => c.id === 'edit-osm');
    assert.equal(chip().disabled, true, 'no selection, no link target');
    chip().onClick();
    assert.equal(opened.length, 0, 'a disabled chip must open nothing');
    h.click('alpr:42');
    assert.equal(chip().disabled, false);
    chip().onClick();
    assert.deepEqual(opened, [
      [
        'https://www.openstreetmap.org/node/42',
        '_blank',
        'noopener,noreferrer',
      ],
    ]);
  } finally {
    delete globalThis.window.open;
    h.restore();
  }
});

test('zone, ref and verification date appear on the card only when mapped', async () => {
  const h = cameraHarness();
  try {
    h.setFetch(async () =>
      cameraResponse([
        cameraNode(42, {
          tags: {
            'surveillance:type': 'ALPR',
            manufacturer: 'Flock Safety',
            'surveillance:zone': 'traffic',
            ref: 'CAM-9',
            check_date: '2026-05-01',
          },
        }),
        cameraNode(43, { tags: { 'surveillance:type': 'ALPR' } }),
      ]),
    );
    await alprCamerasLayer.update();
    const entities = h.source.entities.values;
    assert.deepEqual(entities[0].gevLabelModel.details, [
      'OSM MAPPED',
      'FLOCK SAFETY',
      'ZONE TRAFFIC',
      'REF CAM-9',
      'VERIFIED 2026-05-01',
      'PUBLIC MAP DATA',
    ]);
    assert.deepEqual(
      entities[1].gevLabelModel.details,
      ['OSM MAPPED', 'PUBLIC MAP DATA'],
      'absent tags stay absent instead of rendering empty rows',
    );
  } finally {
    h.restore();
  }
});

test('CORDON measures town entries end-to-end and clears on demand', async () => {
  const h = cameraHarness();
  try {
    // Square town around the harness view center (30.27, −97.74).
    const townRing = [
      { lat: 30.265, lon: -97.745 },
      { lat: 30.265, lon: -97.735 },
      { lat: 30.275, lon: -97.735 },
      { lat: 30.275, lon: -97.745 },
      { lat: 30.265, lon: -97.745 },
    ];
    const jsonResponse = (payload) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => payload,
    });
    h.setFetch(async (url, options) => {
      const body = decodeURIComponent(String(options?.body || ''));
      if (body.includes('is_in'))
        return jsonResponse({
          elements: [
            {
              type: 'area',
              id: 3600000123,
              tags: {
                boundary: 'administrative',
                admin_level: '8',
                name: 'Testville',
              },
            },
          ],
        });
      if (body.includes('pivot'))
        return jsonResponse({
          elements: [
            {
              type: 'relation',
              id: 123,
              members: [{ role: 'outer', geometry: townRing }],
            },
          ],
        });
      if (body.includes('highway'))
        return jsonResponse({
          elements: [
            {
              type: 'way',
              id: 1,
              tags: { highway: 'primary', name: 'Main Street' },
              geometry: [
                { lat: 30.27, lon: -97.75 },
                { lat: 30.27, lon: -97.74 },
              ],
            },
            {
              type: 'way',
              id: 2,
              tags: { highway: 'residential', name: 'Quiet Road' },
              geometry: [
                { lat: 30.268, lon: -97.734 },
                { lat: 30.268, lon: -97.74 },
              ],
            },
          ],
        });
      // The remaining query is the camera fetch: one reader on Main Street.
      return cameraResponse([cameraNode(42, { lat: 30.2701, lon: -97.7445 })]);
    });
    await alprCamerasLayer.update();

    const chip = () =>
      alprCamerasLayer.getRowControls().chips.find((c) => c.id === 'cordon');
    assert.equal(chip().label, 'CORDON');
    assert.equal(await chip().onClick(), true, 'the analysis lands');

    const legend = alprCamerasLayer.getRowControls().legend;
    assert.equal(legend.length, 2);
    assert.equal(legend[1].label, 'Cordon · Testville');
    assert.equal(legend[1].count, 1, 'one uncovered gate');
    assert.match(
      legend[1].blurb,
      /1 of 2 road entries pass a mapped reader \(50%\)/,
    );
    assert.match(legend[1].blurb, /majors 1\/1/);
    assert.match(legend[1].blurb, /floor, not a registry\./);

    assert.equal(chip().label, 'CLEAR CORDON');
    assert.equal(chip().onClick(), true);
    assert.equal(chip().label, 'CORDON');
    assert.equal(
      alprCamerasLayer.getRowControls().legend.length,
      1,
      'clearing removes the cordon legend',
    );
  } finally {
    h.restore();
  }
});

test('a cordon cannot outlive disable, and errors surface in the legend', async () => {
  const h = cameraHarness();
  try {
    h.setFetch(async (url, options) => {
      const body = decodeURIComponent(String(options?.body || ''));
      if (body.includes('is_in'))
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({ elements: [] }),
        };
      return cameraResponse();
    });
    await alprCamerasLayer.update();
    const chip = () =>
      alprCamerasLayer.getRowControls().chips.find((c) => c.id === 'cordon');
    assert.equal(
      await chip().onClick(),
      false,
      'no boundary is a clean failure',
    );
    const legend = alprCamerasLayer.getRowControls().legend;
    assert.equal(legend[1].label, 'Cordon');
    assert.match(legend[1].blurb, /No town boundary is mapped/);
    alprCamerasLayer.disable();
    assert.equal(
      alprCamerasLayer.getRowControls().legend.length,
      1,
      'disable clears cordon state',
    );
    assert.equal(chip().disabled, true, 'the chip needs an enabled layer');
  } finally {
    h.restore();
  }
});
