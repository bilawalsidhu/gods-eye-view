import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createFirmsHeatmapLayer, fireCullPosition } from './firmsHeatmap.js';
import { FIRE_ANCHOR_LIFT_M } from './fireAnchors.js';
import { FIRMS_AMBIENT_COHORT_LIMIT, FIRMS_OVERLAY_SOURCE_ID } from './firmsLabels.js';
import {
  _clearMeshFloorCellsForTest,
  reportMeshFloorCell,
  setMeshFloorPreferred,
} from './groundFloor.js';
import { unregisterSpriteCollection } from './spriteOrder.js';
import { isOverlayPointVisible, normalizeOverlayEntry } from '../overlays/worldOverlay.js';
import { createIconSet, ICON_CULL_LIFT } from './iconSet.js';
import { writeHoldSegment } from './iconSegment.js';

const AUSTIN = { lon: -97.7, lat: 30.2 };
/** Antipode of Austin — as far behind the limb as a point on Earth can be. */
const ANTIPODE = { lon: 82.3, lat: -30.2 };
const TOKYO = { lon: 139.7, lat: 35.7 };
/** Reported repro altitude for the through-the-globe defect. */
const REPRO_HEIGHT_M = 1_500_000;
/**
 * Longitude offset east of Austin where the horizon test DIVERGES between a
 * sub-ellipsoid anchor and a lifted one: at 1.5 Mm a point here reads hidden
 * at −22 m but visible at +5/+12 m. Measured against Cesium's own occluder.
 */
const LIMB_DLON = 41.87;
/** Farther east, where 11 m reads hidden and 12 m visible from the same camera. */
const LIFT_BAND_DLON = 41.9452;

/**
 * Whether the icon set's GPU pass draws `row` from `occluder`'s camera: the
 * shader's horizon test on the row's cull point (its CPU twin).
 */
function gpuShows(set, row, occluder) {
  const position = set.position(row, 0, new Cesium.Cartesian3());
  return set.shown(row) && occluder.isPointVisible(set.cullPoint(row, position));
}

/** A fire-shaped row (shown, CULL_LIFT) held at `position`. */
function fireRow(set, id, position) {
  const row = set.add(id, { layer: 'firms', id });
  set.setFlag(row, ICON_CULL_LIFT, true);
  set.setShown(row, true);
  writeHoldSegment(set.segments, row, position, 0);
  set.segmentWritten(row);
  return row;
}

/** Horizon occluder for a camera directly above Austin at `heightM`. */
function occluderOverAustin(heightM) {
  return new Cesium.EllipsoidalOccluder(
    Cesium.Ellipsoid.WGS84,
    Cesium.Cartesian3.fromDegrees(AUSTIN.lon, AUSTIN.lat, heightM),
  );
}

// ---------------------------------------------------------------------------
// The GPU horizon cull a fire row gets
// ---------------------------------------------------------------------------

test('icon cull: far-side fires are hidden, near-side fires stay visible', () => {
  const occluder = occluderOverAustin(REPRO_HEIGHT_M);
  const set = createIconSet();
  const at = (p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 0);
  const near = fireRow(set, 'near', at(AUSTIN));
  const nearby = fireRow(set, 'nearby', at({ lon: AUSTIN.lon + 6, lat: AUSTIN.lat + 4 }));
  const far = fireRow(set, 'far', at(ANTIPODE));
  const otherSide = fireRow(set, 'tokyo', at(TOKYO));

  assert.equal(gpuShows(set, near, occluder), true, 'the fire under the camera renders');
  assert.equal(gpuShows(set, nearby, occluder), true, 'a fire well inside the horizon renders');
  assert.equal(gpuShows(set, far, occluder), false, 'the antipodal fire must not shine through the planet');
  assert.equal(gpuShows(set, otherSide, occluder), false, 'Tokyo is beyond the limb from Austin at 1.5 Mm');
});

test('icon cull: raising the camera reveals fires the low camera hid', () => {
  const set = createIconSet();
  const paris = fireRow(set, 'paris', Cesium.Cartesian3.fromDegrees(2.35, 48.86, 0));
  assert.equal(gpuShows(set, paris, occluderOverAustin(REPRO_HEIGHT_M)), false);
  assert.equal(gpuShows(set, paris, occluderOverAustin(35_000_000)), true, 'in view from geostationary height');
});

test('icon cull: a sub-ellipsoid anchor is judged lifted, a far-side one still culls', () => {
  const occluder = occluderOverAustin(REPRO_HEIGHT_M);
  const set = createIconSet();
  const sunken = fireRow(set, 'sunken', Cesium.Cartesian3.fromDegrees(AUSTIN.lon + LIMB_DLON, AUSTIN.lat, -22));
  assert.equal(gpuShows(set, sunken, occluder), true, 'the lifted cull point keeps the near-limb fire on screen');
  set.setFlag(sunken, ICON_CULL_LIFT, false);
  assert.equal(gpuShows(set, sunken, occluder), false, 'baseline: the raw anchor false-hides at the limb');

  const far = fireRow(set, 'far', Cesium.Cartesian3.fromDegrees(ANTIPODE.lon, ANTIPODE.lat, -22));
  assert.equal(gpuShows(set, far, occluder), false, '12 m of lift must not defeat the actual horizon cull');
});

test('fireCullPosition: a card is judged where its sprite is', () => {
  const occluder = occluderOverAustin(REPRO_HEIGHT_M);
  const set = createIconSet();
  setMeshFloorPreferred(true);
  try {
    // Sunk, an 11 m anchor (floor 6 + lift), and well above: each card must
    // agree with the GPU test on its own row, at limb points where they can.
    for (const [i, floor] of [-27, 6, 900].entries()) {
      _clearMeshFloorCellsForTest(); // a reported cell latches its first floor
      for (const dLon of [LIMB_DLON, LIFT_BAND_DLON]) {
        const lat = AUSTIN.lat;
        const lon = AUSTIN.lon + dLon;
        reportMeshFloorCell(lat, lon, floor);
        const fire = { index: i, lat, lon, frp: 10, position: null };
        const cull = fireCullPosition(fire);
        assert.equal(fire.positionHeight, floor + FIRE_ANCHOR_LIFT_M);
        const row = fireRow(set, `${floor}:${dLon}`, fire.position);
        assert.equal(
          occluder.isPointVisible(cull),
          gpuShows(set, row, occluder),
          `floor ${floor} m at +${dLon}°`,
        );
      }
    }
  } finally {
    _clearMeshFloorCellsForTest();
    setMeshFloorPreferred(false);
  }
});

test('fireCullPosition: negative-geoid anchor renders at the datum but culls lifted', () => {
  const lat = 30.2;
  const lon = AUSTIN.lon + LIMB_DLON;
  setMeshFloorPreferred(true);
  reportMeshFloorCell(lat, lon, -27);
  try {
    const fire = { index: 1, lat, lon, frp: 10, position: null };
    const cull = fireCullPosition(fire);
    const render = fire.position;
    const renderCarto = Cesium.Cartographic.fromCartesian(render);
    assert.ok(
      Math.abs(renderCarto.height - (-27 + FIRE_ANCHOR_LIFT_M)) < 0.5,
      `render anchor stays datum-correct at ${-27 + FIRE_ANCHOR_LIFT_M} m, got ${renderCarto.height}`,
    );

    assert.notEqual(cull, render, 'a sub-ellipsoid anchor gets a separate cull point');
    const cullCarto = Cesium.Cartographic.fromCartesian(cull);
    assert.ok(Math.abs(cullCarto.height - 12) < 0.5, `cull point lifted to 12 m, got ${cullCarto.height}`);
    assert.equal(fireCullPosition(fire), cull, 'the lifted point is cached, not re-allocated per call');

    // The whole point: the datum-correct point would be culled here, the lifted one is not.
    const occluder = occluderOverAustin(REPRO_HEIGHT_M);
    assert.equal(occluder.isPointVisible(render), false, 'baseline defect: −22 m reads beyond the horizon');
    assert.equal(occluder.isPointVisible(cull), true, 'lifted cull point reads correctly as in view');
  } finally {
    _clearMeshFloorCellsForTest();
    setMeshFloorPreferred(false);
  }
});

test('fireCullPosition: a healthy above-ellipsoid anchor is its own cull point', () => {
  const lat = 45.5;
  const lon = -122.6;
  setMeshFloorPreferred(true);
  reportMeshFloorCell(lat, lon, 900);
  try {
    const fire = { index: 2, lat, lon, frp: 10, position: null };
    const cull = fireCullPosition(fire);
    assert.equal(cull, fire.position, 'no second Cartesian is allocated for the common case');
  } finally {
    _clearMeshFloorCellsForTest();
    setMeshFloorPreferred(false);
  }
});

// ---------------------------------------------------------------------------
// World-overlay host wiring (cards)
// ---------------------------------------------------------------------------

test('isOverlayPointVisible: horizon test prefers entry.cullPosition when present', () => {
  const viewport = { width: 800, height: 600 };
  const screen = { x: 400, y: 300 };
  const render = Cesium.Cartesian3.fromDegrees(AUSTIN.lon + LIMB_DLON, AUSTIN.lat, -22);
  const lifted = Cesium.Cartesian3.fromDegrees(AUSTIN.lon + LIMB_DLON, AUSTIN.lat, 12);
  const occluder = occluderOverAustin(REPRO_HEIGHT_M);

  assert.equal(
    isOverlayPointVisible({ horizonCull: true }, render, screen, viewport, occluder),
    false,
    'baseline: the render anchor alone false-hides the card',
  );
  assert.equal(
    isOverlayPointVisible({ horizonCull: true, cullPosition: lifted }, render, screen, viewport, occluder),
    true,
    'the supplied cull position is what the horizon test uses',
  );
  assert.equal(
    isOverlayPointVisible(
      { horizonCull: true, cullPosition: Cesium.Cartesian3.fromDegrees(ANTIPODE.lon, ANTIPODE.lat, 12) },
      render,
      screen,
      viewport,
      occluder,
    ),
    false,
    'a far-side cull position still culls',
  );
});

test('normalizeOverlayEntry: carries a valid cullPosition, nulls a junk one', () => {
  const position = { x: 1, y: 2, z: 3 };
  const kept = normalizeOverlayEntry('firms', { id: 'a', position, cullPosition: { x: 4, y: 5, z: 6 } });
  assert.ok(kept.cullPosition instanceof Cesium.Cartesian3, 'stored as a host-owned Cartesian3');
  assert.deepEqual(
    [kept.cullPosition.x, kept.cullPosition.y, kept.cullPosition.z],
    [4, 5, 6],
  );
  const dropped = normalizeOverlayEntry('firms', { id: 'b', position, cullPosition: { x: NaN, y: 5, z: 6 } });
  assert.equal(dropped.cullPosition, null, 'a malformed cull point falls back to the render position');
  const notAnObject = normalizeOverlayEntry('firms', { id: 'b2', position, cullPosition: 42 });
  assert.equal(notAnObject.cullPosition, null, 'a non-object cull point is rejected');
  // Non-adopting sources keep their existing BEHAVIOUR and steady-frame
  // allocation profile; the normalized record does gain an enumerable
  // `cullPosition: null` field, which is why this asserts null rather than
  // absence.
  const absent = normalizeOverlayEntry('firms', { id: 'c', position });
  assert.equal(absent.cullPosition, null, 'sources that do not opt in resolve to no cull anchor');
});

test('normalizeOverlayEntry: the stored cull anchor is a snapshot, not the caller object', () => {
  const position = { x: 1, y: 2, z: 3 };
  const caller = new Cesium.Cartesian3(4, 5, 6);
  const normalized = normalizeOverlayEntry('firms', { id: 'a', position, cullPosition: caller });
  assert.notEqual(normalized.cullPosition, caller, 'the host must not retain the caller reference');

  // Sources legitimately recycle scratch vectors between publishes; a mutation
  // after normalization must never reach the per-frame occluder.
  caller.x = NaN;
  caller.y = 999;
  assert.deepEqual(
    [normalized.cullPosition.x, normalized.cullPosition.y, normalized.cullPosition.z],
    [4, 5, 6],
    'post-normalize mutation of the source vector has no effect',
  );
});

test('normalizeOverlayEntry: an accessor-backed cullPosition is read exactly once', () => {
  const position = { x: 1, y: 2, z: 3 };
  let reads = 0;
  const entry = {
    id: 'a',
    position,
    get cullPosition() {
      reads += 1;
      return new Cesium.Cartesian3(4, 5, 6);
    },
  };
  const normalized = normalizeOverlayEntry('firms', entry);
  assert.equal(reads, 1, 'one property read — not one per validated component');
  assert.deepEqual(
    [normalized.cullPosition.x, normalized.cullPosition.y, normalized.cullPosition.z],
    [4, 5, 6],
  );
});

test('normalizeOverlayEntry: a throwing cullPosition accessor does not abort normalization', () => {
  const position = { x: 1, y: 2, z: 3 };
  const entry = {
    id: 'a',
    position,
    title: 'still normalized',
    get cullPosition() { throw new Error('hostile accessor'); },
  };
  const normalized = normalizeOverlayEntry('firms', entry);
  assert.equal(normalized.cullPosition, null, 'the bad anchor degrades to null');
  assert.equal(normalized.title, 'still normalized', 'the rest of the entry survives');
  assert.equal(normalized.id, 'a');
});

// ---------------------------------------------------------------------------
// Layer integration: the three production hooks
// ---------------------------------------------------------------------------

class MockEvent {
  constructor() { this.listeners = new Set(); }
  addEventListener(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit() { for (const listener of [...this.listeners]) listener(); }
}

/**
 * Canvas stub good enough for the pre-baked glow sprites. Its data URL names
 * the gradient's colours, so each colour stop gets its own atlas slot.
 */
function canvasStub() {
  const stops = [];
  return {
    width: 0,
    height: 0,
    getContext: () => ({
      createRadialGradient: () => ({ addColorStop: (offset, color) => stops.push(color) }),
      fillStyle: null,
      fillRect() {},
    }),
    toDataURL: () => `data:image/png;base64,iVBORw0KGgo=#${stops.join('|')}`,
  };
}

/** Proxy-shaped FIRMS record (firmsCsv shape) for the fetch stub. */
function rawFire(lat, lon, frp) {
  return {
    lat,
    lon,
    frp,
    confidence: 'h',
    brightness: 340,
    daynight: 'D',
    acqDate: '2026-08-03',
    acqTime: '0412',
    instrument: 'VIIRS',
    satellite: 'N20',
  };
}

/**
 * Boots the REAL layer against a headless viewer stub; what the GPU would draw
 * is read off the layer's real icon set (`gpuShows`) from the stub camera.
 */
function createHarness(rawFires) {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalProject = Cesium.SceneTransforms.worldToWindowCoordinates;

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ fires: rawFires, fetchedAt: Date.now() }),
  });
  globalThis.window = globalThis.window || {};
  globalThis.document = { createElement: () => canvasStub() };

  // Deterministic projection: every distinct world position gets its own
  // 200 px grid slot (well clear of LABEL_MIN_SEP_PX) inside a 2000×2000
  // canvas, so declutter geometry never decides these assertions.
  const slots = new Map();
  Cesium.SceneTransforms.worldToWindowCoordinates = (scene, position, result) => {
    if (!slots.has(position)) slots.set(position, slots.size);
    const slot = slots.get(position);
    const out = result || new Cesium.Cartesian2();
    out.x = 100 + (slot % 10) * 200;
    out.y = 100 + Math.floor(slot / 10) * 200;
    return out;
  };

  const preRender = new MockEvent();
  const moveEnd = new MockEvent();
  const primitives = [];
  const entryCalls = [];
  const viewer = {
    dataSources: { add: (value) => value, remove: () => {} },
    camera: {
      moveEnd,
      positionWC: Cesium.Cartesian3.fromDegrees(AUSTIN.lon, AUSTIN.lat, REPRO_HEIGHT_M),
      directionWC: new Cesium.Cartesian3(0, 0, -1),
      positionCartographic: { height: REPRO_HEIGHT_M },
    },
    scene: {
      canvas: { clientWidth: 2000, clientHeight: 2000 },
      preRender,
      primitives: {
        add: (value) => { primitives.push(value); return value; },
        remove: (value) => {
          const at = primitives.indexOf(value);
          if (at < 0) return false;
          primitives.splice(at, 1);
          value.destroy();
          return true;
        },
        contains: () => false,
      },
      frameState: { mode: Cesium.SceneMode.SCENE3D, mapProjection: new Cesium.GeographicProjection() },
      mapProjection: new Cesium.GeographicProjection(),
    },
  };

  const layer = createFirmsHeatmapLayer({
    id: 'firms',
    name: 'FIRMS',
    overlayHost: {
      setEntries: (sourceId, entries) => entryCalls.push(entries),
      setVisible: () => {},
      clearSource: () => {},
    },
    screenSpaceEventHandlerFactory: () => ({ setInputAction() {}, destroy() {} }),
  });

  return {
    layer,
    viewer,
    preRender,
    moveEnd,
    /** The icon set the layer draws its detections from. */
    icons: () => primitives[0].set,
    /** Primitives currently in the stub scene. */
    primitives,
    /** Latest entry list published to the overlay host. */
    latestEntries: () => entryCalls[entryCalls.length - 1] || [],
    /** Whether the GPU draws each row from the current camera, by pick id. */
    showById() {
      const set = primitives[0].set;
      const occluder = new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84, viewer.camera.positionWC);
      const out = new Map();
      for (let row = 0; row < set.count; row += 1)
        out.set(set.idAt(row), set.show && gpuShows(set, row, occluder));
      return out;
    },
    moveCameraTo(lon, lat, height = REPRO_HEIGHT_M) {
      viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(lon, lat, height);
      viewer.camera.positionCartographic = { height };
    },
    cleanup() {
      layer.destroy(viewer);
      unregisterSpriteCollection('firms');
      Cesium.SceneTransforms.worldToWindowCoordinates = originalProject;
      globalThis.fetch = originalFetch;
      if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
      if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    },
  };
}

test('layer: far-side detections are culled from the first frame', async () => {
  const harness = createHarness([
    rawFire(AUSTIN.lat, AUSTIN.lon, 120),
    rawFire(ANTIPODE.lat, ANTIPODE.lon, 900),
    rawFire(TOKYO.lat, TOKYO.lon, 800),
  ]);
  try {
    harness.layer.init(harness.viewer);
    await harness.layer.enable(harness.viewer);
    // No camera event has fired — only renderDetections ran.
    const show = harness.showById();
    assert.equal(show.size, 3, 'all three detections were rendered');
    assert.equal(show.get('firms-0'), true, 'the Austin fire under the camera is visible');
    assert.equal(show.get('firms-1'), false, 'the antipodal fire is culled at build time');
    assert.equal(show.get('firms-2'), false, 'the Tokyo fire is culled at build time');
  } finally {
    harness.cleanup();
  }
});

test('layer: the GPU cull follows the camera with no CPU show pass', async () => {
  const harness = createHarness([
    rawFire(AUSTIN.lat, AUSTIN.lon, 120),
    rawFire(TOKYO.lat, TOKYO.lon, 800),
  ]);
  try {
    harness.layer.init(harness.viewer);
    await harness.layer.enable(harness.viewer);
    assert.equal(harness.showById().get('firms-1'), false, 'precondition: Tokyo hidden from Austin');

    harness.moveCameraTo(TOKYO.lon, TOKYO.lat);
    harness.moveEnd.emit();

    const set = harness.icons();
    for (let row = 0; row < set.count; row += 1)
      assert.equal(set.shown(row), true, `${set.idAt(row)} keeps its row shown; the GPU decides`);
    const show = harness.showById();
    assert.equal(show.get('firms-1'), true, 'Tokyo becomes visible once the camera is over it');
    assert.equal(show.get('firms-0'), false, 'Austin drops behind the limb');
  } finally {
    harness.cleanup();
  }
});

test('layer: a refresh keeps rows and restyles one whose index now holds another fire', async () => {
  const fires = [rawFire(AUSTIN.lat, AUSTIN.lon, 400), rawFire(TOKYO.lat, TOKYO.lon, 800)];
  const harness = createHarness(fires);
  try {
    harness.layer.init(harness.viewer);
    await harness.layer.enable(harness.viewer);
    const set = harness.icons();
    const austin = set.row('firms-0');
    const handle = set.handleAt(austin);
    const before = set.width(austin);
    const beforeImage = set.imageFar(austin);

    fires[0] = rawFire(AUSTIN.lat + 0.5, AUSTIN.lon, 1);
    await harness.layer.update();

    const row = set.row('firms-0');
    assert.equal(set.handleAt(row), handle, 'the row (and its pick id) survives the rebuild');
    assert.ok(set.width(row) < before, `restyled for the weaker fire: ${set.width(row)} < ${before}`);
    assert.notEqual(set.imageFar(row), beforeImage, 'a red glow becomes a yellow one');
    const carto = Cesium.Cartographic.fromCartesian(set.position(row, 0, new Cesium.Cartesian3()));
    assert.ok(Math.abs(Cesium.Math.toDegrees(carto.latitude) - (AUSTIN.lat + 0.5)) < 1e-6, 'moved to the new fire');
  } finally {
    harness.cleanup();
  }
});

test('layer: re-enabling after the camera moved shows the icons, culled from the new camera', async () => {
  const harness = createHarness([
    rawFire(AUSTIN.lat, AUSTIN.lon, 120),
    rawFire(TOKYO.lat, TOKYO.lon, 800),
  ]);
  try {
    harness.layer.init(harness.viewer);
    await harness.layer.enable(harness.viewer);
    assert.equal(harness.showById().get('firms-1'), false, 'precondition: Tokyo hidden from Austin');

    harness.layer.disable();
    // The camera moves while the layer is OFF: moveEnd is not being listened
    // to, and the preRender watcher is inert. Nothing re-culls on its own.
    harness.moveCameraTo(TOKYO.lon, TOKYO.lat);
    await harness.layer.enable(harness.viewer);

    // Assert with NO camera event fired and NO refetch (fires are already
    // loaded, so enable() does not reload): the GPU culls from the current
    // camera on the first frame.
    const show = harness.showById();
    assert.equal(harness.icons().show, true, 'the icon set is visible again');
    assert.equal(show.get('firms-1'), true, 'the Tokyo fire is revealed at enable time');
    assert.equal(show.get('firms-0'), false, 'the Austin fire is NOT left shining through the planet');
  } finally {
    harness.cleanup();
  }
});

test('layer: a refresh drops rows whose fires left, and an empty one drops them all', async () => {
  const fires = [
    rawFire(AUSTIN.lat, AUSTIN.lon, 120),
    rawFire(AUSTIN.lat + 1, AUSTIN.lon, 300),
    rawFire(AUSTIN.lat + 2, AUSTIN.lon, 200),
  ];
  const harness = createHarness(fires);
  try {
    harness.layer.init(harness.viewer);
    await harness.layer.enable(harness.viewer);
    const set = harness.icons();
    assert.equal(set.count, 3);

    // Index 0 still holds a fire; 1 and 2 are gone, so their rows swap out.
    fires.splice(1, 2);
    await harness.layer.update();
    assert.deepEqual(
      Array.from({ length: set.count }, (_, row) => set.idAt(row)),
      ['firms-0'],
    );
    assert.equal(set.metaAt(set.row('firms-0')).fire.lat, AUSTIN.lat, 'the kept row holds its own fire');

    fires.length = 0;
    await harness.layer.update();
    assert.equal(set.count, 0, 'an empty refresh leaves no sprite behind');
    assert.equal(harness.latestEntries().length, 0, 'nor any card');
  } finally {
    harness.cleanup();
  }
});

test('layer: destroy takes the icons out of the scene', async () => {
  const harness = createHarness([rawFire(AUSTIN.lat, AUSTIN.lon, 120)]);
  harness.layer.init(harness.viewer);
  await harness.layer.enable(harness.viewer);
  const primitive = harness.primitives[0];
  harness.cleanup();
  assert.equal(harness.primitives.includes(primitive), false);
  assert.equal(primitive.isDestroyed(), true);
});

test('layer: a near-limb fire on a sub-ellipsoid anchor is not culled by its datum', async () => {
  const lat = AUSTIN.lat;
  const lon = AUSTIN.lon + LIMB_DLON;
  // Negative-geoid coastal cell: ground floor −27 m → anchor −22 m, which the
  // occluder reads as beyond the horizon even though the fire is in view.
  setMeshFloorPreferred(true);
  reportMeshFloorCell(lat, lon, -27);
  const harness = createHarness([
    rawFire(AUSTIN.lat, AUSTIN.lon, 120),
    rawFire(lat, lon, 90),
  ]);
  try {
    harness.layer.init(harness.viewer);
    await harness.layer.enable(harness.viewer);

    const set = harness.icons();
    const sunken = set.row('firms-1');
    const carto = Cesium.Cartographic.fromCartesian(set.position(sunken, 0, new Cesium.Cartesian3()));
    assert.ok(
      Math.abs(carto.height - (-27 + FIRE_ANCHOR_LIFT_M)) < 0.5,
      `the sprite still RENDERS at the datum-correct anchor, got ${carto.height}`,
    );
    assert.equal(harness.showById().get('firms-1'), true, 'the near-limb fire stays on screen (lifted cull anchor)');
    assert.equal(harness.showById().get('firms-0'), true, 'the camera-nadir fire is unaffected');
  } finally {
    harness.cleanup();
    _clearMeshFloorCellsForTest();
    setMeshFloorPreferred(false);
  }
});

test('layer: far-side candidates never displace near-side ambient cards', async () => {
  const near = [];
  for (let i = 0; i < 6; i += 1) near.push(rawFire(AUSTIN.lat + i * 0.4, AUSTIN.lon + i * 0.4, 100 - i));
  const far = [];
  for (let i = 0; i < 20; i += 1) far.push(rawFire(ANTIPODE.lat + i * 0.4, ANTIPODE.lon + i * 0.4, 900 - i));
  // Far-side fires are the STRONGEST, so they lead the FRP-ranked candidate
  // walk and would eat all 18 ambient slots without the horizon skip.
  const harness = createHarness([...near, ...far]);
  try {
    harness.layer.init(harness.viewer);
    await harness.layer.enable(harness.viewer);

    const ids = harness.latestEntries().map((entry) => entry.id);
    assert.ok(ids.length > 0, 'cards were published');
    assert.ok(ids.length <= FIRMS_AMBIENT_COHORT_LIMIT, 'the ambient cap still holds');
    // Card ids are `fire:firms:<lat>:<lon>:<acqMs>:<sat>` (the refetch-stable
    // detection key), so a card is matched back to its seed by coordinate.
    const nearCoords = new Set(near.map((fire) => `${fire.lat.toFixed(4)}:${fire.lon.toFixed(4)}`));
    const nearIds = ids.filter((id) => nearCoords.has(id.split(':').slice(2, 4).join(':')));
    assert.equal(nearIds.length, 6, 'every in-view fire gets a card');
    assert.equal(new Set(nearIds).size, 6, 'six distinct near-side detections, not one repeated');
    assert.equal(ids.length, 6, 'no slot is spent on a fire behind the planet');
    assert.equal(FIRMS_OVERLAY_SOURCE_ID, 'firms');
  } finally {
    harness.cleanup();
  }
});
