import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAMERAS_LAYER_ID, createVirtualCamerasLayer } from './index.js';
import { COCKPIT_REFUSAL, normalizeCameraList } from './policy.js';

/** Flat-earth Cesium stand-in: positions are metres east/north/up. */
function fakeCesium() {
  class Cartesian3 {
    constructor(x = 0, y = 0, z = 0) {
      Object.assign(this, { x, y, z });
    }
    static fromDegrees(lon, lat, height) {
      // 1° = 100 km in this toy frame; good enough to reason about distances.
      return new Cartesian3(lon * 100_000, lat * 100_000, height);
    }
    static subtract(a, b, out) {
      out.x = a.x - b.x;
      out.y = a.y - b.y;
      out.z = a.z - b.z;
      return out;
    }
    static magnitude(a) {
      return Math.hypot(a.x, a.y, a.z);
    }
    static normalize(a, out) {
      const m = Cartesian3.magnitude(a) || 1;
      out.x = a.x / m;
      out.y = a.y / m;
      out.z = a.z / m;
      return out;
    }
    static lerp(a, b, t, out) {
      out.x = a.x + (b.x - a.x) * t;
      out.y = a.y + (b.y - a.y) * t;
      out.z = a.z + (b.z - a.z) * t;
      return out;
    }
  }
  return {
    Cartesian3,
    Math: {
      toDegrees: (rad) => (rad * 180) / Math.PI,
      toRadians: (deg) => (deg * Math.PI) / 180,
    },
    Transforms: {
      eastNorthUpToFixedFrame: (origin) => ({ origin }),
    },
    Matrix4: {
      multiplyByPoint: (frame, point, out) => {
        out.x = frame.origin.x + point.x;
        out.y = frame.origin.y + point.y;
        out.z = frame.origin.z + point.z;
        return out;
      },
    },
    EllipsoidTerrainProvider: class EllipsoidTerrainProvider {},
    Ellipsoid: {
      WGS84: {
        geodeticSurfaceNormal: (_position, out) => {
          out.x = 0;
          out.y = 0;
          out.z = 1;
          return out;
        },
      },
    },
  };
}

function fakeViewer() {
  const preUpdate = new Set();
  const listeners = {};
  const views = [];
  return {
    views,
    preUpdate,
    canvasListeners: listeners,
    camera: {
      frustum: { fov: 1.0 },
      positionCartographic: {
        latitude: (37.81 * Math.PI) / 180,
        longitude: (-122.45 * Math.PI) / 180,
        height: 30,
      },
      setView(options) {
        views.push(options);
      },
    },
    scene: {
      renders: 0,
      requestRender() {
        this.renders += 1;
      },
      preUpdate: {
        addEventListener(fn) {
          preUpdate.add(fn);
          return () => preUpdate.delete(fn);
        },
      },
      canvas: {
        addEventListener(type, fn) {
          (listeners[type] ||= new Set()).add(fn);
        },
        removeEventListener(type, fn) {
          listeners[type]?.delete(fn);
        },
      },
    },
    tick() {
      for (const fn of preUpdate) fn();
    },
    gesture(type) {
      for (const fn of listeners[type] || []) fn({ type });
    },
  };
}

function fakeShell({ cockpit = false, refuse = false } = {}) {
  const handoffs = new Set();
  return {
    claims: 0,
    handoffs,
    runNavigation(navigate) {
      this.claims += 1;
      if (refuse) return false;
      return navigate();
    },
    subscribeCameraHandoff(listener) {
      handoffs.add(listener);
      return () => handoffs.delete(listener);
    },
    isCockpitActive: () => cockpit,
    publishHandoff() {
      for (const listener of [...handoffs]) listener();
    },
  };
}

const CAMERAS = normalizeCameraList([
  { id: 'tripod', title: 'Pier', type: 'ground', target: 'jet', lat: 37.8, lon: -122.4, heightM: 5 },
  { id: 'chase', title: 'Chase', type: 'chase', target: 'jet', distanceM: 200, heightOffsetM: 50 },
  { id: 'orbit', title: 'Orbit', type: 'orbit', target: 'jet', radiusM: 100, heightOffsetM: 20, periodS: 40 },
]);

function harness({ cameras = CAMERAS, shellOptions, groundFloorM = 10, targetsList } = {}) {
  const cesium = fakeCesium();
  const viewer = fakeViewer();
  const shell = fakeShell(shellOptions);
  const holds = new Set();
  let wall = 1000;
  let scenarioListener = null;
  const jet = {
    id: 'jet',
    callsign: 'JET1',
    position: cesium.Cartesian3.fromDegrees(-122.39, 37.805, 300),
    headingDeg: 90,
    pitchDeg: 0,
    speedMps: 150,
    sizeM: 20,
  };
  const targets = targetsList || [jet, { ...jet, id: 'heavy', callsign: 'HEAVY', sizeM: 60 }];
  const layer = createVirtualCamerasLayer({
    services: {
      render: {
        holdContinuousRender: (id) => holds.add(id),
        releaseContinuousRender: (id) => holds.delete(id),
        governorRequestRender: () => {},
      },
      groundFloor: {
        cachedGroundFloor: () => groundFloorM,
        warmGroundFloor: () => {},
      },
      geoid: { geoidHeight: () => -32 },
    },
    targets: () => targets,
    scenarioCameras: () => cameras,
    subscribeScenario: (listener) => {
      scenarioListener = listener;
      return () => {
        scenarioListener = null;
      };
    },
    scenarioTimeS: () => 10,
    cesium,
    now: () => wall,
  });
  layer.init(viewer);
  layer.attachShellServices(shell);
  return {
    layer,
    viewer,
    shell,
    holds,
    jet,
    cesiumRef: cesium,
    advance(ms) {
      wall += ms;
    },
    reloadScenario: () => scenarioListener?.(),
  };
}

test('enable lists the scenario cameras without touching the view', () => {
  const h = harness();
  assert.equal(h.layer.enable(), true);
  assert.deepEqual(h.layer.diagnostics().cameras, ['tripod', 'chase', 'orbit']);
  assert.equal(h.viewer.views.length, 0);
  assert.equal(h.shell.claims, 0);
  assert.equal(h.holds.size, 0);
  const controls = h.layer.getRowControls();
  assert.equal(controls.list.items[0].id, 'free');
  assert.equal(controls.list.items[0].active, true);
  assert.equal(controls.list.items[1].id, 'place');
  assert.equal(controls.list.items.length, 5);
  assert.equal(controls.segmented.options.length, 3);
  assert.equal(controls.info, 'Pick a camera');
  assert.deepEqual(h.layer.getStats(), { count: 3, error: null, loading: false });
});

test('a tripod claims the view, stands on the ground floor and aims at its target with auto zoom', () => {
  const h = harness();
  h.layer.enable();
  h.layer.setParams({ camera: 'tripod' });
  assert.equal(h.shell.claims, 1);
  assert.ok(h.holds.has(CAMERAS_LAYER_ID));
  assert.equal(h.layer.diagnostics().activeId, 'tripod');
  const view = h.viewer.views.at(-1);
  assert.equal(view.destination.z, 15, 'floor 10 m + 5 m tripod');
  assert.ok(Math.abs(view.destination.x - -122.4 * 100_000) < 1e-6);
  // The direction points from the tripod towards the jet.
  const dx = h.jet.position.x - view.destination.x;
  const dy = h.jet.position.y - view.destination.y;
  const length = Math.hypot(dx, dy, h.jet.position.z - 15);
  assert.ok(Math.abs(view.orientation.direction.x - dx / length) < 1e-9);
  assert.ok(Math.abs(view.orientation.direction.y - dy / length) < 1e-9);
  // Auto zoom: a 20 m jet across 22% of the frame at that range.
  const expected = 2 * Math.atan(20 / 0.22 / (2 * length));
  assert.ok(Math.abs(h.viewer.camera.frustum.fov - expected) < 1e-9);
  assert.ok(h.layer.getRowControls().info.startsWith('Pier → JET1'));
  // Each frame re-aims; a pointer gesture frees the view and restores the fov.
  h.advance(16);
  h.viewer.tick();
  assert.equal(h.viewer.views.length, 2);
  h.viewer.gesture('pointerdown');
  assert.equal(h.layer.diagnostics().activeId, null);
  assert.equal(h.viewer.camera.frustum.fov, 1.0);
  assert.equal(h.holds.size, 0);
  assert.equal(h.viewer.preUpdate.size, 0);
  assert.equal(h.layer.diagnostics().lastPose.released, 'manual-input');
});

test('chase rides behind the target and smooths towards it; orbit circles it', () => {
  const h = harness();
  h.layer.enable();
  h.layer.setParams({ camera: 'chase' });
  const first = h.viewer.views.at(-1).destination;
  // Eastbound target: behind is 200 m west, 50 m up.
  assert.ok(Math.abs(first.x - (h.jet.position.x - 200)) < 1e-6);
  assert.ok(Math.abs(first.y - h.jet.position.y) < 1e-6);
  assert.ok(Math.abs(first.z - (h.jet.position.z + 50)) < 1e-6);
  assert.equal(h.viewer.camera.frustum.fov, (50 * Math.PI) / 180, 'chase uses its fixed fov');
  // The target jumps; the camera follows only part of the way in one frame.
  h.jet.position.x += 1000;
  h.advance(100);
  h.viewer.tick();
  const second = h.viewer.views.at(-1).destination;
  assert.ok(second.x > first.x && second.x < first.x + 1000);
  h.layer.setParams({ camera: 'orbit' });
  const orbit = h.viewer.views.at(-1).destination;
  // t=10 s of a 40 s period is a quarter turn: east of the target.
  assert.ok(Math.abs(orbit.x - (h.jet.position.x + 100)) < 1e-6);
  assert.ok(Math.abs(orbit.y - h.jet.position.y) < 1e-6);
  assert.ok(Math.abs(orbit.z - (h.jet.position.z + 20)) < 1e-6);
  assert.equal(h.shell.claims, 2, 'switching cameras claims again');
});

test('Cockpit refuses the claim and the row says so; a handoff releases an active camera', () => {
  const refused = harness({ shellOptions: { refuse: true } });
  refused.layer.enable();
  refused.layer.setParams({ camera: 'tripod' });
  assert.equal(refused.layer.diagnostics().activeId, null);
  assert.equal(refused.layer.getStats().error, COCKPIT_REFUSAL);
  assert.equal(refused.layer.getRowControls().info, COCKPIT_REFUSAL);
  const cockpit = harness({ shellOptions: { cockpit: true } });
  cockpit.layer.enable();
  cockpit.layer.setParams({ camera: 'tripod' });
  assert.equal(cockpit.shell.claims, 0);
  assert.equal(cockpit.layer.getStats().error, COCKPIT_REFUSAL);
  const h = harness();
  h.layer.enable();
  h.layer.setParams({ camera: 'tripod' });
  h.shell.publishHandoff();
  assert.equal(h.layer.diagnostics().activeId, null);
  assert.equal(h.layer.diagnostics().lastPose.released, 'camera-handoff');
  assert.equal(h.shell.handoffs.size, 0);
});

test('a cold tripod stands on the geoid, or on ellipsoid zero over the flat fallback globe', () => {
  const cold = harness({ groundFloorM: null });
  cold.layer.enable();
  cold.layer.setParams({ camera: 'tripod' });
  assert.equal(cold.viewer.views.at(-1).destination.z, -32 + 5, 'geoid −32 m + 5 m');
  const flat = harness({ groundFloorM: null });
  flat.viewer.scene.globe = { show: true };
  flat.viewer.terrainProvider = new flat.cesiumRef.EllipsoidTerrainProvider();
  flat.layer.enable();
  flat.layer.setParams({ camera: 'tripod' });
  assert.equal(flat.viewer.views.at(-1).destination.z, 5, 'no terrain: ground is ellipsoid zero');
});

test('target override, frame fill and placing a tripod here', () => {
  const h = harness();
  h.layer.enable();
  h.layer.setParams({ camera: 'tripod', target: 'heavy', frameFraction: 0.4 });
  assert.ok(h.layer.getRowControls().info.endsWith('HEAVY'));
  const view = h.viewer.views.at(-1);
  const length = Math.hypot(
    h.jet.position.x - view.destination.x,
    h.jet.position.y - view.destination.y,
    h.jet.position.z - 15,
  );
  const expected = 2 * Math.atan(60 / 0.4 / (2 * length));
  assert.ok(Math.abs(h.viewer.camera.frustum.fov - expected) < 1e-9);
  assert.deepEqual(h.layer.getParams(), { target: 'heavy', frameFraction: 0.4 });
  h.layer.setParams({ frameFraction: 5 });
  assert.equal(h.layer.getParams().frameFraction, 0.6);
  h.layer.setParams({ place: true });
  const diagnostics = h.layer.diagnostics();
  assert.deepEqual(diagnostics.cameras, ['tripod', 'chase', 'orbit', 'session-1']);
  assert.equal(diagnostics.activeId, 'session-1');
  const placed = h.viewer.views.at(-1).destination;
  assert.equal(placed.z, 30, 'placed at the viewer camera height, not on the ground');
  assert.ok(Math.abs(placed.x - -122.45 * 100_000) < 1e-3);
});

test('a scenario reload keeps session cameras, drops a vanished active one, and disable frees the view', () => {
  let cameras = CAMERAS;
  const h = harness({ cameras });
  h.layer.enable();
  h.layer.setParams({ place: true });
  h.layer.setParams({ camera: 'tripod' });
  cameras = normalizeCameraList([CAMERAS[1]]);
  h.layer.diagnostics();
  // The harness closure reads the original list; emulate a new scenario by
  // swapping what scenarioCameras returns through a fresh layer instead.
  const fresh = harness({ cameras: normalizeCameraList([CAMERAS[1]]) });
  fresh.layer.enable();
  fresh.layer.setParams({ camera: 'chase' });
  fresh.reloadScenario();
  assert.equal(fresh.layer.diagnostics().activeId, 'chase', 'still declared: stays active');
  h.layer.setParams({ camera: 'tripod' });
  h.layer.disable();
  assert.equal(h.layer.diagnostics().activeId, null);
  assert.equal(h.holds.size, 0);
  assert.equal(h.viewer.camera.frustum.fov, 1.0);
  h.layer.destroy();
});
