import assert from 'node:assert/strict';
import test from 'node:test';
import { createState } from './state.js';
import { createControls } from './controls.js';
import { createOrbits } from './orbits.js';
import { createLabels } from './labels.js';
import { createTracking } from './tracking.js';
import { createRendering } from './rendering.js';
import { createCatalog } from './catalog.js';
import { createLifecycle } from './lifecycle.js';
import { createInteraction } from './interaction.js';
import { createIngestion } from './ingestion.js';
import {
  COCKPIT_ORBIT_DIM_FACTOR,
  createCockpitSubject,
  satelliteCockpitInfo,
} from './cockpitSubject.js';
import { groundTrackBearingDeg } from './orbits.js';
import { indexImagingSensors } from './sensors.js';
import { ISS_NORAD, TRACKED_ORBIT_COLOR } from './policy.js';
import { toLonLatH } from '../../geo/ellipsoid.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { fakeInput } from '../../input/testDoubles.mjs';

const COMPANION = 25545;
const GPS = 32711;

function tle(name, id, motion = '15.48899044', inclination = ' 51.6326') {
  // Owned synthetic element sets; never live requests. The station pair
  // share elements, so the companion is docked to the ISS.
  return `${name}\n1 ${id}U 98067A   26289.78971908  .00007803  00000+0  15012-3 0  9995\n2 ${id} ${inclination}  58.3278 0006748 271.9059  88.1156 ${motion}590607`;
}

const GROUP_TEXT = {
  stations: [
    tle('ISS (ZARYA)', ISS_NORAD),
    tle('PROGRESS-MS 31', COMPANION),
  ].join('\n'),
  'gps-ops': tle('GPS FIXTURE', GPS, ' 2.00563000', ' 55.0000'),
};

/** The layer's live draw set whose id ends with `suffix`. */
function drawnSet(f, suffix) {
  return [...f.draw.sets.values()].find(
    (set) => !set.disposed && set.spec.id.endsWith(suffix),
  );
}

/** Whether the tracked dot is drawn shown. */
function dotShown(f) {
  const set = drawnSet(f, ':tracked');
  const dot = set.items.get(String(f.state._trackedNorad));
  return dot?.show !== false;
}

/**
 * A camera port that keeps what it follows: enough for the layer's follow,
 * its follow-change listener and the Cockpit's refocus.
 */
function fakeFollowCamera() {
  const listeners = new Set();
  const camera = {
    followed: null,
    flightsCancelled: 0,
    follow(target) {
      camera.followed = target ?? null;
      for (const cb of [...listeners]) cb(camera.followed);
    },
    cancelFlight() {
      camera.flightsCancelled += 1;
    },
    flyTo() {},
    pose: () => ({ lon: 0, lat: 0, height: 2e7, heading: 0, pitch: -1.57 }),
    on(event, cb) {
      if (event !== 'followChanged') return () => {};
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  return camera;
}

/** A frame port whose preRender the test steps by hand. */
function fakeFrame() {
  const listeners = new Set();
  return {
    on(phase, cb) {
      if (phase !== 'preRender') return () => {};
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    requestRender() {},
    holdContinuous: () => () => {},
    time: () => Date.now(),
    step(t) {
      for (const cb of [...listeners]) cb(t);
    },
  };
}

const SATCAT_HEADER =
  'OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER';
const SATCAT_TEXT = {
  stations: [
    SATCAT_HEADER,
    `ISS (ZARYA),1998-067A,${ISS_NORAD},PAY,+,ISS`,
    `PROGRESS-MS 31,2026-001A,${COMPANION},PAY,+,CIS`,
  ].join('\n'),
  // No designator: the TLE's is used.
  'gps-ops': [SATCAT_HEADER, `GPS FIXTURE,,${GPS},PAY,+,US`].join('\n'),
};
const UCS = new Map([
  [
    ISS_NORAD,
    {
      noradId: ISS_NORAD,
      operator: 'NASA/Multinational',
      operatorCountry: 'Multinational',
      purpose: 'Space Science',
    },
  ],
]);

// One sensor entry, matched by NORAD number, for the orbital zoom cap.
const SENSORS = indexImagingSensors({
  entries: [
    {
      id: 'fixture-imager',
      label: 'Fixture imager',
      match: { norad: [GPS] },
      narrowestSwathKm: 50,
      swathConfirmed: true,
      sources: ['https://example.test/spec'],
    },
  ],
});

async function fixture(t) {
  const source = {
    async readGroup(group) {
      const text = GROUP_TEXT[group] || '';
      return { ok: true, status: 200, text, stale: false };
    },
    async readSatcat(group) {
      return { ok: true, status: 200, text: SATCAT_TEXT[group] || '' };
    },
    readUcs: async () => UCS,
    readSensors: async () => SENSORS,
  };
  const noop = () => {};
  const services = {
    overlays: {
      setOverlayEntries: noop,
      setOverlaySourceVisible: noop,
      clearOverlaySource: noop,
    },
    layerState: { isExplicitLayerStateOrigin: () => false },
    focus: {
      clearFocusTarget: noop,
      publishFocusTargetFromCachedPosition: noop,
      publishFocusTargetAt: noop,
      nearFarScalarValueAtDistance: () => 1,
      advanceSpriteFocus: () => false,
      focusAlphaNeedsWrite: () => false,
      getFocusTarget: () => null,
      focusNowMs: (now) => now,
      focusPassIsNeeded: () => false,
    },
    context: {
      clearTrackedSubjectContext: noop,
      getContextStore: () => ({ entities: new Map() }),
      refreshTrackedSubjectContext: noop,
      selectTrackedSubjectContext: noop,
    },
    readout: { refreshTrackedReadout: noop },
    render: { holdContinuousRender: noop, releaseContinuousRender: noop },
    picking: {
      registerPickOwner: noop,
      unregisterPickOwner: noop,
      resolvePickId: () => null,
      isOwnedByOtherLayer: () => false,
    },
  };
  const previousDocument = globalThis.document;
  globalThis.document = new EventTarget();
  const state = createState({ services });
  const parts = {};
  const context = { state, services, parts, source };
  for (const [name, factory] of Object.entries({
    controls: createControls,
    orbits: createOrbits,
    labels: createLabels,
    tracking: createTracking,
    rendering: createRendering,
    catalog: createCatalog,
    interaction: createInteraction,
    lifecycle: createLifecycle,
    ingestion: createIngestion,
    cockpit: createCockpitSubject,
  })) {
    parts[name] = factory(context);
  }
  const viewer = { canvas: new EventTarget(), scene: {} };
  const camera = fakeFollowCamera();
  const frame = fakeFrame();
  const { draw, unbind } = bindFakeDraw(viewer, { camera, frame });
  const input = fakeInput(viewer);
  let frameNumber = 1;
  const { log, warn } = console;
  console.log = noop;
  console.warn = noop;
  await parts.lifecycle.methods.init(viewer);
  await parts.ingestion.methods.update(viewer);
  parts.lifecycle.methods.enable(viewer);
  // GPS is TELECOM; these tests need its point on screen whatever the default.
  parts.controls.methods.setParams({ classes: { telecom: true } });
  Object.assign(console, { log, warn });
  t.after(() => {
    console.log = noop;
    parts.lifecycle.methods.destroy(viewer);
    console.log = log;
    input.destroy();
    unbind();
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });
  const methods = { ...parts.controls.methods, ...parts.cockpit.methods };
  return {
    state,
    parts,
    viewer,
    camera,
    draw,
    methods,
    track(id) {
      const log = console.log;
      console.log = noop;
      try {
        return methods.trackById(id);
      } finally {
        console.log = log;
      }
    },
    nextFrame() {
      frameNumber += 1;
      frame.step({ frame: frameNumber, time: Date.now() });
    },
    ring: (id) => state._orbitPaths.get(id)?.item,
    detected: () =>
      methods.getDetectableObjects().map((object) => object.sourceId),
  };
}

test('no subject while the layer is off or nothing is tracked', async (t) => {
  const f = await fixture(t);
  assert.equal(f.methods.getCockpitSubject(), null);
  assert.equal(f.methods.getCockpitPosition(), null);
  assert.equal(f.track(ISS_NORAD), true);
  f.state._enabled = false;
  assert.equal(f.methods.getCockpitSubject(), null);
  assert.equal(f.methods.getCockpitPosition(), null);
});

test('the tracked satellite is a subject read from the per-frame sample', async (t) => {
  const f = await fixture(t);
  f.track(ISS_NORAD);
  const propagate = f.parts.orbits.propagatePosition;
  let propagations = 0;
  f.parts.orbits.propagatePosition = (...args) => {
    propagations += 1;
    return propagate(...args);
  };
  // The frame's tick takes its sample; every reader shares it.
  f.nextFrame();
  const subject = f.methods.getCockpitSubject();
  const position = f.methods.getCockpitPosition();
  f.methods.getCockpitSubject();
  assert.equal(propagations, 1, 'one SGP4 sample per frame for every reader');

  assert.equal(subject.kind, 'satellite');
  assert.equal(subject.layerId, 'satellites');
  assert.equal(subject.id, String(ISS_NORAD));
  assert.equal(subject.noradId, ISS_NORAD);
  assert.equal(subject.name, 'ISS (ZARYA)');
  assert.equal(subject.classLabel, 'STATIONS · ISS');
  assert.equal(subject.stale, false);
  assert.ok(subject.altitudeM > 150e3 && subject.altitudeM < 1000e3);
  assert.ok(subject.velocityMps > 7000 && subject.velocityMps < 8000);

  // The same point the tracked dot and follow camera use, as a copy.
  const cached = f.state._trackedFrameCartesian;
  assert.deepEqual({ ...position }, { x: cached.x, y: cached.y, z: cached.z });
  assert.notEqual(position, cached);
  const target = { x: 0, y: 0, z: 0 };
  assert.equal(f.methods.getCockpitPosition(target), target);
  assert.ok(Math.abs(toLonLatH(position).lat - subject.latitude) < 1e-6);
  f.parts.orbits.propagatePosition = propagate;
});

test('the subject says what it is, which TLE it flies, and who owns and runs it', async (t) => {
  const f = await fixture(t);
  f.track(ISS_NORAD);
  const iss = f.methods.getCockpitSubject();
  assert.equal(iss.satelliteClass, 'stations');
  assert.equal(iss.cosparId, '1998-067A');
  assert.match(iss.tle.line1, /^1 25544U/);
  assert.match(iss.tle.line2, /^2 25544 /);
  // Day 289.789… of 2026.
  assert.ok(
    Math.abs(
      iss.tle.epochMs - (Date.UTC(2026, 0, 1) + 288.78971908 * 86_400_000),
    ) < 1000,
  );
  assert.deepEqual(
    iss.owner,
    { countryCode: null, label: 'Multinational' },
    'UCS before SATCAT',
  );
  assert.equal(iss.operator, 'NASA/Multinational');
  assert.equal(
    f.methods.getCockpitSubject().owner,
    iss.owner,
    'worked out once',
  );

  f.track(GPS);
  const gps = f.methods.getCockpitSubject();
  assert.equal(gps.satelliteClass, 'telecom');
  assert.equal(
    gps.cosparId,
    '1998-067A',
    'from TLE line 1 when SATCAT has none',
  );
  assert.deepEqual(gps.owner, { countryCode: 'US', label: 'United States' });
  assert.equal(gps.operator, null);
  // The sensor pack is matched once, at ingestion.
  assert.equal(gps.sensor?.id, 'fixture-imager');
  assert.equal(gps.sensor.narrowestSwathKm, 50);
  assert.equal(iss.sensor, null, 'no sensor entry, no extra zoom');

  // A bare catalog entry still answers every field.
  const bare = satelliteCockpitInfo(
    GPS,
    { name: 'X', group: 'gps-ops' },
    { latitude: 1, longitude: 2, altitude: 3 },
  );
  assert.equal(bare.satelliteClass, 'telecom');
  // An imaging satellite CelesTrak lists among the brightest objects names
  // its class, not the 'visual' group it came in.
  const landsat = satelliteCockpitInfo(
    49260,
    { name: 'LANDSAT 9', group: 'visual', satelliteClass: 'imaging' },
    { latitude: 1, longitude: 2, altitude: 3 },
  );
  assert.equal(landsat.classLabel, 'IMAGING');
  assert.equal(bare.tle, null);
  assert.equal(bare.owner, null);
  assert.equal(bare.operator, null);
  assert.equal(bare.cosparId, null);
});

test('a GNSS satellite carries its class and an orbital speed', async (t) => {
  const f = await fixture(t);
  f.track(GPS);
  const subject = f.methods.getCockpitSubject();
  assert.equal(subject.classLabel, 'TELECOM · GPS');
  assert.ok(subject.altitudeM > 19e6 && subject.altitudeM < 21.5e6);
  assert.ok(subject.velocityMps > 3500 && subject.velocityMps < 4200);
  assert.equal(
    satelliteCockpitInfo(
      GPS,
      { name: 'X', group: 'gps-ops' },
      {
        latitude: 1,
        longitude: 2,
        altitude: 3,
      },
    ).velocityMps,
    null,
  );
  assert.equal(satelliteCockpitInfo(GPS, null, { latitude: 0 }), null);
});

test('holding the subject hides its dot, ring, docked companions and bracket', async (t) => {
  const f = await fixture(t);
  f.track(ISS_NORAD);
  f.nextFrame();
  assert.ok(f.state._dockedCompanions.has(COMPANION));
  assert.equal(dotShown(f), true);
  assert.equal(f.ring(ISS_NORAD).show, true);
  assert.ok(f.detected().includes(ISS_NORAD));

  assert.equal(f.methods.setCockpitSubject(String(ISS_NORAD)), true);
  assert.equal(dotShown(f), false);
  assert.equal(f.ring(ISS_NORAD).show, false);
  assert.equal(f.state._points.get(COMPANION).show, false);
  assert.equal(f.state._points.get(GPS).show, true);
  assert.ok(!f.detected().includes(ISS_NORAD));

  // Toggling orbits on again cannot bring the ring back while held.
  f.methods.setParams({ showOrbits: true });
  assert.equal(f.ring(ISS_NORAD).show, true);
  f.nextFrame();
  assert.equal(f.ring(ISS_NORAD).show, false);

  f.methods.setCockpitSubject(null);
  assert.equal(dotShown(f), true);
  assert.equal(f.ring(ISS_NORAD).show, true);
  assert.equal(f.state._points.get(COMPANION).show, true);
  // The tracked point stays hidden: the tracked dot draws it.
  assert.equal(f.state._points.get(ISS_NORAD).show, false);
  assert.ok(f.detected().includes(ISS_NORAD));
});

test('a subject that is not tracked holds nothing', async (t) => {
  const f = await fixture(t);
  f.track(GPS);
  f.methods.setCockpitSubject(ISS_NORAD);
  f.nextFrame();
  assert.equal(dotShown(f), true);
  assert.equal(f.ring(GPS).show, true);
  assert.equal(f.ring(ISS_NORAD).show, true);
});

test('untracking a held subject gives its marks back', async (t) => {
  const f = await fixture(t);
  f.track(ISS_NORAD);
  f.nextFrame();
  f.methods.setCockpitSubject(ISS_NORAD);
  assert.equal(f.ring(ISS_NORAD).show, false);
  f.methods.stopTracking();
  assert.equal(f.methods.getCockpitSubject(), null);
  assert.equal(f.ring(ISS_NORAD).show, true);
  assert.equal(f.state._points.get(COMPANION).show, true);
  assert.equal(f.state._points.get(ISS_NORAD).show, true);
});

test('a catalog refresh while held keeps the subject and its companions hidden', async (t) => {
  const f = await fixture(t);
  f.track(ISS_NORAD);
  f.nextFrame();
  f.methods.setCockpitSubject(ISS_NORAD);
  const log = console.log;
  console.log = () => {};
  try {
    await f.parts.ingestion.methods.update(f.viewer);
  } finally {
    console.log = log;
  }
  f.nextFrame();
  assert.equal(f.state._points.get(COMPANION).show, false, 'companion');
  assert.equal(f.state._points.get(ISS_NORAD).show, false, 'tracked point');
  f.methods.setCockpitSubject(null);
  assert.equal(f.state._points.get(COMPANION).show, true, 'given back');
});

test('untracking a held ISS leaves its ring hidden while Stations is off', async (t) => {
  const f = await fixture(t);
  f.track(ISS_NORAD);
  f.nextFrame();
  f.methods.setCockpitSubject(ISS_NORAD);
  f.methods.setParams({ classes: 'itpd' });
  f.nextFrame();
  f.methods.stopTracking();
  assert.equal(f.ring(ISS_NORAD).show, false);
  f.methods.setParams({ classes: 'sitpd' });
  assert.equal(f.ring(ISS_NORAD).show, true);
});

test('tracking without a Cockpit subject keeps its marks', async (t) => {
  const f = await fixture(t);
  f.track(GPS);
  for (let i = 0; i < 3; i++) f.nextFrame();
  assert.equal(dotShown(f), true);
  assert.equal(f.ring(GPS).show, true);
  assert.equal(f.state._points.get(COMPANION).show, true);
  assert.equal(f.state._cockpitHiddenPoints.size, 0);
  assert.equal(f.state._cockpitHiddenPath, null);
});

/** A ring's drawn colour and behind-the-globe colour. */
function ringColors(f, id) {
  const item = f.ring(id);
  return {
    color: [...item.style.color],
    depthFail: [...item.depthFail.color],
  };
}

test('a Cockpit subject dims every other orbit ring and restores it exactly', async (t) => {
  const f = await fixture(t);
  f.track(GPS);
  f.nextFrame();
  assert.ok(f.ring(ISS_NORAD), 'the ISS ring is drawn beside the tracked one');
  const issBuilt = ringColors(f, ISS_NORAD);
  const gpsBuilt = ringColors(f, GPS);

  f.methods.setCockpitSubject(GPS);
  const iss = ringColors(f, ISS_NORAD);
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  near(iss.color[3], issBuilt.color[3] * COCKPIT_ORBIT_DIM_FACTOR);
  near(iss.depthFail[3], issBuilt.depthFail[3] * COCKPIT_ORBIT_DIM_FACTOR);
  assert.deepEqual(iss.color.slice(0, 3), issBuilt.color.slice(0, 3));
  // What the draw port holds is what the ring says.
  const rings = drawnSet(f, ':rings');
  assert.deepEqual(
    [...rings.items.get(String(ISS_NORAD)).style.color],
    iss.color,
  );
  assert.equal(f.ring(ISS_NORAD).show, true, 'other rings stay visible');
  assert.equal(f.ring(GPS).show, false, 'the ridden ring stays hidden');
  assert.deepEqual(
    ringColors(f, GPS),
    gpsBuilt,
    'the ridden ring is not dimmed',
  );
  // Other satellites' points stay as they are.
  assert.equal(f.state._points.get(COMPANION).show, true);

  // A rebuilt ring arrives at full alpha and is dimmed again on the tick.
  f.parts.rendering._hideOrbitPath(ISS_NORAD);
  f.parts.rendering._showOrbitPath(ISS_NORAD, TRACKED_ORBIT_COLOR);
  const rebuiltAt = ringColors(f, ISS_NORAD);
  f.nextFrame();
  near(
    ringColors(f, ISS_NORAD).color[3],
    rebuiltAt.color[3] * COCKPIT_ORBIT_DIM_FACTOR,
  );

  f.methods.setCockpitSubject(null);
  assert.deepEqual(
    ringColors(f, ISS_NORAD),
    rebuiltAt,
    'released rings get their built colours back exactly',
  );
  assert.equal(f.ring(GPS).show, true);
  assert.deepEqual(ringColors(f, GPS), gpsBuilt);
});

test('a held subject ignores the layer Escape; refocus restores the follow', async (t) => {
  const f = await fixture(t);
  f.track(ISS_NORAD);
  f.nextFrame();
  f.methods.setCockpitSubject(ISS_NORAD);
  f.parts.interaction._onKeyDown({ key: 'Escape' });
  assert.equal(f.state._trackedNorad, ISS_NORAD, 'the Cockpit owns Escape');

  // The Cockpit took the follow camera off the satellite (without telling
  // the layer); refocus puts it back.
  const target = f.camera.followed;
  assert.ok(target, 'tracking follows the satellite');
  f.camera.followed = null;
  f.methods.setCockpitSubject(null);
  assert.equal(f.methods.refocusTrackedById(GPS), false, 'not the tracked one');
  assert.equal(f.camera.followed, null);
  assert.equal(f.methods.refocusTrackedById(String(ISS_NORAD)), true);
  assert.equal(f.camera.followed, target);
  assert.equal(f.state._trackedNorad, ISS_NORAD);

  f.parts.interaction._onKeyDown({ key: 'Escape' });
  assert.equal(f.state._trackedNorad, null, 'released, Escape untracks again');
  assert.equal(f.methods.refocusTrackedById(ISS_NORAD), false);
});

test('the ground track bearing comes from the SGP4 velocity, less the Earth turning', () => {
  const near = (actual, expected) =>
    assert.ok(Math.abs(actual - expected) < 0.2, `${actual} vs ${expected}`);
  // An ISS-like orbit (51.6°, 7.66 km/s) crossing the equator northbound at
  // 0°E: inertially 38.4° from north, but the ground turns east beneath it,
  // so the track runs closer to north.
  const inclination = (51.6 * Math.PI) / 180;
  const iss = {
    position: { x: 6771, y: 0, z: 0 },
    velocity: {
      x: 0,
      y: 7.66 * Math.cos(inclination),
      z: 7.66 * Math.sin(inclination),
    },
  };
  near(groundTrackBearingDeg(iss.position, iss.velocity, 0, 0, 0), 35.4);
  // The same state given in TEME a quarter sidereal turn on (GMST 90°):
  // still over 0°E, so the same ground track.
  near(
    groundTrackBearingDeg(
      { x: 0, y: 6771, z: 0 },
      { x: -iss.velocity.y, y: 0, z: iss.velocity.z },
      Math.PI / 2,
      0,
      0,
    ),
    35.4,
  );
  // Geostationary: it turns with the Earth, so there is no ground track.
  assert.equal(
    groundTrackBearingDeg(
      { x: 42164, y: 0, z: 0 },
      { x: 0, y: 3.0747, z: 0 },
      0,
      0,
      0,
    ),
    null,
  );
  assert.equal(groundTrackBearingDeg(iss.position, null, 0, 0, 0), null);
  // The subject passes the sample's track through.
  const sat = { name: 'X', group: 'stations' };
  const fix = { latitude: 0, longitude: 0, altitude: 400_000 };
  assert.equal(
    satelliteCockpitInfo(1, sat, { ...fix, groundTrackDeg: 35.4 })
      .groundTrackDeg,
    35.4,
  );
  assert.equal(satelliteCockpitInfo(1, sat, fix).groundTrackDeg, null);
});

test('the subject says whether its class may be ridden', () => {
  const fix = { latitude: 0, longitude: 0, altitude: 400_000 };
  const subject = (satelliteClass) =>
    satelliteCockpitInfo(
      1,
      { name: 'X', group: 'visual', satelliteClass },
      fix,
    );
  assert.equal(subject('debris').enterable, false);
  for (const satelliteClass of [
    'stations',
    'imaging',
    'telecom',
    'starlink',
    'probes',
  ])
    assert.equal(subject(satelliteClass).enterable, true, satelliteClass);
});
