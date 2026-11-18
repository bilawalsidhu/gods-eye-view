import test from 'node:test';
import assert from 'node:assert/strict';
import { CockpitViewController } from './cockpitController.js';
import { withEntityRecord } from '../data/entityRecords.js';
import { fakeInput } from '../input/testDoubles.mjs';
import { bindRenderer } from '../render/rendererOf.js';
import { entityFollowTarget, followedOf } from '../data/followed.js';
import {
  cockpitAnchorCorrectionStep,
  cockpitGroundSafeHeight,
} from '../cockpitMath.js';
import {
  COCKPIT_FORWARD_OFFSET_M,
  COCKPIT_MIN_GROUND_CLEARANCE_M,
  COCKPIT_UP_OFFSET_M,
  COCKPIT_VIEW_PITCH_DEG,
} from './cockpitPresentation.js';

function environment() {
  const original = { document: globalThis.document, window: globalThis.window };
  const document = Object.assign(new EventTarget(), {
    getElementById: () => null,
    querySelectorAll: () => [],
    body: { classList: { remove() {} } },
  });
  const window = Object.assign(new EventTarget(), { clearTimeout, setTimeout });
  globalThis.document = document;
  globalThis.window = window;
  const callbacks = new Set();
  const event = {
    addEventListener(fn) {
      callbacks.add(fn);
      return () => callbacks.delete(fn);
    },
  };
  const viewer = {
    scene: {
      preUpdate: event,
      screenSpaceCameraController: { enableInputs: true },
    },
  };
  // What the camera follows, as a layer's follow sets it.
  const camera = {
    followed: null,
    follow(target) {
      camera.followed = target;
    },
    on: (name, fn) =>
      name === 'followChanged' ? event.addEventListener(fn) : () => {},
  };
  // The renderer's frame port: Cockpit moves the camera on its preUpdate.
  bindRenderer(viewer, {
    camera,
    frame: {
      on: (phase, fn) =>
        phase === 'preUpdate' ? event.addEventListener(fn) : () => {},
    },
  });
  /** Follow a holder of an entity record, as a layer's follow does. */
  const follow = (holder) =>
    camera.follow(holder ? entityFollowTarget(holder, {}) : null);
  return {
    viewer,
    follow,
    callbacks,
    restore() {
      Object.assign(globalThis, original);
    },
  };
}

test('Cockpit subscriptions are released once and retained actions cannot restart it', () => {
  const env = environment();
  try {
    const owner = new CockpitViewController(env.viewer, { services: {} });
    assert.equal(env.callbacks.size, 2);
    owner.dispose();
    owner.dispose();
    assert.equal(env.callbacks.size, 0);
    assert.equal(owner.enter(), false);
    assert.equal(owner.navigateContext(1), false);
    assert.equal(owner.toggleTrackedTr3b(), false);
    assert.equal(owner.update(), false);
    assert.equal(owner.active, false);
  } finally {
    env.restore();
  }
});

test('disposing an active Cockpit releases the supplied render owner without retracking', () => {
  const env = environment();
  try {
    const released = [];
    const owner = new CockpitViewController(env.viewer, {
      services: { releaseContinuousRender: (reason) => released.push(reason) },
    });
    // Entered: the cockpit holds camera input, as enter() takes it.
    const { input } = fakeInput(env.viewer);
    owner.active = true;
    owner.releaseCameraInput = input.suspendCamera('cockpit');
    assert.equal(
      env.viewer.scene.screenSpaceCameraController.enableInputs,
      false,
    );
    owner.dispose();
    owner.dispose();
    assert.deepEqual(released, ['cockpit']);
    assert.equal(
      env.viewer.scene.screenSpaceCameraController.enableInputs,
      true,
    );
    assert.equal(followedOf(env.viewer), null);
    assert.equal(owner.active, false);
  } finally {
    env.restore();
  }
});

test('aircraft identity is read from the supplied layer instances', () => {
  const env = environment();
  try {
    const civilian = {
      icao24: 'abc123',
      layerId: 'flights',
      callsign: 'CIVIL',
    };
    const military = {
      icao24: 'def456',
      layerId: 'military',
      callsign: 'MILITARY',
    };
    const owner = new CockpitViewController(env.viewer, {
      services: {
        flightsLayer: { getTrackedInfo: () => civilian },
        militaryFlightsLayer: { getTrackedInfo: () => military },
      },
    });
    env.follow(withEntityRecord({}, { trackedId: 'military:def456' }));
    assert.deepEqual(owner.readAircraftInfo(), military);
    env.follow(withEntityRecord({}, { trackedId: 'flights:abc123' }));
    assert.deepEqual(owner.readAircraftInfo(), civilian);
    owner.dispose();
  } finally {
    env.restore();
  }
});

test('an obsolete regional briefing cannot publish after Cockpit disposal', async () => {
  const env = environment();
  try {
    let finish;
    let signal;
    const owner = new CockpitViewController(env.viewer, {
      services: {
        regionalDistanceM: () => Infinity,
        fetchRegionalBrief: (_lat, _lon, options) => {
          signal = options.signal;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
        releaseContinuousRender() {},
      },
    });
    const published = [];
    owner.renderRegionalBrief = (payload) => published.push(payload);
    owner.active = true;
    owner.maybeRefreshRegionalBrief({
      layerId: 'flights',
      icao24: 'abc123',
      latitude: 30,
      longitude: -97,
    });
    owner.dispose();
    assert.equal(signal.aborted, true);
    finish({ articles: [] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(published, []);
    assert.equal(owner.regionalBriefAbort, null);
  } finally {
    env.restore();
  }
});

test('stopping Cockpit revokes camera actions before deferred disposal releases rendering', () => {
  const env = environment();
  try {
    const released = [];
    const owner = new CockpitViewController(env.viewer, {
      services: {
        releaseContinuousRender: (reason) => released.push(reason),
      },
    });
    owner.active = true;
    owner.stop();
    assert.equal(env.callbacks.size, 0);
    assert.equal(owner.update(), false);
    assert.equal(owner.navigateContext(1), false);
    assert.deepEqual(released, []);
    owner.dispose();
    assert.deepEqual(released, ['cockpit']);
    assert.equal(owner.active, false);
  } finally {
    env.restore();
  }
});

test('stopped Cockpit cannot rearm briefing rotation or request a fresh region', () => {
  const env = environment();
  try {
    const frames = new Map();
    let next = 0;
    let fetches = 0;
    let paints = 0;
    env.viewer.scene.screenSpaceCameraController.enableInputs = true;
    window.setTimeout = (callback) => {
      frames.set(++next, callback);
      return next;
    };
    window.clearTimeout = (id) => frames.delete(id);
    const owner = new CockpitViewController(env.viewer, {
      services: {
        regionalDistanceM: () => Infinity,
        fetchRegionalBrief: () => {
          fetches++;
          return Promise.resolve({ articles: [] });
        },
        releaseContinuousRender() {},
      },
    });
    owner.active = true;
    owner.showBriefPage = () => {
      paints++;
    };
    owner.setBriefAutoRotate(true);
    assert.equal(frames.size, 1);
    const queued = [...frames.values()][0];
    owner.stop();
    assert.equal(frames.size, 0);
    queued();
    owner.setBriefAutoRotate(true);
    owner.startBriefRotation();
    owner.maybeRefreshRegionalBrief({ latitude: 30, longitude: -97 });
    assert.equal(frames.size, 0);
    assert.equal(paints, 0);
    assert.equal(fetches, 0);
    owner.dispose();
  } finally {
    env.restore();
  }
});

test('the weather toggle flips from its own state, however fast it is pressed', () => {
  const env = environment();
  try {
    const toggle = new EventTarget();
    document.getElementById = (id) =>
      id === 'cockpit-weather-toggle' ? toggle : null;
    const requested = [];
    window.addEventListener('gev:cockpit-weather-toggle', (event) =>
      requested.push(event.detail.enabled),
    );
    const published = [];
    const owner = new CockpitViewController(env.viewer, {
      services: {},
      publish: { context: (view) => published.push(view.weather) },
    });
    // Two presses before any view renders still alternate.
    toggle.dispatchEvent(new Event('click'));
    toggle.dispatchEvent(new Event('click'));
    assert.deepEqual(requested, [true, false]);
    assert.deepEqual(published, [true, false]);
    // The effects owner reports its state; the next press flips that.
    window.dispatchEvent(
      new CustomEvent('gev:cockpit-weather-state', {
        detail: { enabled: true },
      }),
    );
    toggle.dispatchEvent(new Event('click'));
    assert.deepEqual(requested, [true, false, false]);
    assert.deepEqual(published, [true, false, true, false]);
    owner.dispose();
  } finally {
    env.restore();
  }
});

/**
 * The Cockpit eye as cockpitCamera.js computed it with Cesium's own maths,
 * for one update: the anchor advanced along the heading and pulled toward
 * the target (held on it when stale), lifted to the floor, then the eye
 * set forward and up from it and lifted again.
 */
function cesiumCockpitEye(
  Cesium,
  { target, anchor, info, heading, dtSec, floorM, liftM },
) {
  const { Cartesian3, Matrix4, Transforms, Cartographic, Ellipsoid } = Cesium;
  const h = Cesium.Math.toRadians(heading);
  const p = Cesium.Math.toRadians(COCKPIT_VIEW_PITCH_DEG);
  const speed = Math.max(0, info.velocityMps);
  const along = (origin, x, y, z) =>
    Cartesian3.normalize(
      Matrix4.multiplyByPointAsVector(
        Transforms.eastNorthUpToFixedFrame(origin, Ellipsoid.WGS84),
        new Cartesian3(x, y, z),
        new Cartesian3(),
      ),
      new Cartesian3(),
    );
  let a = Cartesian3.clone(anchor ?? target);
  if (info.stale) a = Cartesian3.clone(target);
  else {
    const horizontal = along(a, Math.sin(h), Math.cos(h), 0);
    a = Cartesian3.add(
      a,
      Cartesian3.multiplyByScalar(horizontal, speed * dtSec, new Cartesian3()),
      new Cartesian3(),
    );
    const correction = Cartesian3.subtract(target, a, new Cartesian3());
    const distance = Cartesian3.magnitude(correction);
    const step = cockpitAnchorCorrectionStep(distance, speed, dtSec);
    if (step > 0 && distance > 0)
      a = Cartesian3.add(
        a,
        Cartesian3.multiplyByScalar(
          correction,
          step / distance,
          new Cartesian3(),
        ),
        new Cartesian3(),
      );
  }
  const anchorCarto = Cartographic.fromCartesian(a);
  let floor = floorM;
  const targetCarto = Cartographic.fromCartesian(target);
  if (!Number.isFinite(floor) && speed < 90) floor = targetCarto.height - liftM;
  if (Number.isFinite(floor)) {
    const minimum = cockpitGroundSafeHeight(
      anchorCarto.height,
      floor,
      COCKPIT_MIN_GROUND_CLEARANCE_M - COCKPIT_UP_OFFSET_M,
    );
    if (minimum !== anchorCarto.height) {
      anchorCarto.height = minimum;
      a = Ellipsoid.WGS84.cartographicToCartesian(anchorCarto);
    }
  }
  const horizontal = along(a, Math.sin(h), Math.cos(h), 0);
  const forward = along(
    a,
    Math.sin(h) * Math.cos(p),
    Math.cos(h) * Math.cos(p),
    Math.sin(p),
  );
  const up = along(
    a,
    -Math.sin(h) * Math.sin(p),
    -Math.cos(h) * Math.sin(p),
    Math.cos(p),
  );
  let eye = Cartesian3.add(
    Cartesian3.add(
      a,
      Cartesian3.multiplyByScalar(
        horizontal,
        COCKPIT_FORWARD_OFFSET_M,
        new Cartesian3(),
      ),
      new Cartesian3(),
    ),
    Cartesian3.multiplyByScalar(
      Cartesian3.normalize(a, new Cartesian3()),
      COCKPIT_UP_OFFSET_M,
      new Cartesian3(),
    ),
    new Cartesian3(),
  );
  const eyeCarto = Cartographic.fromCartesian(eye);
  const safe = cockpitGroundSafeHeight(
    eyeCarto.height,
    floor,
    COCKPIT_MIN_GROUND_CLEARANCE_M,
  );
  if (safe !== eyeCarto.height) {
    eyeCarto.height = safe;
    eye = Ellipsoid.WGS84.cartographicToCartesian(eyeCarto);
  }
  return { eye, forward, up, anchor: a };
}

/** A Cockpit flying `info` over `target`, its camera writes in `views`. */
function cockpitOver({ info, target, services = {} }) {
  const views = [];
  const viewer = {
    trackedEntityChanged: { addEventListener: () => () => {} },
  };
  bindRenderer(viewer, {
    frame: { on: () => () => {}, time: () => 0 },
    camera: {
      followed: null,
      on: () => () => {},
      pose: () => ({ lat: 30.2, lon: -97.7 }),
      setView: (view) => views.push(view),
    },
  });
  const owner = new CockpitViewController(viewer, {
    services: {
      flightsLayer: { getTrackedInfo: () => info },
      militaryFlightsLayer: {},
      cachedGroundFloor: () => null,
      trackedEntityDrawn: () => true,
      releaseContinuousRender() {},
      ...services,
    },
  });
  owner.updateHud = () => {};
  owner.active = true;
  owner.heading = info.track;
  owner.trackedEntity = {};
  owner.trackedFollow = { key: 'flights:abc123', position: () => target };
  return { owner, viewer, views };
}

const near = (a, b, eps, what) =>
  assert.ok(
    Math.abs(a.x - b.x) <= eps &&
      Math.abs(a.y - b.y) <= eps &&
      Math.abs(a.z - b.z) <= eps,
    `${what}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
  );

test('Cockpit places the eye at its aircraft as the Cesium maths did', async () => {
  const Cesium = await import('cesium');
  const env = environment();
  const realNow = performance.now;
  try {
    const target = Cesium.Cartesian3.fromDegrees(-97.67, 30.19, 1200);
    const info = {
      icao24: 'abc123',
      layerId: 'flights',
      track: 72,
      velocityMps: 200,
      latitude: 30.19,
      longitude: -97.67,
      onGround: false,
      stale: true,
    };
    const { owner, views } = cockpitOver({ info, target });
    // Held on the target while the feed is stale.
    owner.update();
    let expected = cesiumCockpitEye(Cesium, {
      target,
      info,
      heading: 72,
      dtSec: 0,
      liftM: 0,
    });
    near(views[0].destination, expected.eye, 1e-6, 'stale eye');
    near(views[0].orientation.direction, expected.forward, 1e-12, 'direction');
    near(views[0].orientation.up, expected.up, 1e-12, 'up');

    // Live: the anchor coasts 80 ms along the heading and is pulled toward
    // where the layer now shows the aircraft.
    info.stale = false;
    const anchor = Cesium.Cartesian3.clone(expected.anchor);
    const moved = Cesium.Cartesian3.fromDegrees(-97.6698, 30.1901, 1210);
    owner.trackedFollow.position = () => moved;
    let now = owner.lastFrameMs + 80;
    performance.now = () => now;
    owner.update();
    expected = cesiumCockpitEye(Cesium, {
      target: moved,
      anchor,
      info,
      heading: 72,
      dtSec: 0.08,
      liftM: 0,
    });
    assert.equal(views.length, 2);
    near(views[1].destination, expected.eye, 1e-6, 'live eye');
    near(views[1].orientation.direction, expected.forward, 1e-12, 'direction');
    near(views[1].orientation.up, expected.up, 1e-12, 'up');

    // An aircraft its layer no longer draws ends Cockpit.
    owner.services.trackedEntityDrawn = () => false;
    now += 80;
    owner.update();
    assert.equal(owner.active, false);
    assert.equal(views.length, 2);
    owner.dispose();
  } finally {
    performance.now = realNow;
    env.restore();
  }
});

test('a grounded Cockpit probes the mesh from the camera and keeps the eye above the floor', async () => {
  const Cesium = await import('cesium');
  const env = environment();
  try {
    // Reported below the apron: the floor lifts the anchor and the eye.
    const target = Cesium.Cartesian3.fromDegrees(-97.67, 30.19, 120);
    const info = {
      icao24: 'abc123',
      layerId: 'flights',
      track: 300,
      velocityMps: 0,
      latitude: 30.19,
      longitude: -97.67,
      onGround: true,
      stale: true,
    };
    const probes = [];
    const { owner, viewer, views } = cockpitOver({
      info,
      target,
      services: {
        cachedGroundFloor: () => 140,
        warmGroundFloor() {},
        cachedMeshFloor: () => null,
        meshFloorPreferred: () => true,
        sampleMeshFloorCells: (...args) => probes.push(args),
        GROUND_FLOOR_LIFT_M: 0,
      },
    });
    // The tracked contact names the draw sets its probe sees through.
    withEntityRecord(owner.trackedEntity, {
      groundSets: () => ['flights-models:1', 'flights-tracked-icon:1'],
    });
    // The surface wait is over: Cockpit flies on the ground floor.
    owner.surfaceWaitStartedMs = -1e9;
    owner.update();
    assert.equal(probes.length, 1);
    const [host, points, options] = probes[0];
    assert.equal(host, viewer);
    assert.deepEqual(points, [{ lat: 30.19, lon: -97.67 }]);
    assert.deepEqual(options, {
      sets: ['flights-models:1', 'flights-tracked-icon:1'],
      viewerLat: 30.2,
      viewerLon: -97.7,
    });
    const expected = cesiumCockpitEye(Cesium, {
      target,
      info,
      heading: 300,
      dtSec: 0,
      floorM: 140,
      liftM: 0,
    });
    assert.equal(views.length, 1);
    // The floor lifts round-trip through geodetic heights: the shared geo helpers' and
    // Cesium's agree to well under a millimetre there.
    near(views[0].destination, expected.eye, 1e-4, 'eye');
    const height = Cesium.Cartographic.fromCartesian(
      new Cesium.Cartesian3(
        views[0].destination.x,
        views[0].destination.y,
        views[0].destination.z,
      ),
    ).height;
    assert.ok(
      height >= 140 + COCKPIT_MIN_GROUND_CLEARANCE_M - 1e-6,
      `${height}`,
    );
    owner.dispose();
  } finally {
    env.restore();
  }
});
