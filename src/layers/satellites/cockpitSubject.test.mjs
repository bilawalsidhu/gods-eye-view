import assert from 'node:assert/strict';
import test from 'node:test';
import { twoline2satrec } from 'satellite.js';
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
import { createStationPanel } from './stationPanel.js';
import { trackedStation } from './stationModels.js';
import { toLonLatH } from '../../geo/ellipsoid.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { fakeInput } from '../../input/testDoubles.mjs';

const COMPANION = 25545;
const GPS = 32711;
const STARLINK = 44713;

/** The companion's mean anomaly: the ISS's own, so docked to it. */
const DOCKED = ' 88.1156';
/** A degree on along the same orbit, about 120 km: apart from the ISS. */
const APART = ' 89.1156';

function tle(
  name,
  id,
  motion = '15.48899044',
  inclination = ' 51.6326',
  anomaly = DOCKED,
) {
  // Owned synthetic element sets; never live requests. The station pair
  // share elements, so the companion is docked to the ISS.
  return `${name}\n1 ${id}U 98067A   26289.78971908  .00007803  00000+0  15012-3 0  9995\n2 ${id} ${inclination}  58.3278 0006748 271.9059 ${anomaly} ${motion}590607`;
}

/** Each group's elements, with the companion at `companionAnomaly`. */
function groupText(group, companionAnomaly) {
  if (group === 'stations')
    return [
      tle('ISS (ZARYA)', ISS_NORAD),
      tle('PROGRESS-MS 31', COMPANION, undefined, undefined, companionAnomaly),
    ].join('\n');
  if (group === 'gps-ops')
    return tle('GPS FIXTURE', GPS, ' 2.00563000', ' 55.0000');
  // The dense catalog (the Starlink shell), once asked for.
  if (group === 'starlink')
    return tle('STARLINK FIXTURE', STARLINK, '15.05000000', ' 53.0000');
  return '';
}

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

/**
 * The whole layer over a fake draw port. `companionAnomaly` places the
 * companion on the ISS (DOCKED) or apart from it (APART); `refresh` brings
 * it new elements with the layer's five-minute catalog update.
 */
async function fixture(t, { companionAnomaly = DOCKED } = {}) {
  const elements = { companionAnomaly };
  const source = {
    async readGroup(group) {
      const text = groupText(group, elements.companionAnomaly);
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
    /** A frame on the docked scan's beat (once a second). */
    nextScan() {
      state._lastDockedScanMs = Number.NEGATIVE_INFINITY;
      this.nextFrame();
    },
    /** The catalog update, with the companion at `anomaly`. */
    async refresh(anomaly = elements.companionAnomaly) {
      elements.companionAnomaly = anomaly;
      const log = console.log;
      console.log = noop;
      try {
        await parts.ingestion.methods.update(viewer);
      } finally {
        console.log = log;
      }
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

test('the station offers its mount only while the Cockpit rides it', async (t) => {
  const f = await fixture(t);
  const mount = { label: 'ZARYA' };
  // The ISS model part works the mount out (issModel.js, stationModel.js);
  // this layer only decides when the Cockpit may have it, asking the part
  // whose station the subject is (stationModels.js).
  const modelPart = (offered) => ({
    key: 'iss',
    norad: ISS_NORAD,
    _updateStationModel() {},
    _destroyStationModel() {},
    _standsInFor: () => false,
    _cockpitMount: () => offered,
  });
  f.parts.stationModels = [modelPart(mount)];
  assert.equal(f.methods.getCockpitMount(), null, 'nothing tracked');
  f.track(ISS_NORAD);
  f.nextFrame();
  assert.equal(f.methods.getCockpitMount(), null, 'tracked, not ridden');
  f.methods.setCockpitSubject(String(ISS_NORAD));
  assert.equal(f.methods.getCockpitMount(), mount);
  // The view asked for is passed on; none asks for the first on offer.
  const asked = [];
  f.parts.stationModels = [
    {
      ...modelPart(mount),
      _cockpitMount(key) {
        asked.push(key);
        return mount;
      },
    },
  ];
  f.methods.getCockpitMount('zarya');
  f.methods.getCockpitMount();
  assert.deepEqual(asked, ['zarya', null]);
  // The model has nothing to offer: not loaded, or not the station.
  f.parts.stationModels = [modelPart(null)];
  assert.equal(f.methods.getCockpitMount(), null);
  delete f.parts.stationModels;
  assert.equal(f.methods.getCockpitMount(), null);
  // Another station's part is not asked for the ISS.
  f.parts.stationModels = [{ ...modelPart(mount), norad: 48274 }];
  assert.equal(f.methods.getCockpitMount(), null);
  f.parts.stationModels = [modelPart(mount)];
  f.methods.setCockpitSubject(null);
  assert.equal(f.methods.getCockpitMount(), null, 'released');
});

test('a satellite docked to the ISS draws no ring of its own: the ISS’s shows', async (t) => {
  const f = await fixture(t);
  f.track(COMPANION);
  f.nextFrame();
  assert.equal(f.state._trackedDockedToIss, true);
  assert.equal(f.ring(COMPANION), undefined, 'no second ring');
  assert.equal(f.ring(ISS_NORAD).show, true);
  // The ISS's ring stands for it even with the stations class hidden.
  f.methods.setParams({ classes: { stations: false } });
  assert.equal(f.ring(ISS_NORAD).show, true);
  // Another satellite keeps its own ring; the ISS's goes with its class.
  f.track(GPS);
  f.nextFrame();
  assert.equal(f.state._trackedDockedToIss, false);
  assert.ok(f.ring(GPS));
  assert.equal(f.ring(GPS).show, true);
  assert.equal(f.ring(ISS_NORAD).show, false);
});

test('a vehicle that undocks while tracked draws its own ring and is no longer the station', async (t) => {
  const f = await fixture(t);
  f.track(COMPANION);
  f.nextFrame();
  assert.equal(f.state._trackedDockedToIss, true);
  assert.equal(f.ring(COMPANION), undefined);
  assert.deepEqual(f.methods.getLiveSubjectKeys(), ['station:iss']);
  // The next elements have it a degree along the orbit: it has left.
  await f.refresh(APART);
  f.nextScan();
  assert.equal(f.state._trackedNorad, COMPANION, 'still tracked');
  assert.equal(f.state._trackedDockedToIss, false);
  assert.equal(f.state._trackedDockedToStation, null);
  assert.equal(f.ring(COMPANION)?.show, true, 'a ring of its own');
  assert.deepEqual(f.methods.getLiveSubjectKeys(), []);
  assert.equal(trackedStation(f.state, f.parts), null, 'no STATION section');
  // The ISS's ring is back on its own rules: it goes with its class.
  f.methods.setParams({ classes: { stations: false } });
  assert.equal(f.ring(ISS_NORAD).show, false);
});

test('a vehicle that docks while tracked leaves its ring to the ISS’s and is the station', async (t) => {
  const f = await fixture(t, { companionAnomaly: APART });
  f.track(COMPANION);
  f.nextFrame();
  assert.equal(f.state._trackedDockedToIss, false);
  assert.equal(f.ring(COMPANION)?.show, true, 'its own ring while apart');
  assert.deepEqual(f.methods.getLiveSubjectKeys(), []);
  await f.refresh(DOCKED);
  f.nextScan();
  assert.equal(f.state._trackedDockedToIss, true);
  assert.equal(f.state._trackedDockedToStation, ISS_NORAD);
  assert.equal(f.ring(COMPANION), undefined, 'no second ring');
  assert.deepEqual(f.methods.getLiveSubjectKeys(), ['station:iss']);
  // The ISS's ring stands for it, also with the stations class hidden.
  f.methods.setParams({ classes: { stations: false } });
  assert.equal(f.ring(ISS_NORAD).show, true);
});

test('docking is judged again once a second while tracked, between catalog updates', async (t) => {
  const f = await fixture(t, { companionAnomaly: APART });
  f.track(COMPANION);
  f.nextScan();
  assert.ok(f.ring(COMPANION));
  // Its orbit now meets the station's, as a vehicle closing on it does.
  const [, line1, line2] = tle('PROGRESS-MS 31', COMPANION).split('\n');
  f.state._catalog.get(COMPANION).satrec = twoline2satrec(line1, line2);
  // Between beats nothing is judged.
  f.state._lastDockedScanMs = Number.POSITIVE_INFINITY;
  f.nextFrame();
  assert.equal(f.state._trackedDockedToIss, false);
  f.nextScan();
  assert.equal(f.state._trackedDockedToIss, true);
  assert.equal(f.ring(COMPANION), undefined);
  assert.equal(f.ring(ISS_NORAD).show, true);
  // And it leaves again.
  const [, apart1, apart2] = tle(
    'PROGRESS-MS 31',
    COMPANION,
    undefined,
    undefined,
    APART,
  ).split('\n');
  f.state._catalog.get(COMPANION).satrec = twoline2satrec(apart1, apart2);
  f.nextScan();
  assert.equal(f.state._trackedDockedToIss, false);
  assert.equal(f.ring(COMPANION)?.show, true);
});

test('a docked judgement holds out to three radii, so a pair near the radius does not flip', async (t) => {
  const f = await fixture(t);
  f.track(COMPANION);
  f.nextScan();
  assert.equal(f.state._trackedDockedToIss, true);
  const at = (anomaly) => {
    const [, line1, line2] = tle(
      'PROGRESS-MS 31',
      COMPANION,
      undefined,
      undefined,
      anomaly,
    ).split('\n');
    f.state._catalog.get(COMPANION).satrec = twoline2satrec(line1, line2);
    f.nextScan();
    return f.state._trackedDockedToIss;
  };
  // About 8 km apart (0.068° along the orbit), past the 5 km radius: still
  // docked, as a pair whose elements drift apart over an orbit is.
  assert.equal(at(' 88.1836'), true);
  assert.equal(f.ring(COMPANION), undefined);
  // About 20 km apart, past three radii: undocked.
  assert.equal(at(' 88.2856'), false);
  assert.equal(f.ring(COMPANION)?.show, true);
  // Back at 8 km it stays undocked: docking needs the radius itself.
  assert.equal(at(' 88.1836'), false);
  assert.equal(at(DOCKED), true);
});

test('a vehicle that undocks in Manual hands the station’s joints back to Automatic', async (t) => {
  const f = await fixture(t);
  const calls = [];
  const articulation = {
    isSunlit: () => true,
    isLive: () => false,
    setTelemetryAllowed: (allowed) => calls.push(['telemetry', allowed]),
  };
  // The STATION section over a stand-in ISS description; the layer's tick
  // syncs it each frame, as index.js wires it.
  f.parts.stationPanel = createStationPanel({
    state: f.state,
    parts: f.parts,
    stations: [
      {
        key: 'iss',
        title: 'ISS',
        selected: () => trackedStation(f.state, f.parts)?.norad === ISS_NORAD,
        subjectName: () => 'PROGRESS-MS 31',
        articulation: () => articulation,
        telemetry: () => null,
        position: () => null,
        zoomLabel: 'Zoom to the station',
        notes: { computed: 'Computed.' },
        groups: [],
        automatic: () => calls.push(['automatic']),
      },
    ],
  });
  const views = [];
  f.parts.stationPanel.methods.subscribeStationPanel((view) =>
    views.push(view),
  );
  f.track(COMPANION);
  f.nextFrame();
  assert.equal(views.at(-1)?.key, 'iss');
  f.parts.stationPanel.methods.getStationActions().setStationMode('manual');
  assert.equal(views.at(-1).mode, 'manual');
  await f.refresh(APART);
  f.nextScan();
  assert.equal(views.at(-1), null, 'the section goes');
  assert.deepEqual(calls.at(-1), ['automatic']);
});

test('a catalog update keeps a tracked satellite’s ring, and its own dot hidden', async (t) => {
  const f = await fixture(t);
  f.track(GPS);
  f.nextFrame();
  assert.equal(f.ring(GPS)?.show, true);
  assert.equal(
    f.state._points.get(GPS).show,
    false,
    'the tracked dot draws it',
  );
  await f.refresh();
  f.nextFrame();
  assert.equal(f.state._trackedNorad, GPS, 'still tracked');
  assert.equal(f.ring(GPS)?.show, true, 'its ring is drawn again');
  assert.equal(
    f.state._points.get(GPS).show,
    false,
    'its own dot stays hidden',
  );
  assert.equal(f.ring(ISS_NORAD).show, true, "the ISS's ring as before");
});

test('a tracked Starlink keeps its ring, and its own dot hidden, over a catalog update', async (t) => {
  const log = console.log;
  console.log = () => {};
  t.after(() => (console.log = log));
  const f = await fixture(t);
  f.methods.setParams({ catalog: 'dense' });
  await f.state._denseLoadPromise;
  assert.equal(f.track(STARLINK), true);
  f.nextFrame();
  assert.equal(f.ring(STARLINK)?.show, true);
  // The core rebuild drops the dense extras; the dense load brings them back.
  await f.refresh();
  await f.state._denseLoadPromise;
  f.nextFrame();
  assert.equal(f.state._trackedNorad, STARLINK, 'still tracked');
  assert.equal(f.ring(STARLINK)?.show, true, 'its ring is drawn again');
  assert.equal(f.state._points.get(STARLINK).show, false);
});

test('with Orbits off a tracked satellite’s ring is built hidden, as the ISS’s is', async (t) => {
  const f = await fixture(t, { companionAnomaly: APART });
  // Space Missions' Satellite params while it borrows the layer.
  f.methods.setParams({ showPoints: false, showOrbits: false });
  f.track(ISS_NORAD);
  f.nextFrame();
  assert.equal(f.ring(ISS_NORAD).show, false);
  f.track(GPS);
  f.nextFrame();
  assert.equal(f.ring(GPS).show, false);
  f.track(COMPANION);
  f.nextFrame();
  assert.equal(f.ring(COMPANION).show, false);
  // A catalog update builds it again, still hidden.
  await f.refresh();
  f.nextFrame();
  assert.equal(f.ring(COMPANION).show, false);
  // Orbits on: every ring shows.
  f.methods.setParams({ showOrbits: true });
  assert.equal(f.ring(COMPANION).show, true);
  assert.equal(f.ring(ISS_NORAD).show, true);
});

test('a ring baked again keeps whether it shows and the alpha it is drawn at', async (t) => {
  const f = await fixture(t);
  f.track(GPS);
  f.nextFrame();
  // The world time has moved far from the bake: every ring is baked again.
  const rebake = () => {
    const before = new Map(f.state._orbitPaths);
    f.parts.rendering._updateOrbitPathRotations(
      new Date(f.state.now() + 31 * 60_000),
    );
    for (const [id, path] of before)
      assert.notEqual(f.state._orbitPaths.get(id), path, `${id} baked again`);
  };
  // The ISS's ring hidden with its class; the tracked ring shown.
  f.methods.setParams({ classes: { stations: false } });
  assert.equal(f.ring(ISS_NORAD).show, false);
  assert.equal(f.ring(GPS).show, true);
  rebake();
  assert.equal(f.ring(ISS_NORAD).show, false, 'still hidden with its class');
  assert.equal(f.ring(GPS).show, true, 'still shown');
  // Riding GPS in the Cockpit: its ring hidden, the ISS's dimmed.
  f.methods.setParams({ classes: { stations: true } });
  f.methods.setCockpitSubject(GPS);
  const dimmed = ringColors(f, ISS_NORAD);
  assert.equal(f.ring(GPS).show, false);
  rebake();
  assert.equal(f.ring(GPS).show, false, 'still hidden for the Cockpit');
  assert.equal(f.ring(ISS_NORAD).show, true);
  assert.deepEqual(ringColors(f, ISS_NORAD), dimmed, 'still dimmed');
});
