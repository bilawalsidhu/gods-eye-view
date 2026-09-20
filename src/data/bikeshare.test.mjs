import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  BIKESHARE_SELECTED_OVERLAY_SOURCE_OPTIONS,
  _clearBikeshareSelectionForTest,
  _getBikeshareClickHandlerForTest,
  _selectBikeshareStationForTest,
  _setBikeshareSelectionStateForTest,
  createBikeshareSelectedOverlayEntry,
} from './bikeshare.js';

function makeRecord() {
  return {
    stationId: '3790',
    stationName: 'Congress & 6th',
    bikesAvailable: 7,
    docksAvailable: 4,
    capacity: 11,
    isInstalled: true,
    isRenting: false,
    isReturning: true,
    point: {
      position: Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 2),
      show: true,
    },
  };
}

test('selected bikeshare entry preserves source copy and protected-lane policy', () => {
  const record = makeRecord();
  const entry = createBikeshareSelectedOverlayEntry('austin-capmetro:3790', record);
  assert.equal(entry.position, record.point.position);
  assert.equal(entry.title, 'Congress & 6th');
  assert.deepEqual(entry.details, [
    '🚲 7 avail · 4 docks · 11 cap',
    '⚠️ Not renting',
  ]);
  assert.equal(entry.variant, 'selected');
  assert.equal(entry.selected, true);
  assert.equal(entry.protected, true);
  assert.equal(entry.paintLane, 'selected');
  assert.equal(entry.collisionGroup, 'ambient-card');
  assert.equal(entry.edgeFade, 'keyhole');
  assert.equal(entry.horizonCull, true);
});

test('real station select/clear path publishes one card and creates no native label graphic', () => {
  const calls = [];
  const overlayHost = {
    setEntries: (...args) => calls.push(['entries', ...args]),
    setVisible: (...args) => calls.push(['visible', ...args]),
    clearSource: (...args) => calls.push(['clear', ...args]),
  };
  const key = 'austin-capmetro:3790';
  const record = makeRecord();
  const viewer = { entities: new Cesium.EntityCollection() };
  _setBikeshareSelectionStateForTest({ viewer, key, record, overlayHost });
  try {
    _selectBikeshareStationForTest(key);
    assert.equal(record.point.show, false);
    assert.equal(viewer.entities.values.length, 1, 'runtime guard requires a real selected entity');
    assert.equal(viewer.entities.values[0].label, undefined);
    assert.ok(viewer.entities.values[0].point, 'selected point highlight remains native');

    const publication = calls.find(([type]) => type === 'entries');
    assert.ok(publication);
    assert.equal(publication[1], 'bikeshare-selected');
    assert.equal(publication[2].length, 1);
    assert.equal(publication[2][0].position, record.point.position);
    assert.deepEqual(publication[3], BIKESHARE_SELECTED_OVERLAY_SOURCE_OPTIONS);

    _clearBikeshareSelectionForTest();
    assert.equal(record.point.show, true);
    assert.equal(viewer.entities.values.length, 0);
    assert.deepEqual(calls.at(-1), ['clear', 'bikeshare-selected']);
  } finally {
    _clearBikeshareSelectionForTest();
  }
});

// ── runtime lifecycle suite ─────────────────────────────────────────────────
// Drives the real layer object (init → enable → proximity → points → status →
// disable/destroy) against a fake viewer, real Cesium primitives, a stubbed
// fetch speaking GBFS, and a patched ScreenSpaceEventHandler + document global.

import bikeshareLayer from './bikeshare.js';

const AUSTIN_INFO = {
  data: {
    stations: [
      { station_id: '3790', name: 'Congress & 6th', lat: 30.2672, lon: -97.7431, capacity: 11, is_installed: 1, is_renting: 1, is_returning: 0 },
      { station_id: '3801', name: 'A very long station name that exceeds the HUD truncation length', lat: 30.27, lon: -97.74, capacity: 20 },
      // null coords → skipped by the parser (nullish coalescing → NaN).
      { station_id: 'bad', name: 'no coords', lat: null, lon: null },
      // Alternate GBFS field shape (id / latitude / longitude, null capacity).
      { id: 'alt-1', name: 'Alt shape', latitude: 30.275, longitude: -97.735, capacity: null },
      { station_id: 'off-1', name: 'Offline Plaza', lat: 30.269, lon: -97.742, capacity: 12 },
    ],
  },
};

const AUSTIN_STATUS = {
  data: {
    stations: [
      { station_id: '3790', num_bikes_available: 9, num_docks_available: 2 },           // 9/11 → green
      { station_id: '3801', num_bikes_available: 2, num_docks_available: 18 },          // 2/20 → red
      { station_id: 'off-1', num_bikes_available: 5, num_docks_available: 7, is_installed: 0 }, // offline → muted
    ],
  },
};

const FLIPPED_STATUS = {
  data: { stations: [{ station_id: '3790', num_bikes_available: 0, num_docks_available: 11 }] }, // → red
};

/** GBFS fetch stub with runtime-mutable payloads and holdable status/info gates. */
function makeGbfsStub() {
  const saved = globalThis.fetch;
  const calls = [];
  const state = {
    infoPayload: AUSTIN_INFO, statusPayload: AUSTIN_STATUS,
    infoStatus: 200, statusStatus: 200, hold: null, infoHold: null,
  };
  globalThis.fetch = async (url) => {
    const decoded = decodeURIComponent(String(url));
    calls.push(decoded);
    if (decoded.includes('station_information.json')) {
      if (state.infoStatus !== 200) return new Response('nope', { status: state.infoStatus });
      if (state.infoHold) return new Promise((resolve) => state.infoHold.resolvers.push(resolve));
      return new Response(JSON.stringify(state.infoPayload), { status: 200 });
    }
    if (decoded.includes('station_status.json')) {
      if (state.infoStatus !== 200 || state.statusStatus !== 200) {
        return new Response('nope', { status: state.statusStatus !== 200 ? state.statusStatus : 500 });
      }
      if (state.hold) return new Promise((resolve) => state.hold.resolvers.push(resolve));
      return new Response(JSON.stringify(state.statusPayload), { status: 200 });
    }
    throw new Error(`unexpected GBFS fetch: ${decoded}`);
  };
  const releaseHoldOn = (key, payload) => {
    const resolvers = state[key] ? state[key].resolvers.splice(0) : [];
    state[key] = null;
    for (const resolve of resolvers) resolve(new Response(JSON.stringify(payload), { status: 200 }));
  };
  return {
    calls,
    state,
    restore: () => { globalThis.fetch = saved; },
    releaseHold: (payload) => releaseHoldOn('hold', payload),
    releaseInfoHold: (payload) => releaseHoldOn('infoHold', payload),
  };
}

/** Fake viewer: real cartographics, captured primitives, evented camera. */
function makeViewer({ lat = 30.27, lon = -97.74, height = 10_000 } = {}) {
  const addedPrimitives = [];
  const removedPrimitives = [];
  const cameraListeners = { changed: new Set() };
  const canvas = {
    // Keep the real ScreenSpaceEventHandler off the (stubbed) document.
    disableRootEvents: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const viewer = {
    entities: new Cesium.EntityCollection(),
    scene: {
      canvas,
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
      sampleHeightSupported: false,
      pick: () => null,
      primitives: {
        add: (p) => addedPrimitives.push(p),
        remove: (p) => removedPrimitives.push(p),
        contains: () => true,
        raiseToTop: () => {},
      },
    },
    camera: {
      positionCartographic: new Cesium.Cartographic(Cesium.Math.toRadians(lon), Cesium.Math.toRadians(lat), height),
      percentageChanged: 0.5,
      changed: {
        addEventListener: (fn) => cameraListeners.changed.add(fn),
        removeEventListener: (fn) => cameraListeners.changed.delete(fn),
      },
    },
    cameraListeners,
    addedPrimitives,
    removedPrimitives,
  };
  viewer.setCamera = (next) => {
    viewer.camera.positionCartographic = new Cesium.Cartographic(
      Cesium.Math.toRadians(next.lon ?? lon), Cesium.Math.toRadians(next.lat ?? lat), next.height ?? height,
    );
  };
  return viewer;
}

/** Stub the document global (keydown capture + the handler's feature probes);
 * the REAL Cesium ScreenSpaceEventHandler runs against the fake canvas, and
 * tests read actions back through its public getInputAction(). */
async function withBrowserEnvironment(t, run) {
  const savedDocument = globalThis.document;
  const documentListeners = new Map();
  globalThis.document = {
    onmousewheel: undefined,
    addEventListener: (type, fn) => documentListeners.set(type, fn),
    removeEventListener: (type, fn) => { if (documentListeners.get(type) === fn) documentListeners.delete(type); },
  };
  try {
    await run({ documentListeners });
  } finally {
    globalThis.document = savedDocument;
  }
}

/** The layer installs exactly one click handler per init lifecycle. */
const clickActionOf = () => _getBikeshareClickHandlerForTest()
  ?.getInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK);

/** Drain the fire-and-forget activation chain (real macrotask turns). */
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function captureConsole(t) {
  const lines = { warn: [] };
  const saved = { log: console.log, warn: console.warn };
  console.log = () => {};
  console.warn = (...args) => lines.warn.push(args.join(' '));
  t.after(() => { console.log = saved.log; console.warn = saved.warn; });
  return lines;
}

const pointByKey = (collection) => {
  const map = new Map();
  for (let i = 0; i < collection.length; i += 1) {
    const point = collection.get(i);
    map.set(point.id, point);
  }
  return map;
};

const RGB = (c) => [c.red, c.green, c.blue, c.alpha];
const closeTo = (actual, expected) => Math.abs(actual - expected) < 0.005;

test('init installs one hidden collection + click handler; destroy releases it', async (t) => {
  captureConsole(t);
  await withBrowserEnvironment(t, async ({ documentListeners }) => {
    const stub = makeGbfsStub();
    try {
      const viewer = makeViewer();
      bikeshareLayer.init(viewer);
      const installed = _getBikeshareClickHandlerForTest();
      assert.equal(viewer.addedPrimitives.length, 1, 'point collection created');
      assert.equal(viewer.addedPrimitives[0].show, false, 'collection starts hidden');
      assert.equal(documentListeners.has('keydown'), true, 'escape listener installed');
      assert.ok(installed, 'click handler installed');
      assert.deepEqual(bikeshareLayer.getStats(), { count: 0, lastUpdate: null, loading: false });

      bikeshareLayer.destroy(viewer);
      assert.equal(viewer.removedPrimitives.length, 1, 'point collection released');
      assert.equal(documentListeners.has('keydown'), false, 'escape listener removed');
      assert.ok(installed.isDestroyed(), 'click handler destroyed');
      assert.equal(bikeshareLayer.getStats().count, 0);
    } finally {
      stub.restore();
    }
  });
});

test('enable activates the in-range city, renders points, and colors them from status', async (t) => {
  captureConsole(t);
  await withBrowserEnvironment(t, async () => {
    const stub = makeGbfsStub();
    try {
      const viewer = makeViewer();
      bikeshareLayer.init(viewer);
      bikeshareLayer.enable(viewer);
      await settle();

      const stats = bikeshareLayer.getStats();
      assert.equal(stats.count, 4, 'three parseable stations + the offline one rendered');
      assert.equal(stats.loading, false, 'activation completed');
      assert.equal(stats.error, undefined);
      assert.ok(Number.isFinite(stats.lastUpdate), 'status update timestamped');
      assert.equal(viewer.addedPrimitives[0].show, true, 'collection shown while enabled');

      const points = pointByKey(viewer.addedPrimitives[0]);
      assert.equal(points.size, 4);

      const green = RGB(points.get('austin-capmetro:3790').color);
      assert.ok(closeTo(green[0], 0) && closeTo(green[1], 1) && closeTo(green[2], 136 / 255), '>60% availability is green');
      assert.ok(points.get('austin-capmetro:3790').pixelSize > 4 && points.get('austin-capmetro:3790').pixelSize < 12, 'capacity scales the dot');

      const red = RGB(points.get('austin-capmetro:3801').color);
      assert.ok(closeTo(red[0], 1) && closeTo(red[1], 68 / 255), '<30% availability is red');

      const muted = RGB(points.get('austin-capmetro:off-1').color);
      assert.ok(closeTo(muted[0], 104 / 255) && closeTo(muted[3], 0.48), 'non-installed station is muted');

      const neutral = RGB(points.get('austin-capmetro:alt-1').color);
      assert.ok(closeTo(neutral[0], 145 / 255) && closeTo(neutral[3], 0.62), 'no status → neutral');

      assert.equal(stub.calls.length, 2, 'one info fetch + one status fetch via the proxy');
      assert.ok(stub.calls[0].includes('/api/gbfs/'), 'feeds fetched through the local proxy');
      assert.ok(stub.calls[0].includes('austin.publicbikesystem.net'), 'upstream URL carried encoded');

      const detected = bikeshareLayer.getDetectableObjects({ maxCount: 2, seed: 0 });
      assert.equal(detected.length, 2, 'stride subsampling honors maxCount');
      assert.equal(detected[0].id, '🚲 Congress & 6th [9/11]');
      assert.equal(detected[0].type, 'VEH');
      // Insertion order is payload order with the coord-less row skipped, so a
      // stride of 2 picks 3790 then alt-1. alt-1 exercises the DEFAULT_CAPACITY
      // fallback (no info capacity, no status to derive from → 15) and '?' bikes.
      assert.equal(detected[1].id, '🚲 Alt shape [?/15]', 'null capacity falls back to the default');

      bikeshareLayer.destroy(viewer);
    } finally {
      stub.restore();
    }
  });
});

test('the altitude gate keeps distant cameras dark until they descend', async (t) => {
  captureConsole(t);
  await withBrowserEnvironment(t, async () => {
    const stub = makeGbfsStub();
    try {
      const viewer = makeViewer({ height: 60_000 });
      bikeshareLayer.init(viewer);
      bikeshareLayer.enable(viewer);
      await settle();
      assert.equal(stub.calls.length, 0, 'camera above the exit threshold loads nothing');
      assert.equal(bikeshareLayer.getStats().count, 0);
      assert.deepEqual(bikeshareLayer.getDetectableObjects(), [], 'nothing detectable while gated');

      // Descend: the camera.changed listener schedules the debounced check.
      t.mock.timers.enable({ apis: ['setTimeout'] });
      viewer.setCamera({ height: 10_000 });
      for (const fn of viewer.cameraListeners.changed) fn();
      t.mock.timers.tick(340);
      await settle();

      assert.equal(bikeshareLayer.getStats().count, 4, 'descent activates the in-range city');
      assert.equal(stub.calls.length, 2);

      bikeshareLayer.destroy(viewer);
    } finally {
      stub.restore();
    }
  });
});

test('clicking a station publishes a protected card; empty click and Escape clear it', async (t) => {
  captureConsole(t);
  await withBrowserEnvironment(t, async ({ documentListeners }) => {
    const stub = makeGbfsStub();
    try {
      const viewer = makeViewer();
      bikeshareLayer.init(viewer);
      bikeshareLayer.enable(viewer);
      await settle();

      const clickAction = clickActionOf();
      assert.equal(typeof clickAction, 'function');
      const key = 'austin-capmetro:3790';
      const points = pointByKey(viewer.addedPrimitives[0]);

      viewer.scene.pick = () => ({ primitive: { id: key } });
      clickAction({ position: { x: 5, y: 5 } });
      assert.equal(points.get(key).show, false, 'selected base point hides');
      assert.equal(viewer.entities.values.length, 1, 'cyan highlight entity added');

      // Empty click deselects.
      viewer.scene.pick = () => undefined;
      clickAction({ position: { x: 5, y: 5 } });
      assert.equal(points.get(key).show, true, 'base point restored');
      assert.equal(viewer.entities.values.length, 0, 'highlight removed');

      // Select again, then Escape via the document keydown listener.
      viewer.scene.pick = () => ({ primitive: { id: key } });
      clickAction({ position: { x: 5, y: 5 } });
      assert.equal(viewer.entities.values.length, 1);
      const escape = documentListeners.get('keydown');
      assert.equal(typeof escape, 'function');
      escape({ key: 'Escape' });
      assert.equal(viewer.entities.values.length, 0, 'escape deselects');
      assert.equal(points.get(key).show, true);

      bikeshareLayer.destroy(viewer);
    } finally {
      stub.restore();
    }
  });
});

test('concurrent update ticks share one in-flight status fetch; a fresh poll re-colors', async (t) => {
  captureConsole(t);
  await withBrowserEnvironment(t, async () => {
    const stub = makeGbfsStub();
    try {
      const viewer = makeViewer();
      bikeshareLayer.init(viewer);
      bikeshareLayer.enable(viewer);
      await settle();
      assert.equal(stub.calls.length, 2, 'initial activation: info + status');

      stub.state.hold = { resolvers: [] };
      const first = bikeshareLayer.update();
      const second = bikeshareLayer.update();
      await settle();
      stub.releaseHold(FLIPPED_STATUS);
      await Promise.all([first, second]);
      await settle();

      const statusCalls = stub.calls.filter((c) => c.includes('station_status.json')).length;
      assert.equal(statusCalls, 2, 'initial poll + ONE shared refresh (dedupe works)');

      const points = pointByKey(viewer.addedPrimitives[0]);
      const red = RGB(points.get('austin-capmetro:3790').color);
      assert.ok(closeTo(red[0], 1) && closeTo(red[1], 68 / 255), 'a drained station flips to red');
      assert.ok(Number.isFinite(bikeshareLayer.getStats().lastUpdate));

      bikeshareLayer.destroy(viewer);
    } finally {
      stub.restore();
    }
  });
});

test('a failing station_information fetch degrades to the error stat', async (t) => {
  const lines = captureConsole(t);
  await withBrowserEnvironment(t, async () => {
    const stub = makeGbfsStub();
    try {
      stub.state.infoStatus = 503;
      const viewer = makeViewer();
      bikeshareLayer.init(viewer);
      bikeshareLayer.enable(viewer);
      await settle();

      const stats = bikeshareLayer.getStats();
      assert.equal(stats.count, 0, 'no points rendered');
      assert.equal(stats.error, 'GBFS fetch error');
      assert.ok(lines.warn.some((l) => l.includes('activate error')), 'failure surfaced');

      bikeshareLayer.destroy(viewer);
    } finally {
      stub.restore();
    }
  });
});

test('a failing status poll sets the update-error stat without dropping points', async (t) => {
  captureConsole(t);
  await withBrowserEnvironment(t, async () => {
    const stub = makeGbfsStub();
    try {
      const viewer = makeViewer();
      bikeshareLayer.init(viewer);
      bikeshareLayer.enable(viewer);
      await settle();
      assert.equal(bikeshareLayer.getStats().error, undefined);

      stub.state.statusStatus = 500;
      await bikeshareLayer.update();

      const stats = bikeshareLayer.getStats();
      assert.equal(stats.error, 'GBFS status update failed');
      assert.equal(stats.count, 4, 'rendered points survive a failed poll');

      bikeshareLayer.destroy(viewer);
    } finally {
      stub.restore();
    }
  });
});

test('disable tears listeners down, hides points and zeroes stats', async (t) => {
  captureConsole(t);
  await withBrowserEnvironment(t, async ({ documentListeners }) => {
    const stub = makeGbfsStub();
    try {
      const viewer = makeViewer();
      bikeshareLayer.init(viewer);
      const installed = _getBikeshareClickHandlerForTest();
      bikeshareLayer.enable(viewer);
      await settle();
      assert.equal(viewer.cameraListeners.changed.size, 1, 'camera listener attached while enabled');

      bikeshareLayer.disable(viewer);

      assert.equal(viewer.cameraListeners.changed.size, 0, 'camera listener removed');
      assert.equal(documentListeners.has('keydown'), false, 'escape listener removed');
      assert.ok(installed.isDestroyed(), 'click handler destroyed');
      assert.equal(viewer.addedPrimitives[0].show, false, 'collection hidden');
      assert.equal(bikeshareLayer.getStats().count, 0);
      assert.equal(bikeshareLayer.getStats().loading, false);
      assert.equal(bikeshareLayer.getDetectableObjects().length, 0, 'disabled layers detect nothing');

      // destroy() after disable takes the not-enabled branch, then releases.
      bikeshareLayer.destroy(viewer);
      assert.equal(viewer.removedPrimitives.length, 1);
    } finally {
      stub.restore();
    }
  });
});

test('destroy while enabled runs the disable path first', async (t) => {
  captureConsole(t);
  await withBrowserEnvironment(t, async () => {
    const stub = makeGbfsStub();
    try {
      const viewer = makeViewer();
      bikeshareLayer.init(viewer);
      bikeshareLayer.enable(viewer);
      await settle();

      bikeshareLayer.destroy(viewer);
      assert.equal(viewer.cameraListeners.changed.size, 0, 'disable path ran');
      assert.equal(viewer.addedPrimitives[0].show, false);
      assert.equal(viewer.removedPrimitives.length, 1, 'primitive released');
      assert.equal(bikeshareLayer.getDetectableObjects().length, 0);
    } finally {
      stub.restore();
    }
  });
});

// ── proximity / payload / selection edge behaviour ──────────────────────────
// Same harness, aimed at the uncovered decision points: which lat/lon drives
// activation, how the altitude gate hysteresis closes, what a city departure
// does to its points and selection, and how tolerant the GBFS parsers are.

/** Mocked setTimeout once per test — MockTimers refuses a second enable(). */
const enableProximityClock = (t) => t.mock.timers.enable({ apis: ['setTimeout'] });

/** Fire the debounced proximity check the way a real camera move would. */
const moveCameraAndSettle = async (t, viewer, next) => {
  viewer.setCamera(next);
  for (const fn of viewer.cameraListeners.changed) fn();
  t.mock.timers.tick(340);
  await settle();
};

test('a tilted view loads the city under the view-rectangle center, not the camera position', async (t) => {
  captureConsole(t);
  await withBrowserEnvironment(t, async () => {
    const stub = makeGbfsStub();
    try {
      // Camera parked over Tokyo (no registry city); the view box over Austin.
      const viewer = makeViewer({ lat: 35.68, lon: 139.69 });
      viewer.camera.computeViewRectangle = () => new Cesium.Rectangle(
        Cesium.Math.toRadians(-97.9),
        Cesium.Math.toRadians(30.2),
        Cesium.Math.toRadians(-97.6),
        Cesium.Math.toRadians(30.4),
      );
      bikeshareLayer.init(viewer);
      bikeshareLayer.enable(viewer);
      await settle();

      assert.equal(bikeshareLayer.getStats().count, 4, 'Austin loaded from the view box');
      assert.equal(stub.calls.length, 2, 'one info + one status fetch');
      assert.ok(stub.calls[0].includes('austin.publicbikesystem.net'), 'the in-range city was fetched');

      bikeshareLayer.destroy(viewer);
    } finally {
      stub.restore();
    }
  });
});

test('a camera with no resolvable position stops the proximity check before fetching', async (t) => {
  captureConsole(t);
  await withBrowserEnvironment(t, async () => {
    const stub = makeGbfsStub();
    try {
      const viewer = makeViewer();
      delete viewer.camera.positionCartographic;
      bikeshareLayer.init(viewer);
      bikeshareLayer.enable(viewer);
      await settle();

      assert.equal(stub.calls.length, 0, 'no feed is fetched without a look-at point');
      assert.deepEqual(bikeshareLayer.getStats(), { count: 0, lastUpdate: null, loading: false });

      bikeshareLayer.destroy(viewer);
    } finally {
      stub.restore();
    }
  });
});

test('a non-finite camera altitude keeps the gate closed', async (t) => {
  captureConsole(t);
  await withBrowserEnvironment(t, async () => {
    const stub = makeGbfsStub();
    try {
      const viewer = makeViewer({ height: Number.NaN });
      bikeshareLayer.init(viewer);
      bikeshareLayer.enable(viewer);
      await settle();

      assert.equal(stub.calls.length, 0, 'an unreadable altitude never activates the layer');
      assert.equal(bikeshareLayer.getStats().count, 0);

      bikeshareLayer.destroy(viewer);
    } finally {
      stub.restore();
    }
  });
});

test('climbing back above the exit threshold closes the gate and unloads the city', async (t) => {
  captureConsole(t);
  await withBrowserEnvironment(t, async () => {
    const stub = makeGbfsStub();
    try {
      const viewer = makeViewer({ height: 10_000 });
      bikeshareLayer.init(viewer);
      bikeshareLayer.enable(viewer);
      await settle();
      assert.equal(bikeshareLayer.getStats().count, 4, 'gate open at 10 km');

      enableProximityClock(t);
      await moveCameraAndSettle(t, viewer, { height: 60_000 });
      assert.equal(bikeshareLayer.getStats().count, 0, 'above 52 km the gate closes and unloads');
      assert.deepEqual(bikeshareLayer.getDetectableObjects(), []);

      await moveCameraAndSettle(t, viewer, { height: 10_000 });
      assert.equal(bikeshareLayer.getStats().count, 4, 'descending reopens the gate');
      const statusCalls = stub.calls.filter((c) => c.includes('station_status.json')).length;
      assert.equal(statusCalls, 2, 're-activation re-fetched status only (info was cached)');

      bikeshareLayer.destroy(viewer);
    } finally {
      stub.restore();
    }
  });
});

test('leaving a city range drops its points and clears a selection that belonged to it', async (t) => {
  captureConsole(t);
  await withBrowserEnvironment(t, async () => {
    const stub = makeGbfsStub();
    try {
      const viewer = makeViewer();
      bikeshareLayer.init(viewer);
      bikeshareLayer.enable(viewer);
      await settle();
      const key = 'austin-capmetro:3790';
      const points = pointByKey(viewer.addedPrimitives[0]);

      viewer.scene.pick = () => ({ primitive: { id: key } });
      clickActionOf()({ position: { x: 5, y: 5 } });
      assert.equal(points.get(key).show, false, 'fixture: station selected');

      enableProximityClock(t);
      await moveCameraAndSettle(t, viewer, { lat: 40, lon: -30 });

      assert.equal(bikeshareLayer.getStats().count, 0, 'out-of-range city unloaded');
      assert.equal(viewer.addedPrimitives[0].length, 0, 'its points were removed');
      assert.equal(viewer.entities.values.length, 0, 'the selection went with the city');
      assert.deepEqual(bikeshareLayer.getDetectableObjects(), []);

      bikeshareLayer.destroy(viewer);
    } finally {
      stub.restore();
    }
  });
});

test('a station entity pick selects it without a primitive id', async (t) => {
  captureConsole(t);
  await withBrowserEnvironment(t, async () => {
    const stub = makeGbfsStub();
    try {
      const viewer = makeViewer();
      bikeshareLayer.init(viewer);
      bikeshareLayer.enable(viewer);
      await settle();
      const key = 'austin-capmetro:3801';
      const points = pointByKey(viewer.addedPrimitives[0]);

      viewer.scene.pick = () => ({ id: key });
      clickActionOf()({ position: { x: 5, y: 5 } });
      assert.equal(points.get(key).show, false, 'entity-style pick result selects the station');
      assert.equal(viewer.entities.values.length, 1, 'highlight entity published');

      bikeshareLayer.destroy(viewer);
    } finally {
      stub.restore();
    }
  });
});

test('re-entering a city recolors stations from cached status while the refresh is in flight', async (t) => {
  captureConsole(t);
  await withBrowserEnvironment(t, async () => {
    const stub = makeGbfsStub();
    try {
      const viewer = makeViewer();
      bikeshareLayer.init(viewer);
      bikeshareLayer.enable(viewer);
      await settle();
      assert.ok(closeTo(RGB(pointByKey(viewer.addedPrimitives[0]).get('austin-capmetro:3790').color)[1], 1),
        '3790 starts green');

      enableProximityClock(t);
      await moveCameraAndSettle(t, viewer, { lat: 40, lon: -30 });
      assert.equal(bikeshareLayer.getStats().count, 0, 'fixture: city unloaded');

      stub.state.hold = { resolvers: [] }; // park the next status refresh
      await moveCameraAndSettle(t, viewer, { lat: 30.27, lon: -97.74 });
      const points = pointByKey(viewer.addedPrimitives[0]);
      assert.equal(points.size, 4, 'the city re-rendered');
      assert.ok(closeTo(RGB(points.get('austin-capmetro:3790').color)[1], 1),
        'cached status colored the fresh points before the refresh returned');
      const infoCalls = stub.calls.filter((c) => c.includes('station_information.json')).length;
      assert.equal(infoCalls, 1, 'station info came from the session cache');

      stub.releaseHold(FLIPPED_STATUS);
      await settle();
      assert.ok(closeTo(RGB(points.get('austin-capmetro:3790').color)[1], 68 / 255),
        'the in-flight refresh took over once it landed');

      bikeshareLayer.destroy(viewer);
    } finally {
      stub.restore();
    }
  });
});

test('station payloads are read from every documented GBFS shape and rejected when unusable', async (t) => {
  const lines = captureConsole(t);
  await withBrowserEnvironment(t, async () => {
    const stub = makeGbfsStub();
    const stations = AUSTIN_INFO.data.stations;
    try {
      const activate = async () => {
        const viewer = makeViewer();
        bikeshareLayer.init(viewer);
        try {
          bikeshareLayer.enable(viewer);
          await settle();
          return bikeshareLayer.getStats();
        } finally {
          bikeshareLayer.destroy(viewer);
        }
      };

      const cases = [
        ['station array under data', { data: stations }, 4, undefined],
        ['locale-wrapped stations', { data: { en: { stations } } }, 4, undefined],
        ['no stations at all', { data: { stations: [] } }, 0, 'GBFS fetch error'],
        ['locale wrapper without a station array', { data: { en: { ttl: 10, feeds: [] } } }, 0, 'GBFS fetch error'],
        ['non-object JSON body', null, 0, 'GBFS fetch error'],
      ];
      for (const [label, payload, expectedCount, expectedError] of cases) {
        stub.state.infoPayload = payload;
        const stats = await activate();
        assert.equal(stats.count, expectedCount, `${label}: station count`);
        assert.equal(stats.error, expectedError, `${label}: error stat`);
      }
      assert.ok(lines.warn.some((l) => l.includes('activate error')), 'failures surfaced');
    } finally {
      stub.restore();
    }
  });
});

test('GBFS flag strings coerce, and unrecognized strings fall back to operational', async (t) => {
  captureConsole(t);
  await withBrowserEnvironment(t, async () => {
    const stub = makeGbfsStub();
    try {
      stub.state.statusPayload = { data: { stations: [
        { station_id: '3790', num_bikes_available: 9, num_docks_available: 2, is_renting: 'no' },
        { station_id: '3801', num_bikes_available: 2, num_docks_available: 18, is_installed: 'maybe' },
        { station_id: 'off-1', num_bikes_available: 5, num_docks_available: 7, is_returning: 'false' },
      ] } };

      const viewer = makeViewer();
      bikeshareLayer.init(viewer);
      bikeshareLayer.enable(viewer);
      await settle();

      const points = pointByKey(viewer.addedPrimitives[0]);
      const notRenting = RGB(points.get('austin-capmetro:3790').color);
      assert.ok(closeTo(notRenting[0], 104 / 255) && closeTo(notRenting[3], 0.48),
        "is_renting: 'no' renders the station muted");
      const unknownFlag = RGB(points.get('austin-capmetro:3801').color);
      assert.ok(closeTo(unknownFlag[0], 1) && closeTo(unknownFlag[1], 68 / 255),
        "an unrecognized flag string falls back to operational → availability color");
      const notReturning = RGB(points.get('austin-capmetro:off-1').color);
      assert.ok(closeTo(notReturning[3], 0.48), "is_returning: 'false' renders muted");

      bikeshareLayer.destroy(viewer);
    } finally {
      stub.restore();
    }
  });
});

test('points clamp to sampled terrain height and fall back to the fixed offset', async (t) => {
  captureConsole(t);
  await withBrowserEnvironment(t, async () => {
    const stub = makeGbfsStub();
    try {
      const viewer = makeViewer();
      viewer.scene.sampleHeightSupported = true;
      viewer.scene.sampleHeight = (carto) => (
        Cesium.Math.toDegrees(carto.latitude) > 30.27 ? 42.5 : Number.NaN
      );
      bikeshareLayer.init(viewer);
      bikeshareLayer.enable(viewer);
      await settle();

      const points = pointByKey(viewer.addedPrimitives[0]);
      const heightOf = (point) => Cesium.Cartographic.fromCartesian(point.position).height;
      assert.ok(closeTo(heightOf(points.get('austin-capmetro:alt-1')), 44.5),
        'lat 30.275 samples 42.5 m → point lifted to 44.5 m');
      assert.ok(closeTo(heightOf(points.get('austin-capmetro:3790')), 2.0),
        'a non-finite sample keeps the 2 m offset');

      bikeshareLayer.destroy(viewer);
    } finally {
      stub.restore();
    }
  });
});

test('the global point cap stops rendering and warns once', async (t) => {
  const lines = captureConsole(t);
  await withBrowserEnvironment(t, async () => {
    const stub = makeGbfsStub();
    try {
      const stations = [];
      for (let i = 0; i < 8001; i += 1) {
        stations.push({
          station_id: `s${i}`,
          name: `Overflow station ${i}`,
          lat: 30.2 + (i % 50) * 0.001,
          lon: -97.8 + Math.floor(i / 50) * 0.001,
          capacity: 10,
        });
      }
      stub.state.infoPayload = { data: { stations } };

      const viewer = makeViewer();
      bikeshareLayer.init(viewer);
      bikeshareLayer.enable(viewer);
      await settle();

      assert.equal(bikeshareLayer.getStats().count, 8000, 'exactly MAX_TOTAL_POINTS render');
      assert.equal(viewer.addedPrimitives[0].length, 8000);
      assert.equal(lines.warn.filter((l) => l.includes('Point cap reached')).length, 1,
        'the cap warning fires once, not per station');
      assert.ok(stub.state, 'stub kept alive for readability');

      bikeshareLayer.destroy(viewer);
    } finally {
      stub.restore();
    }
  });
});

test('stats name what the layer is waiting on', async (t) => {
  captureConsole(t);
  await withBrowserEnvironment(t, async () => {
    const stub = makeGbfsStub();
    try {
      // 1. City feeds syncing: status refresh parked mid-activation.
      stub.state.hold = { resolvers: [] };
      const viewer = makeViewer();
      bikeshareLayer.init(viewer);
      bikeshareLayer.enable(viewer);
      await settle();
      assert.deepEqual(bikeshareLayer.getStats(), {
        count: 4, lastUpdate: null, loading: true, loadingLabel: 'syncing 1 city feeds...',
      });
      stub.releaseHold(FLIPPED_STATUS);
      await settle();
      bikeshareLayer.destroy(viewer);

      // 2. Nothing syncable left: the in-flight info fetch outlives its city.
      stub.state.infoHold = { resolvers: [] };
      const departing = makeViewer();
      bikeshareLayer.init(departing);
      bikeshareLayer.enable(departing);
      await settle();
      assert.equal(bikeshareLayer.getStats().loading, true, 'info fetch still in flight');

      enableProximityClock(t);
      await moveCameraAndSettle(t, departing, { lat: 40, lon: -30 });
      const stats = bikeshareLayer.getStats();
      assert.equal(stats.count, 0, 'the departing city unloaded');
      assert.equal(stats.loading, true, 'the abandoned fetch still holds the loading flag');
      assert.equal(stats.loadingLabel, 'scanning nearby systems...');

      stub.releaseInfoHold(AUSTIN_INFO);
      await settle();
      bikeshareLayer.destroy(departing);
    } finally {
      stub.restore();
    }
  });
});
