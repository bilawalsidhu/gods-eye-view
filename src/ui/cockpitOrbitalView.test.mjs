// src/ui/cockpitOrbitalView.test.mjs — the tracked satellite's orbital view:
// entry, the nadir camera, the optical zoom and its field of view, the
// off-nadir look, the HUD it shows and hides, and the ways it ends, over
// happy-dom. Aircraft and bridge sessions keep their keys.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, defineComponent, h, nextTick } from 'vue';
import * as Cesium from 'cesium';
import { CockpitViewController } from './cockpitController.js';
import { useCockpitStore } from './stores/cockpit.js';
import { useHudStore } from './stores/hud.js';
import CockpitView from './views/CockpitView.vue';
import IntelHudView from './views/IntelHudView.vue';
import {
  ORBITAL_SETTLE_BLUR_PX,
  ORBITAL_SETTLE_MAX_MS,
  ORBITAL_ZOOM_TRANSITION_MS,
  cesiumFrustumFovRad,
  fovForZoom,
  orbitalBaseFovRad,
} from '../cockpitOrbital.js';
import { vesselCockpitInfo } from '../layers/vessels/cockpitSubject.js';
import { claimPointer, releasePointer } from '../data/inputOwnership.js';
import {
  bindFakeCesiumCamera,
  followEntity,
  followedEntity,
} from '../testSupport/fakeCameraPort.mjs';
import { followedOf } from '../data/followed.js';
import { fakeScenePorts } from '../testSupport/fakeCesiumScene.mjs';
import { fakeInput } from '../input/testDoubles.mjs';

const ISS = Object.freeze({
  kind: 'satellite',
  layerId: 'satellites',
  id: '25544',
  noradId: 25544,
  name: 'ISS (ZARYA)',
  satelliteClass: 'stations',
  classLabel: 'STATION · ISS',
  latitude: 30,
  longitude: -97,
  altitudeM: 420_000,
  velocityMps: 7_660,
  stale: false,
});

/** The camera's field of view before entry; it must come back exactly. */
const SAVED_FOV = 1.0471975511965976;
const ASPECT = 16 / 9;
const START_MS = 1_800_000_000_000;

function satelliteLayer(subject) {
  const calls = [];
  let current = subject;
  return {
    calls,
    /** Tracking stopped or the layer turned off: no subject. */
    drop() {
      current = null;
    },
    getCockpitSubject: () => (current ? { ...current } : null),
    getCockpitPosition(result) {
      if (!current) return null;
      return Cesium.Cartesian3.fromDegrees(
        current.longitude,
        current.latitude,
        current.altitudeM,
        Cesium.Ellipsoid.WGS84,
        result,
      );
    },
    setCockpitSubject(noradId) {
      calls.push(['subject', noradId]);
      return true;
    },
    refocusTrackedById(noradId) {
      calls.push(['refocus', noradId]);
      return true;
    },
  };
}

const DOUBLE_CLICK = Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK;

/** The Viewer's input handler, with its stock double-click: untrack. */
function stockEventHandler(viewer) {
  const actions = new Map();
  const handler = {
    stockCalls: 0,
    getInputAction: (type) => actions.get(type),
    setInputAction: (action, type) => actions.set(type, action),
    removeInputAction: (type) => actions.delete(type),
    isDestroyed: () => false,
    /** Fire a double-click at a canvas position, as Cesium does. */
    doubleClick(position) {
      actions.get(DOUBLE_CLICK)?.({ position });
    },
  };
  actions.set(DOUBLE_CLICK, () => {
    handler.stockCalls += 1;
    followEntity(viewer, null);
  });
  return handler;
}

function fixture(
  t,
  {
    satellite = ISS,
    orbitAllowed = true,
    reducedMotion = true,
    aircraftInfo = null,
    vessel = null,
  } = {},
) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(
    defineComponent(() => () => [h(IntelHudView), h(CockpitView)]),
  ).use(pinia);
  app.mount(host);
  useHudStore(pinia);
  const store = useCockpitStore(pinia);
  const previousMatchMedia = globalThis.matchMedia;
  globalThis.matchMedia = (query) => ({
    matches: query.includes('reduce') && reducedMotion,
  });
  const listeners = () => ({ addEventListener: () => () => {} });
  const shots = [];
  const aircraftPosition = Cesium.Cartesian3.fromDegrees(10.2, 54.5, 3000);
  const aircraft = {
    position: {
      getValue: (time, result) =>
        Cesium.Cartesian3.clone(aircraftPosition, result),
    },
    show: true,
    gevTrackedId: aircraftInfo ? `flights:${aircraftInfo.icao24}` : '',
  };
  const viewer = {
    clock: { currentTime: null },
    camera: {
      // Cesium's frustum: `fov` the wider angle, `fovy` the vertical one.
      frustum: {
        fov: SAVED_FOV,
        aspectRatio: ASPECT,
        get fovy() {
          return this.aspectRatio > 1
            ? 2 * Math.atan(Math.tan(this.fov / 2) / this.aspectRatio)
            : this.fov;
        },
      },
      cancelFlight() {},
      setView({ destination, orientation }) {
        shots.push({
          destination: Cesium.Cartesian3.clone(destination),
          direction: Cesium.Cartesian3.clone(orientation.direction),
          up: Cesium.Cartesian3.clone(orientation.up),
        });
      },
    },
    entities: { contains: (candidate) => candidate === aircraft },
    scene: {
      preUpdate: listeners(),
      screenSpaceCameraController: { enableInputs: true },
    },
    trackedEntityChanged: listeners(),
  };
  // Cesium's Viewer installs a double-click that untracks on any pick that
  // is not an Entity; the Cockpit routes it.
  viewer.screenSpaceEventHandler = stockEventHandler(viewer);
  // The Cockpit drives the camera, reads frames and the globe through ports:
  // the Cesium camera port over the fake camera, and a globe whose imagery
  // has loaded unless the test's `scene.globe` says otherwise.
  const ports = fakeScenePorts(viewer);
  bindFakeCesiumCamera(viewer, {
    ...ports,
    // Where the test's scene says a position is drawn.
    query: {
      ...ports.query,
      project: (position) =>
        viewer.scene.cartesianToCanvasCoordinates?.(position, {}) ?? null,
    },
    globe: {
      isGlobeVisible: () => viewer.scene.globe?.show !== false,
      isSettled: () => viewer.scene.globe?.tilesLoaded !== false,
    },
  });
  // The scene's input; the renderer's own double-click follow runs unless
  // something holds it off, as `stockEventHandler` counts it.
  const input = fakeInput(viewer);
  const satellites = satelliteLayer(satellite);
  const cockpit = new CockpitViewController(viewer, {
    services: {
      flightsLayer: { getTrackedInfo: () => aircraftInfo },
      militaryFlightsLayer: { getTrackedInfo: () => null },
      aisLiveVesselsLayer: {
        getCockpitSubject: () =>
          vessel
            ? { ...vesselCockpitInfo(vessel), seaSurfaceHeightM: 0 }
            : null,
        setCockpitSubject: () => true,
        getRadarContacts: () => [],
        focusSelectedVessel: () => true,
      },
      satellitesLayer: satellites,
      militaryAwarenessLayer: {},
      isTr3b: () => false,
      holdContinuousRender() {},
      releaseContinuousRender() {},
      cachedGroundFloor: () => null,
      GROUND_FLOOR_LIFT_M: 0,
    },
    isEntryAllowed: () => Boolean(aircraftInfo),
    isBridgeEntryAllowed: () => Boolean(vessel),
    isOrbitEntryAllowed: () => orbitAllowed,
    publish: {
      presence: (view) => store.publishPresence(view),
      instruments: (view) => store.publishInstruments(view),
      route: (view) => store.publishRoute(view),
      radar: (view) => store.publishRadar(view),
      orbital: (view) => store.publishOrbital(view),
    },
  });
  // The briefing and signals have their own tests.
  const briefed = [];
  Object.assign(cockpit, {
    setVisionMode() {},
    showBriefPage() {},
    startBriefRotation() {},
    stopBriefRotation() {},
    pushCockpitSignal() {},
    scheduleContextLayout() {},
    updateLocalPosition() {},
    maybeRefreshRegionalBrief(info) {
      briefed.push(info.noradId);
    },
    updateContext() {},
    updateRoute() {},
  });
  let stockHolds = 0;
  cockpit.holdStockFollow = () => {
    stockHolds += 1;
    let held = true;
    return () => {
      if (held) stockHolds -= 1;
      held = false;
    };
  };
  const events = [];
  const onMode = (event) => events.push(event.detail);
  window.addEventListener('gev:cockpit-mode-changed', onMode);
  t.after(() => {
    window.removeEventListener('gev:cockpit-mode-changed', onMode);
    cockpit.stop();
    input.destroy();
    app.unmount();
    globalThis.matchMedia = previousMatchMedia;
    document.body.classList.remove(
      'cockpit-mode',
      'cockpit-bridge',
      'cockpit-orbit',
    );
  });
  const $ = (selector) => document.querySelector(selector);
  return {
    $,
    cockpit,
    viewer,
    input,
    stockHeld: () => stockHolds > 0,
    satellites,
    store,
    shots,
    events,
    briefed,
    aircraft,
  };
}

/** Replace both clocks; returns a stepper. */
function manualClock(t, startMs = START_MS) {
  const originalNow = performance.now;
  const originalDateNow = Date.now;
  let nowMs = startMs;
  performance.now = () => nowMs;
  Date.now = () => nowMs;
  t.after(() => {
    performance.now = originalNow;
    Date.now = originalDateNow;
  });
  return {
    advance(ms) {
      nowMs += ms;
    },
  };
}

async function settle() {
  await nextTick();
  await Promise.resolve();
}

/** Press a key through the Cockpit's keydown handler. */
function press(
  cockpit,
  key,
  { shiftKey = false, repeat = false, target = document.body } = {},
) {
  const event = {
    key,
    shiftKey,
    repeat,
    target,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopImmediatePropagation() {},
  };
  cockpit.onKeyDown(event);
  return event;
}

const satellitePosition = (subject = ISS) =>
  Cesium.Cartesian3.fromDegrees(
    subject.longitude,
    subject.latitude,
    subject.altitudeM,
  );

/** The field of view Cesium should hold at a zoom, as `frustum.fov`. */
const frustumFovAt = (zoom, altitudeM = ISS.altitudeM) =>
  cesiumFrustumFovRad(fovForZoom(orbitalBaseFovRad(altitudeM), zoom), ASPECT);

const angleDeg = (a, b) =>
  Cesium.Math.toDegrees(Cesium.Cartesian3.angleBetween(a, b));

const near = (actual, expected, label, tolerance = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} not within ${tolerance} of ${expected}`,
  );

async function orbitAt(t, options) {
  const clock = manualClock(t);
  const scene = fixture(t, options);
  assert.equal(scene.cockpit.enter(), true);
  await settle();
  clock.advance(16);
  scene.cockpit.update();
  await settle();
  return { ...scene, clock };
}

test('a tracked satellite offers the orbital entry', async (t) => {
  const { cockpit } = fixture(t);
  cockpit.syncEntry();
  await nextTick();
  assert.equal(cockpit.presence.entryAvailable, true);
  assert.equal(cockpit.presence.entryKind, 'satellite');
  assert.equal(cockpit.presence.tr3b, null, 'TR-3B stays aircraft-only');
});

test('a shut orbit gate offers no entry and refuses entry', async (t) => {
  const { cockpit } = fixture(t, { orbitAllowed: false });
  cockpit.syncEntry();
  await nextTick();
  assert.equal(cockpit.presence.entryAvailable, false);
  assert.equal(cockpit.enter(), false);
  assert.equal(cockpit.active, false);
});

test('entry rides the orbital view; voice-style aircraft entry refuses it', async (t) => {
  const { $, cockpit } = fixture(t);
  assert.equal(cockpit.enter({ kind: 'aircraft' }), false);
  cockpit.syncEntry();
  await nextTick();
  cockpit.enter();
  assert.equal(cockpit.active, true);
  assert.equal(cockpit.subjectKind, 'satellite');
  $('#map-view-switch').click();
  assert.equal(cockpit.active, false);
});

test('C neither enters nor leaves the orbital view', async (t) => {
  const { cockpit } = fixture(t);
  const outside = press(cockpit, 'c');
  assert.equal(cockpit.active, false, 'C does not enter');
  assert.equal(outside.defaultPrevented, false);
  assert.equal(cockpit.enter(), true);
  await settle();
  const inside = press(cockpit, 'c');
  assert.equal(cockpit.active, true, 'C does not exit');
  assert.equal(inside.defaultPrevented, false);
});

test('entering takes the camera and shows only the orbital HUD', async (t) => {
  const { $, cockpit, viewer, satellites, store, events } = await orbitAt(t);
  assert.equal(cockpit.subjectKind, 'satellite');
  assert.equal(cockpit.subjectId, ISS.noradId);
  assert.deepEqual(satellites.calls, [['subject', ISS.noradId]]);
  assert.equal(followedOf(viewer), null);
  assert.equal(viewer.scene.screenSpaceCameraController.enableInputs, false);
  assert.ok(document.body.classList.contains('cockpit-mode'));
  assert.ok(document.body.classList.contains('cockpit-orbit'));
  assert.ok(!document.body.classList.contains('cockpit-bridge'));
  assert.deepEqual(events.at(-1), {
    active: true,
    subjectId: String(ISS.noradId),
    layerId: 'satellites',
  });

  const hud = $('#cockpit-hud');
  assert.equal(hud.getAttribute('data-subject'), 'satellite');
  assert.equal(hud.getAttribute('data-layer'), 'satellites');
  assert.equal(hud.getAttribute('aria-label'), 'Satellite orbital view');
  assert.equal($('#cockpit-orbital').hidden, false);
  assert.match($('.cockpit-orbital-name').textContent, /ISS \(ZARYA\)/);
  for (const selector of [
    '.cockpit-compass',
    '#cockpit-speed-rim',
    '#cockpit-altitude-rim',
    '.cockpit-visor-shell',
    '.cockpit-scan-array',
    '.cockpit-frame-lines',
    '.cockpit-reticle',
    '.cockpit-radar-console',
    '.cockpit-look',
    '.cockpit-position-readout',
  ])
    assert.equal($(selector), null, `${selector} is hidden in orbit`);
  assert.equal($('#cockpit-route').hidden, true, 'no flight plan in orbit');
  assert.equal(store.presence.context, false, 'no Contact card in orbit');
  assert.ok($('#cockpit-vision-current'), 'vision styles stay');
  assert.ok($('#cockpit-reset-globe'), 'reset stays');
  const exit = $('#map-view-switch');
  assert.equal(exit.hidden, false);
  assert.equal(exit.getAttribute('aria-label'), 'Exit orbital view');
  assert.match(exit.textContent, /EXIT ORBIT/);
  assert.match($('.cockpit-help').textContent, /\+\/− ZOOM/);
  assert.equal(store.orbital.name, ISS.name);
  assert.equal(store.orbital.zoom, 1);
  assert.deepEqual(store.orbital.zoomSteps, [1, 2, 4, 8]);
  assert.ok(store.orbital.footprintKm > 0);
});

test('the camera sits on the satellite looking at the Earth centre, north up', async (t) => {
  const { cockpit, shots, clock } = await orbitAt(t);
  const count = shots.length;
  clock.advance(16);
  cockpit.update();
  clock.advance(16);
  cockpit.update();
  assert.equal(shots.length, count + 2, 'a camera update every frame');
  const shot = shots.at(-1);
  const position = satellitePosition();
  assert.ok(Cesium.Cartesian3.equalsEpsilon(shot.destination, position, 1e-6));
  const toCentre = Cesium.Cartesian3.negate(
    Cesium.Cartesian3.normalize(position, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  near(angleDeg(shot.direction, toCentre), 0, 'looks at the centre', 1e-9);
  near(Cesium.Cartesian3.dot(shot.direction, shot.up), 0, 'up ⟂ view', 1e-9);
  // Local north at the sub-satellite point (geodetic, so within a few
  // tenths of a degree of the geocentric north the camera uses).
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(position);
  const north = Cesium.Matrix4.multiplyByPointAsVector(
    enu,
    new Cesium.Cartesian3(0, 1, 0),
    new Cesium.Cartesian3(),
  );
  assert.ok(angleDeg(shot.up, north) < 0.5, 'north is at the top');
});

test('each zoom step sets the field of view; exit restores it exactly', async (t) => {
  const { $, cockpit, viewer, store, satellites } = await orbitAt(t);
  const frustum = viewer.camera.frustum;
  near(frustum.fov, frustumFovAt(1), '1x');
  const zoomIn = $('#cockpit-orbital-zoom-in');
  const zoomOut = $('#cockpit-orbital-zoom-out');
  assert.equal(zoomOut.disabled, true, 'widest step');
  const footprint1 = store.orbital.footprintKm;

  assert.equal(press(cockpit, '+').defaultPrevented, true);
  near(frustum.fov, frustumFovAt(2), '2x by +');
  assert.equal(store.orbital.zoom, 2);
  assert.ok(store.orbital.footprintKm < footprint1, 'a narrower swath');
  press(cockpit, '=');
  near(frustum.fov, frustumFovAt(4), '4x by =');
  zoomIn.click();
  await settle();
  near(frustum.fov, frustumFovAt(8), '8x by the button');
  assert.equal(store.orbital.zoom, 8);
  assert.equal(zoomIn.disabled, true, 'tightest step');
  press(cockpit, '+');
  zoomIn.click();
  assert.equal(store.orbital.zoom, 8, '8x is the limit');

  press(cockpit, '-');
  near(frustum.fov, frustumFovAt(4), '4x by -');
  press(cockpit, '_');
  near(frustum.fov, frustumFovAt(2), '2x by _');
  zoomOut.click();
  await settle();
  assert.equal(store.orbital.zoom, 1);
  zoomOut.click();
  press(cockpit, '-');
  assert.equal(store.orbital.zoom, 1, '1x is the limit');

  press(cockpit, '+');
  cockpit.exit();
  await settle();
  assert.equal(frustum.fov, SAVED_FOV, 'the original field of view, exactly');
  assert.equal(store.orbital, null);
  assert.deepEqual(satellites.calls, [
    ['subject', ISS.noradId],
    ['subject', null],
    ['refocus', ISS.noradId],
  ]);
  assert.ok(!document.body.classList.contains('cockpit-orbit'));
});

test('a zoom step animates with blur and a lock tick', async (t) => {
  const { cockpit, viewer, store, clock } = await orbitAt(t, {
    reducedMotion: false,
  });
  const frustum = viewer.camera.frustum;
  press(cockpit, '+');
  assert.equal(store.orbital.zoom, 2);
  assert.equal(store.orbital.transition.active, true);
  near(frustum.fov, frustumFovAt(1), 'the step starts at 1x');
  clock.advance(ORBITAL_ZOOM_TRANSITION_MS / 2);
  cockpit.update();
  assert.equal(store.orbital.transition.active, true);
  assert.ok(store.orbital.transition.blurPx > 0, 'focus pull mid-step');
  assert.ok(frustum.fov < frustumFovAt(1) && frustum.fov > frustumFovAt(2));
  clock.advance(ORBITAL_ZOOM_TRANSITION_MS / 2 + 10);
  cockpit.update();
  assert.equal(store.orbital.transition.active, false);
  assert.equal(store.orbital.transition.lockTick, true, 'lock tick on arrival');
  near(frustum.fov, frustumFovAt(2), 'settled at 2x');
  clock.advance(1000);
  cockpit.update();
  assert.deepEqual(store.orbital.transition, {
    active: false,
    blurPx: 0,
    lockTick: false,
  });
});

test('a zoom step holds a soft focus until its imagery loads', async (t) => {
  const { cockpit, viewer, store, clock } = await orbitAt(t, {
    reducedMotion: false,
  });
  viewer.scene.globe = { show: true, tilesLoaded: false };
  press(cockpit, '+');
  clock.advance(ORBITAL_ZOOM_TRANSITION_MS + 10);
  cockpit.update();
  near(viewer.camera.frustum.fov, frustumFovAt(2), 'the move is over');
  assert.deepEqual(store.orbital.transition, {
    active: true,
    blurPx: ORBITAL_SETTLE_BLUR_PX,
    lockTick: false,
  });
  clock.advance(500);
  cockpit.update();
  assert.equal(store.orbital.transition.active, true, 'still loading');
  viewer.scene.globe.tilesLoaded = true;
  clock.advance(16);
  cockpit.update();
  assert.equal(store.orbital.transition.active, false);
  assert.equal(store.orbital.transition.lockTick, true, 'locks on arrival');
  clock.advance(1000);
  cockpit.update();
  assert.equal(store.orbital.transition.lockTick, false);
});

test('a zoom step stops waiting for imagery after the cap', async (t) => {
  const { cockpit, viewer, store, clock } = await orbitAt(t, {
    reducedMotion: false,
  });
  // The camera outruns the tiles: they never finish.
  viewer.scene.globe = { show: true, tilesLoaded: false };
  press(cockpit, '+');
  clock.advance(ORBITAL_ZOOM_TRANSITION_MS + 10);
  cockpit.update();
  assert.equal(store.orbital.transition.active, true);
  clock.advance(ORBITAL_SETTLE_MAX_MS);
  cockpit.update();
  assert.equal(store.orbital.transition.active, false);
  assert.equal(store.orbital.transition.lockTick, true);
});

test('reduced motion cuts a zoom step at once', async (t) => {
  const { cockpit, viewer, store } = await orbitAt(t, { reducedMotion: true });
  press(cockpit, '+');
  near(viewer.camera.frustum.fov, frustumFovAt(2), 'instant 2x');
  assert.deepEqual(store.orbital.transition, {
    active: false,
    blurPx: 0,
    lockTick: false,
  });
});

/** The view's tilt from the nadir camera of the same frame, degrees. */
function offNadir(shot) {
  const toCentre = Cesium.Cartesian3.negate(
    Cesium.Cartesian3.normalize(shot.destination, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  return angleDeg(shot.direction, toCentre);
}

test('arrows tilt the view off nadir in 5° steps up to 45°, Home returns', async (t) => {
  const { $, cockpit, store, shots, clock } = await orbitAt(t);
  const frame = () => {
    clock.advance(16);
    cockpit.update();
    return shots.at(-1);
  };
  const position = satellitePosition();
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(position);
  const axis = (x, y) =>
    Cesium.Matrix4.multiplyByPointAsVector(
      enu,
      new Cesium.Cartesian3(x, y, 0),
      new Cesium.Cartesian3(),
    );
  const north = axis(0, 1);
  const east = axis(1, 0);

  assert.equal(press(cockpit, 'ArrowUp').defaultPrevented, true);
  press(cockpit, 'ArrowUp');
  let shot = frame();
  near(offNadir(shot), 10, 'two steps north', 1e-6);
  assert.ok(Cesium.Cartesian3.dot(shot.direction, north) > 0, 'toward north');
  near(
    Math.abs(Cesium.Cartesian3.dot(shot.direction, east)),
    0,
    'no east',
    1e-3,
  );
  await settle();
  assert.equal(store.orbital.look.offset, true);
  assert.equal(store.orbital.footprintKm, null, 'no nadir swath off nadir');
  assert.equal(
    $('#cockpit-orbital-look-readout').textContent,
    'OFF-NADIR 10.0° · N 10°',
  );
  // The swath stays, approximate: the width at the tilted view's centre.
  const cos = (deg) => Math.cos(Cesium.Math.toRadians(deg));
  near(store.orbital.look.swathScale, 1 / cos(10), 'along the frame', 1e-9);
  const swathKm = () =>
    Number($('.cockpit-orbital-swath').textContent.match(/≈ ([\d.]+) KM/)[1]);
  const tiltedKm = swathKm();
  assert.ok(tiltedKm > 0);

  for (let step = 0; step < 3; step += 1) press(cockpit, 'ArrowRight');
  shot = frame();
  const expected = Cesium.Math.toDegrees(
    Math.acos(
      Math.cos(Cesium.Math.toRadians(10)) * Math.cos(Cesium.Math.toRadians(15)),
    ),
  );
  near(offNadir(shot), expected, 'north 10° and east 15°', 1e-6);
  assert.ok(Cesium.Cartesian3.dot(shot.direction, east) > 0, 'toward east');
  await settle();
  assert.equal(
    $('#cockpit-orbital-look-readout').textContent,
    'OFF-NADIR 18.0° · N 10° · E 15°',
  );
  // Tilting across the frame widens it faster: 1/cos² east.
  near(
    store.orbital.look.swathScale,
    1 / (cos(10) * cos(15) ** 2),
    'across the frame',
    1e-9,
  );
  assert.ok(swathKm() > tiltedKm, 'the swath grows with the tilt');

  // Shift takes no 45° step in orbit, and a held arrow repeats.
  press(cockpit, 'ArrowLeft', { shiftKey: true });
  assert.deepEqual(cockpit.orbital.lookTarget, { yawDeg: 10, pitchDeg: 10 });
  for (let step = 0; step < 20; step += 1)
    press(cockpit, 'ArrowDown', { repeat: step > 0 });
  for (let step = 0; step < 20; step += 1)
    press(cockpit, 'ArrowLeft', { repeat: step > 0 });
  assert.deepEqual(cockpit.orbital.lookTarget, { yawDeg: -45, pitchDeg: -45 });
  shot = frame();
  const clamped = Cesium.Math.toDegrees(
    Math.acos(Math.cos(Cesium.Math.toRadians(45)) ** 2),
  );
  near(offNadir(shot), clamped, 'clamped at 45° on each axis', 1e-6);
  assert.ok(Cesium.Cartesian3.dot(shot.direction, north) < 0, 'toward south');
  assert.ok(Cesium.Cartesian3.dot(shot.direction, east) < 0, 'toward west');

  press(cockpit, 'Home');
  shot = frame();
  near(offNadir(shot), 0, 'Home returns to nadir', 1e-9);
  await settle();
  assert.equal(store.orbital.look.offset, false);
  assert.equal($('.cockpit-orbital-look'), null, 'no readout at nadir');
  assert.ok(store.orbital.footprintKm > 0, 'the nadir swath is back');
  assert.equal(store.orbital.look.swathKm, null);
  assert.equal(store.orbital.look.swathScale, 1);
  assert.match($('.cockpit-orbital-swath').textContent, /^SWATH \d+ KM$/);

  press(cockpit, 'ArrowRight');
  await settle();
  frame();
  $('#cockpit-orbital-nadir').click();
  shot = frame();
  near(offNadir(shot), 0, 'NADIR returns to nadir', 1e-9);
  press(cockpit, 'ArrowUp');
  press(cockpit, '0');
  near(offNadir(frame()), 0, '0 returns to nadir', 1e-9);
});

test('tilt and zoom keys leave fields, sliders and open utilities alone', async (t) => {
  const { cockpit, store } = await orbitAt(t);
  const input = document.body.appendChild(document.createElement('input'));
  const slider = document.body.appendChild(document.createElement('div'));
  slider.setAttribute('role', 'slider');
  for (const target of [input, slider]) {
    for (const key of ['ArrowUp', '+', '-', 'Home'])
      assert.equal(press(cockpit, key, { target }).defaultPrevented, false);
  }
  cockpit.isUtilityDisclosureOpen = () => true;
  assert.equal(press(cockpit, 'ArrowUp').defaultPrevented, false);
  assert.equal(press(cockpit, '+').defaultPrevented, false);
  assert.equal(store.orbital.zoom, 1);
  assert.deepEqual(cockpit.orbital.lookTarget, { yawDeg: 0, pitchDeg: 0 });
});

test('losing the satellite ends the view without refocusing it', async (t) => {
  const { cockpit, viewer, satellites, store, clock } = await orbitAt(t);
  press(cockpit, '+');
  satellites.drop();
  clock.advance(16);
  cockpit.update();
  assert.equal(cockpit.active, false);
  assert.equal(viewer.camera.frustum.fov, SAVED_FOV);
  assert.equal(store.orbital, null);
  assert.deepEqual(satellites.calls, [
    ['subject', ISS.noradId],
    ['subject', null],
  ]);
});

test('tracking an aircraft from orbit ends the view and keeps that tracking', async (t) => {
  const { cockpit, viewer, satellites, aircraft, clock } = await orbitAt(t);
  followEntity(viewer, aircraft);
  clock.advance(16);
  cockpit.update();
  assert.equal(cockpit.active, false);
  assert.equal(followedEntity(viewer), aircraft);
  assert.ok(!satellites.calls.some(([call]) => call === 'refocus'));
});

test('contact navigation stays with the satellite', async (t) => {
  const { cockpit } = await orbitAt(t);
  assert.equal(cockpit.navigateContext(1), false);
  assert.equal(cockpit.subjectKind, 'satellite');
});

test('+ and − mean nothing new in an aircraft cockpit or on a bridge', async (t) => {
  const aircraftInfo = {
    icao24: 'abc123',
    callsign: 'TEST1',
    latitude: 54.5,
    longitude: 10.2,
    altitudeM: 3000,
    velocityMps: 200,
    track: 45,
    onGround: false,
  };
  const air = fixture(t, { satellite: null, aircraftInfo });
  followEntity(air.viewer, air.aircraft);
  assert.equal(air.cockpit.enter({ kind: 'aircraft' }), true);
  for (const key of ['+', '=', '-', '_'])
    assert.equal(press(air.cockpit, key).defaultPrevented, false, key);
  assert.equal(air.viewer.camera.frustum.fov, SAVED_FOV);
  assert.equal(air.cockpit.orbital, null);
  assert.equal(air.store.orbital, null);
  air.cockpit.exit();
  assert.equal(air.viewer.camera.frustum.fov, SAVED_FOV);

  const vessel = {
    mmsi: '211000000',
    name: 'NORDIC STAR',
    type: '70',
    destination: 'KIEL',
    lat: 54.5,
    lon: 10.2,
    speed: 12,
    course: 95,
    heading: 90,
    lastPositionEpoch: null,
    missedRefreshes: 0,
  };
  const bridge = fixture(t, { satellite: null, vessel });
  assert.equal(bridge.cockpit.enter(), true);
  assert.equal(bridge.cockpit.subjectKind, 'vessel');
  for (const key of ['+', '=', '-', '_'])
    assert.equal(press(bridge.cockpit, key).defaultPrevented, false, key);
  assert.equal(bridge.viewer.camera.frustum.fov, SAVED_FOV);
  // The bridge's own arrows still turn its view.
  press(bridge.cockpit, 'ArrowRight');
  assert.equal(bridge.cockpit.lookTarget.yawDeg, 5);
  assert.equal(bridge.cockpit.orbital, null);
});

test('orbit opens in the optical picture whatever style the map is in', async (t) => {
  const { cockpit, events } = fixture(t);
  const modes = [];
  cockpit.getInitialVisionMode = () => 'nvg';
  cockpit.setVisionMode = (mode) => modes.push(mode);
  assert.equal(cockpit.enter(), true);
  await settle();
  assert.deepEqual(modes, ['optical']);
  // The cloud pass reads the layer to stay off in orbit.
  assert.equal(events.at(-1).layerId, 'satellites');
});

test('orbit leases flat imagery on entry and hands the map back on exit', async (t) => {
  const { cockpit } = fixture(t);
  const calls = [];
  cockpit.services.acquireOrbitImagery = () => {
    calls.push('acquire');
    return {
      ready: Promise.resolve({ status: 'ready' }),
      release: () => {
        calls.push('release');
        return Promise.resolve();
      },
    };
  };
  assert.equal(cockpit.enter(), true);
  await settle();
  assert.deepEqual(calls, ['acquire']);
  cockpit.exit();
  await settle();
  assert.deepEqual(calls, ['acquire', 'release']);
});

test('a map already leased elsewhere does not keep orbit out', async (t) => {
  const { cockpit, store } = fixture(t);
  cockpit.services.acquireOrbitImagery = () => {
    throw new Error('Imagery comparison is already held by recent-imagery');
  };
  assert.equal(cockpit.enter(), true);
  await settle();
  assert.ok(store.orbital, 'the orbital HUD is up');
  cockpit.exit();
  await settle();
  assert.equal(store.orbital, null);
});

/**
 * A double-click `offsetPx` from where the followed satellite is drawn, at
 * (400, 300) on the canvas, through Cesium's double-click handler.
 */
function doubleClickNearSatellite(scene, offsetPx) {
  const { viewer, input, stockHeld } = scene;
  viewer.scene.cartesianToCanvasCoordinates = (position, result) =>
    position ? Object.assign(result, { x: 400, y: 300 }) : undefined;
  const handler = viewer.screenSpaceEventHandler;
  const before = handler.stockCalls;
  const position = { x: 400 + offsetPx, y: 300 };
  input.tap(position);
  input.down(position);
  input.up(position);
  // The renderer's own follow runs unless the second press held it off.
  if (!stockHeld()) handler.doubleClick(position);
  input.dblclick(position);
  return { stock: handler.stockCalls > before };
}

test('double-clicking the followed satellite enters the orbital view', async (t) => {
  const scene = fixture(t);
  const { store } = scene;
  const miss = doubleClickNearSatellite(scene, 60);
  assert.equal(miss.stock, true, 'a double-click elsewhere goes to Cesium');
  assert.equal(store.orbital, null);
  const hit = doubleClickNearSatellite(scene, 20);
  assert.equal(hit.stock, false, 'Cesium never sees it');
  await settle();
  assert.ok(store.orbital, 'the orbital HUD is up');
  assert.equal(
    doubleClickNearSatellite(scene, 0).stock,
    true,
    'inside, a double-click is not the entry',
  );
});

test('a double-click a tool owns, or one the gate refuses, does not enter', async (t) => {
  const scene = fixture(t, { orbitAllowed: false });
  const { cockpit, store } = scene;
  // On the track but refused: no entry, and no untracking either.
  assert.equal(doubleClickNearSatellite(scene, 0).stock, false);
  assert.equal(store.orbital, null);
  cockpit.isOrbitEntryAllowed = () => true;
  // Drawing ends a shape with a double-click.
  const lease = claimPointer('draw');
  t.after(() => releasePointer(lease));
  doubleClickNearSatellite(scene, 0);
  assert.equal(store.orbital, null);
  releasePointer(lease);
  doubleClickNearSatellite(scene, 0);
  await settle();
  assert.ok(store.orbital);
});

test('a double-click on the followed aircraft model enters instead of untracking', async (t) => {
  const aircraftInfo = {
    icao24: 'abc123',
    callsign: 'TEST1',
    latitude: 54.5,
    longitude: 10.2,
    altitudeM: 3000,
    velocityMps: 200,
    track: 45,
    onGround: false,
  };
  const scene = fixture(t, { aircraftInfo });
  const { viewer, aircraft, store } = scene;
  followEntity(viewer, aircraft);
  // The model is a primitive, not an Entity: Cesium's own double-click
  // would untrack it.
  doubleClickNearSatellite(scene, 0);
  await settle();
  assert.equal(viewer.screenSpaceEventHandler.stockCalls, 0);
  assert.equal(store.presence.active, true, 'the cockpit is entered');
});

test('the Cockpit hands the double-click back to Cesium when it stops', async (t) => {
  const scene = fixture(t);
  const { cockpit, viewer } = scene;
  cockpit.stop();
  doubleClickNearSatellite(scene, 0);
  assert.equal(viewer.screenSpaceEventHandler.stockCalls, 1);
});

test('orbit publishes the place below and who owns the satellite', async (t) => {
  const satellite = {
    ...ISS,
    cosparId: '1998-067A',
    tle: { line1: '1 25544U', line2: '2 25544', epochMs: 0 },
    owner: { countryCode: null, label: 'ISS partners' },
    operator: 'NASA/Multinational',
  };
  const clock = manualClock(t);
  const { cockpit, store } = fixture(t, { satellite });
  const asked = [];
  cockpit.services.placeBelow = async (lat, lon) => {
    asked.push([lat, lon]);
    return { kind: 'country', name: 'United States', countryCode: 'US' };
  };
  assert.equal(cockpit.enter(), true);
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(asked, [[30, -97]], 'one offline lookup on entry');
  assert.deepEqual(store.orbital.place, {
    kind: 'country',
    name: 'United States',
    countryCode: 'US',
  });
  assert.equal(store.orbital.noradId, 25544);
  assert.equal(store.orbital.cosparId, '1998-067A');
  assert.equal(store.orbital.operator, 'NASA/Multinational');
  assert.deepEqual(store.orbital.owner, satellite.owner);
  assert.equal(store.orbital.tle.line1, '1 25544U');
  // The same ground point a frame later asks nothing new.
  clock.advance(16);
  cockpit.update();
  await settle();
  assert.equal(asked.length, 1);
  cockpit.exit();
  await settle();
  assert.equal(store.orbital, null);
});

test('from 8x the place lookup asks for the populated place in view', async (t) => {
  const clock = manualClock(t);
  const { cockpit, store } = fixture(t);
  const asked = [];
  cockpit.services.placeBelow = async (lat, lon, options) => {
    asked.push(options?.nearKm ?? null);
    return {
      kind: 'country',
      name: 'United States',
      countryCode: 'US',
      division: 'Texas',
      near: options?.nearKm ? 'Austin' : null,
    };
  };
  assert.equal(cockpit.enter(), true);
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(asked, [null], 'no city at 1x');
  press(cockpit, '+');
  press(cockpit, '+');
  assert.equal(store.orbital.zoom, 4);
  clock.advance(100);
  cockpit.update();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(asked, [null], 'below 8x nothing new to ask');
  press(cockpit, '+');
  assert.equal(store.orbital.zoom, 8);
  // The next HUD beat asks at once, without waiting out the 2 s gate.
  clock.advance(100);
  cockpit.update();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(asked.length, 2);
  // Half the view's height, the smaller side of a 16:9 window.
  const halfHeightKm = store.orbital.footprintKm / 2 / ASPECT;
  near(asked[1], halfHeightKm, 'half the view height', halfHeightKm * 2e-3);
  await settle();
  assert.equal(store.orbital.place.near, 'Austin');
});

test('a place that lands after the exit is dropped', async (t) => {
  const { cockpit, store } = fixture(t);
  let answer;
  cockpit.services.placeBelow = () =>
    new Promise((resolve) => {
      answer = resolve;
    });
  assert.equal(cockpit.enter(), true);
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 0));
  cockpit.exit();
  await settle();
  answer({ kind: 'ocean', name: 'Late Ocean', countryCode: null });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(store.orbital, null, 'no HUD comes back for a stale answer');
});

test('an aircraft and a satellite first seen in one sync: the aircraft takes entry, by the fixed order', async (t) => {
  const aircraftInfo = {
    icao24: 'abc123',
    callsign: 'TEST1',
    latitude: 54.5,
    longitude: 10.2,
    altitudeM: 3000,
    velocityMps: 200,
    track: 45,
    onGround: false,
  };
  const { cockpit, viewer, aircraft, store } = fixture(t, { aircraftInfo });
  followEntity(viewer, aircraft);
  // The satellite and the aircraft are both new to this sync; the fixed order
  // decides between subjects first seen together. Selected one after the
  // other, the later one takes entry (cockpitEntryGate.test.mjs).
  cockpit.syncEntry();
  assert.equal(store.presence.entryKind, 'aircraft');
});

/** An imaging satellite with a narrow confirmed sensor swath. */
const WORLDVIEW = Object.freeze({
  ...ISS,
  id: '40115',
  noradId: 40115,
  name: 'WORLDVIEW-3 (WV-3)',
  satelliteClass: 'imaging',
  classLabel: 'IMAGING',
  altitudeM: 617_000,
  // A sun-synchronous pass: the strip runs along this track.
  groundTrackDeg: 190,
  sensor: Object.freeze({
    label: 'WorldView-3',
    narrowestSwathKm: 13.1,
    swathConfirmed: true,
  }),
});

/** A wide-area imager whose swath fits inside 8x. */
const LANDSAT = Object.freeze({
  ...WORLDVIEW,
  id: '49260',
  noradId: 49260,
  name: 'LANDSAT 9',
  altitudeM: 705_000,
  sensor: Object.freeze({
    label: 'Landsat 8 / Landsat 9',
    narrowestSwathKm: 185,
    swathConfirmed: true,
  }),
});

test('an imaging satellite zooms past 8x as far as its sensor swath', async (t) => {
  const { $, cockpit, store } = await orbitAt(t, { satellite: WORLDVIEW });
  assert.equal(store.orbital.maxZoom, 64);
  assert.deepEqual(store.orbital.zoomSteps, [1, 2, 4, 8, 16, 32, 64]);
  for (let step = 0; step < 8; step += 1) press(cockpit, '+');
  assert.equal(store.orbital.zoom, 64, 'stops at the cap');
  await settle();
  assert.equal($('#cockpit-orbital-zoom-in').disabled, true);
  assert.match($('.cockpit-orbital-zoom').textContent, /64×/);
  // The swath, to scale: 13.1 km of a ~20 km view.
  assert.match(
    $('.cockpit-orbital-sensor-swath').textContent,
    /SENSOR SWATH 13\.1 KM/,
  );
  const width = parseFloat($('.cockpit-orbital-sensor-strip').style.width);
  assert.ok(width > 50 && width < 100, String(width));
  // The swath is narrower than the 64x view: no SENSOR step to take.
  assert.equal($('#cockpit-orbital-sensor'), null);
});

test("the SENSOR step frames a wide sensor's swath", async (t) => {
  const { $, cockpit, store } = await orbitAt(t, { satellite: LANDSAT });
  assert.equal(store.orbital.maxZoom, 8, 'a wide swath adds no steps');
  await settle();
  const button = $('#cockpit-orbital-sensor');
  assert.ok(button, 'the SENSOR step is offered');
  assert.equal(button.getAttribute('aria-keyshortcuts'), null, 'no key');
  assert.doesNotMatch(button.title, /\(S\)/);
  button.click();
  const zoom = store.orbital.zoom;
  assert.ok(zoom > 4 && zoom < 8, String(zoom));
  assert.ok(Math.abs(store.orbital.footprintKm - 185) < 1, 'view = swath');
  await settle();
  assert.match($('.cockpit-orbital-zoom').textContent, /ZOOM \d\.\d×/);
  press(cockpit, '+');
  assert.equal(store.orbital.zoom, 8, 'on to the step above');
  press(cockpit, '-');
  press(cockpit, '-');
  assert.equal(store.orbital.zoom, 2);
  $('#cockpit-orbital-sensor').click();
  assert.equal(store.orbital.zoom, zoom, 'the button takes it again');
});

test('off nadir the sensor strip stays and its swath reads approximate', async (t) => {
  const { $, cockpit, store } = await orbitAt(t, { satellite: LANDSAT });
  await settle();
  assert.equal(
    $('.cockpit-orbital-sensor-swath').textContent,
    'SENSOR SWATH 185 KM',
  );
  const nadirWidth = $('.cockpit-orbital-sensor-strip').style.width;
  press(cockpit, 'ArrowRight');
  press(cockpit, 'ArrowRight');
  await settle();
  assert.equal(store.orbital.look.offset, true);
  // Across the frame by 10°: 185 km / cos² 10° ≈ 190.8 km.
  const text = $('.cockpit-orbital-sensor-swath').textContent;
  const km = Number(text.match(/^SENSOR SWATH ≈ ([\d.]+) KM$/)[1]);
  assert.ok(Math.abs(km - 185 / Math.cos((10 * Math.PI) / 180) ** 2) < 0.1);
  assert.equal(
    $('.cockpit-orbital-sensor-strip').style.width,
    nadirWidth,
    'the strip keeps its share of the view',
  );
  assert.equal($('#cockpit-orbital-sensor'), null, 'no SENSOR step tilted');
  press(cockpit, 'Home');
  await settle();
  assert.equal(
    $('.cockpit-orbital-sensor-swath').textContent,
    'SENSOR SWATH 185 KM',
  );
  assert.ok($('#cockpit-orbital-sensor'));
});

test('S does nothing in an orbital view, even with a SENSOR step', async (t) => {
  const { $, cockpit, store } = await orbitAt(t, { satellite: LANDSAT });
  await settle();
  assert.ok($('#cockpit-orbital-sensor'), 'the SENSOR step is offered');
  for (const key of ['s', 'S']) {
    const event = press(cockpit, key, { shiftKey: key === 'S' });
    assert.equal(event.defaultPrevented, false, key);
    assert.equal(store.orbital.zoom, 1, key);
  }
  assert.doesNotMatch(
    document.querySelector('.cockpit-help')?.textContent ?? '',
    /SENSOR/,
    'no key hint',
  );
});

test('the sensor strip follows the view through a zoom step, not ahead of it', async (t) => {
  const { cockpit, store, clock } = await orbitAt(t, {
    satellite: WORLDVIEW,
    reducedMotion: false,
  });
  const strip = () => store.orbital.sensor.stripFraction;
  const atOne = strip();
  assert.ok(atOne > 0 && atOne < 1);
  press(cockpit, '+');
  cockpit.update();
  near(strip(), atOne, 'the step starts at 1x, and so does the strip');
  clock.advance(ORBITAL_ZOOM_TRANSITION_MS / 2);
  cockpit.update();
  const midway = strip();
  clock.advance(ORBITAL_ZOOM_TRANSITION_MS + 1000);
  cockpit.update();
  const atTwo = strip();
  assert.ok(atTwo > atOne * 1.5, 'twice the zoom, about twice the share');
  assert.ok(midway > atOne && midway < atTwo, 'part-way through the step');
});

test('an unconfirmed sensor swath is drawn but adds no zoom steps', async (t) => {
  const { store } = await orbitAt(t, {
    satellite: {
      ...WORLDVIEW,
      sensor: {
        label: 'SuperView Neo-1',
        narrowestSwathKm: 12,
        swathConfirmed: false,
      },
    },
  });
  assert.equal(store.orbital.maxZoom, 8);
  assert.equal(store.orbital.sensor.swathKm, 12);
});

test('the wheel steps the orbital zoom one notch at a time', async (t) => {
  const { cockpit, store, clock } = await orbitAt(t, { satellite: WORLDVIEW });
  const wheel = (deltaY) => {
    const event = {
      deltaY,
      deltaMode: 0,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    cockpit.onOrbitalWheel(event);
    return event;
  };
  assert.equal(wheel(-100).defaultPrevented, true);
  assert.equal(store.orbital.zoom, 2);
  // The same notch's trailing events do nothing.
  assert.equal(wheel(-100).defaultPrevented, false);
  assert.equal(store.orbital.zoom, 2);
  clock.advance(300);
  wheel(-100);
  assert.equal(store.orbital.zoom, 4);
  clock.advance(300);
  wheel(120);
  assert.equal(store.orbital.zoom, 2, 'toward the viewer zooms out');
  // A tool that owns the pointer keeps the wheel.
  const lease = claimPointer('measure');
  t.after(() => releasePointer(lease));
  clock.advance(300);
  wheel(-100);
  assert.equal(store.orbital.zoom, 2);
  releasePointer(lease);
  cockpit.exit();
  await settle();
  assert.equal(cockpit.onOrbitalWheel({ deltaY: -100 }), false, 'orbit only');
});

test('the orbital view reads the TLE age on each HUD publish', async (t) => {
  const HOUR = 3_600_000;
  const { cockpit, store, clock } = await orbitAt(t, {
    satellite: {
      ...ISS,
      tle: {
        line1: '1 25544U',
        line2: '2 25544',
        epochMs: START_MS - 13.5 * HOUR,
      },
    },
  });
  const ageH = () => store.orbital.tleAgeMs / HOUR;
  assert.ok(Math.abs(ageH() - 13.5) < 0.01, String(ageH()));
  clock.advance(HOUR);
  cockpit.update();
  assert.ok(Math.abs(ageH() - 14.5) < 0.01, 'kept current by the HUD cadence');
});

/** The ISS climbing north-east along its ground track. */
const ISS_ON_TRACK = Object.freeze({ ...ISS, groundTrackDeg: 52 });

test('the camera turns to the ground track, so the picture scrolls along it', async (t) => {
  const { $, cockpit, shots, clock, store } = await orbitAt(t, {
    satellite: ISS_ON_TRACK,
  });
  clock.advance(16);
  cockpit.update();
  await settle();
  const shot = shots.at(-1);
  const position = satellitePosition();
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(position);
  const along = (bearingDeg) => {
    const θ = Cesium.Math.toRadians(bearingDeg);
    return Cesium.Matrix4.multiplyByPointAsVector(
      enu,
      new Cesium.Cartesian3(Math.sin(θ), Math.cos(θ), 0),
      new Cesium.Cartesian3(),
    );
  };
  assert.ok(angleDeg(shot.up, along(52)) < 0.5, 'the track is at the top');
  assert.equal(store.orbital.trackUp, true);
  near(store.orbital.northDeg, 308, 'north sits 52° left of the top', 1e-9);
  assert.match($('.cockpit-orbital-north').textContent, /TRACK UP/);
  assert.match(
    $('.cockpit-orbital-north-pointer').style.transform,
    /rotate\(308\.0deg\)/,
  );
  assert.match(
    $('.cockpit-orbital-north-letter').style.transform,
    /rotate\(-308\.0deg\)/,
    'the N stays upright',
  );
  // A tilt runs along and across the track, and says so.
  press(cockpit, 'ArrowUp');
  await settle();
  assert.match(store.orbital.look.readout, /FWD 5°/);
});

test('a satellite with no ground track stays north-up', async (t) => {
  const { $, store } = await orbitAt(t);
  assert.equal(store.orbital.trackUp, false);
  assert.equal(store.orbital.northDeg, 0);
  assert.match($('.cockpit-orbital-north').textContent, /NORTH UP/);
});

test('a narrower window pulls the zoom back to the new top step', async (t) => {
  const { cockpit, viewer, store, clock } = await orbitAt(t, {
    satellite: WORLDVIEW,
  });
  for (let step = 0; step < 8; step += 1) press(cockpit, '+');
  assert.equal(store.orbital.zoom, 64);
  // A portrait window: the same zoom now shows finer ground than the sensor
  // images, so the top step drops.
  viewer.camera.frustum.aspectRatio = 0.5;
  clock.advance(16);
  cockpit.update();
  await settle();
  assert.ok(store.orbital.maxZoom < 64, String(store.orbital.maxZoom));
  assert.equal(store.orbital.zoom, store.orbital.maxZoom);
  assert.ok(store.orbital.zoomSteps.includes(store.orbital.zoom));
});

test('a zoom button that turns off hands focus to the other one', async (t) => {
  const { $, cockpit } = await orbitAt(t, { satellite: WORLDVIEW });
  await settle();
  $('#cockpit-orbital-zoom-in').focus();
  for (let step = 0; step < 8; step += 1) press(cockpit, '+');
  await settle();
  assert.equal($('#cockpit-orbital-zoom-in').disabled, true);
  assert.equal(document.activeElement?.id, 'cockpit-orbital-zoom-out');
  assert.equal(
    $('#cockpit-orbital-zoom-in').getAttribute('aria-keyshortcuts'),
    '+ =',
  );
  assert.match($('#cockpit-orbital-zoom-in').title, /\(\+\)/);
});

test('SENSOR hands focus to NADIR when a tilt takes it away', async (t) => {
  const { $, cockpit } = await orbitAt(t, { satellite: LANDSAT });
  await settle();
  $('#cockpit-orbital-sensor').focus();
  press(cockpit, 'ArrowUp');
  await settle();
  assert.equal($('#cockpit-orbital-sensor'), null);
  assert.equal(document.activeElement?.id, 'cockpit-orbital-nadir');
});

test('the readout says OFF-NADIR while the view is tilted', async (t) => {
  const { $, cockpit } = await orbitAt(t);
  await settle();
  assert.equal(
    $('.cockpit-orbital-kicker').textContent.trim(),
    'ORBITAL VIEW · NADIR',
  );
  press(cockpit, 'ArrowUp');
  await settle();
  assert.equal(
    $('.cockpit-orbital-kicker').textContent.trim(),
    'ORBITAL VIEW · OFF-NADIR',
  );
});

test('the TLE age is measured from the time the satellite is shown at', async (t) => {
  const DAY = 86_400_000;
  const { store } = await orbitAt(t, {
    satellite: {
      ...ISS,
      // The world clock thirty days back: before the element set's epoch.
      atMs: START_MS - 30 * DAY,
      tle: { line1: '1 25544U', line2: '2 25544', epochMs: START_MS - 2 * DAY },
    },
  });
  assert.ok(Math.abs(store.orbital.tleAgeMs / DAY - 28) < 1e-6);
});

/** A geostationary imager with a 1000 km sensor swath. */
const GEO_IMAGER = Object.freeze({
  ...ISS,
  id: '41866',
  noradId: 41866,
  name: 'GEO IMAGER',
  satelliteClass: 'imaging',
  classLabel: 'IMAGING',
  altitudeM: 35_786_000,
  sensor: Object.freeze({
    label: 'GEO imager',
    narrowestSwathKm: 1000,
    swathConfirmed: true,
  }),
});

test('looking past the limb shows no sensor swath; a GEO view draws no strip', async (t) => {
  const { cockpit, store } = await orbitAt(t, { satellite: GEO_IMAGER });
  assert.ok(store.orbital.sensor, 'the sensor reads at nadir');
  assert.equal(
    store.orbital.sensor.stripFraction,
    null,
    'no ground track, no strip',
  );
  for (let step = 0; step < 3; step += 1) press(cockpit, 'ArrowRight');
  await settle();
  assert.equal(store.orbital.look.swathKm, null);
  assert.equal(store.orbital.sensor, null, 'nothing below to sense');
});

test('a SAR swath reads but draws no strip under nadir', async (t) => {
  const { store } = await orbitAt(t, {
    satellite: {
      ...WORLDVIEW,
      sensor: { ...WORLDVIEW.sensor, type: 'SAR', label: 'SAR' },
    },
  });
  assert.ok(store.orbital.sensor.swathKm > 0);
  assert.equal(store.orbital.sensor.stripFraction, null);
});

test('back to nadir from past the limb, the sensor waits for the view', async (t) => {
  const { cockpit, store, clock } = await orbitAt(t, {
    satellite: GEO_IMAGER,
    reducedMotion: false,
  });
  for (let step = 0; step < 3; step += 1) press(cockpit, 'ArrowRight');
  for (let i = 0; i < 30; i += 1) {
    clock.advance(100);
    cockpit.update();
  }
  await settle();
  assert.equal(store.orbital.sensor, null, 'looking into space');
  press(cockpit, 'Home');
  clock.advance(16);
  cockpit.update();
  await settle();
  assert.equal(store.orbital.sensor, null, 'still easing back');
  for (let i = 0; i < 30; i += 1) {
    clock.advance(100);
    cockpit.update();
  }
  await settle();
  assert.ok(store.orbital.sensor, 'back on the Earth');
});

/** A mount on the station: 20 m from the satellite's position, looking along the track. */
function stationMount() {
  const centre = satellitePosition();
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(centre);
  const axis = (x, y, z) =>
    Cesium.Matrix4.multiplyByPointAsVector(
      enu,
      new Cesium.Cartesian3(x, y, z),
      new Cesium.Cartesian3(),
    );
  const direction = axis(0, 1, 0);
  const up = axis(0, 0, 1);
  return {
    position: Cesium.Cartesian3.add(
      centre,
      Cesium.Cartesian3.multiplyByScalar(up, 20, new Cesium.Cartesian3()),
      new Cesium.Cartesian3(),
    ),
    direction,
    up,
    right: Cesium.Cartesian3.cross(direction, up, new Cesium.Cartesian3()),
    label: 'ZARYA',
  };
}

test('the station is ridden from its mount: the camera sits there and looks along it', async (t) => {
  const { $, cockpit, satellites, shots, store, clock } = await orbitAt(t);
  const mount = stationMount();
  satellites.getCockpitMount = () => mount;
  clock.advance(16);
  cockpit.update();
  await settle();
  const shot = shots.at(-1);
  assert.ok(
    Cesium.Cartesian3.equalsEpsilon(shot.destination, mount.position, 1e-9),
    'the camera is at the mount, not at the satellite',
  );
  near(
    angleDeg(shot.direction, mount.direction),
    0,
    'looks along the mount',
    1e-9,
  );
  near(angleDeg(shot.up, mount.up), 0, 'the mount is upright', 1e-9);

  // The HUD names the view and drops what describes the nadir picture.
  assert.equal(store.orbital.mount, 'ZARYA');
  assert.equal(store.orbital.footprintKm, null);
  assert.equal(store.orbital.sensor, null);
  assert.equal(
    $('.cockpit-orbital-kicker').textContent,
    'STATION VIEW · ZARYA',
  );
  assert.equal($('.cockpit-orbital-reticle'), null);
  assert.equal($('.cockpit-orbital-north'), null);
  assert.match($('.cockpit-help').textContent, /ARROWS LOOK/);
  assert.match($('.cockpit-help').textContent, /HOME RESET/);
  assert.doesNotMatch($('.cockpit-help').textContent, /NADIR/);

  // The arrows turn the view about the mount's own frame, and Home returns.
  press(cockpit, 'ArrowRight');
  clock.advance(16);
  cockpit.update();
  await settle();
  const turned = shots.at(-1);
  near(angleDeg(turned.direction, mount.direction), 5, 'one step is 5°', 1e-6);
  assert.ok(
    Cesium.Cartesian3.dot(turned.direction, mount.right) > 0,
    'right turns toward the mount’s right',
  );
  assert.ok(
    Cesium.Cartesian3.equalsEpsilon(turned.destination, mount.position, 1e-9),
  );
  assert.equal($('#cockpit-orbital-nadir').textContent, 'RESET');
  assert.equal($('#cockpit-orbital-look-readout').textContent, '');
  press(cockpit, 'Home');
  clock.advance(16);
  cockpit.update();
  near(angleDeg(shots.at(-1).direction, mount.direction), 0, 'Home', 1e-9);
});

test('without a mount the same satellite keeps the nadir picture, and gets it back', async (t) => {
  const { $, cockpit, satellites, shots, store, clock } = await orbitAt(t);
  const position = satellitePosition();
  const toCentre = Cesium.Cartesian3.negate(
    Cesium.Cartesian3.normalize(position, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const signals = [];
  cockpit.pushCockpitSignal = (key, kind, title, detail) =>
    signals.push(detail);
  // The model has not loaded yet: straight down, as for any satellite.
  satellites.getCockpitMount = () => null;
  clock.advance(16);
  cockpit.update();
  await settle();
  assert.deepEqual(signals, [], 'nothing changed: nothing to say');
  near(angleDeg(shots.at(-1).direction, toCentre), 0, 'nadir', 1e-9);
  assert.equal(store.orbital.mount, null);
  assert.equal(
    $('.cockpit-orbital-kicker').textContent,
    'ORBITAL VIEW · NADIR',
  );
  assert.ok($('.cockpit-orbital-reticle'));

  // It loads: the view moves to the mount. It goes again: back to nadir.
  const mount = stationMount();
  satellites.getCockpitMount = () => mount;
  clock.advance(1000);
  cockpit.update();
  await settle();
  assert.equal(store.orbital.mount, 'ZARYA');
  near(angleDeg(shots.at(-1).direction, mount.direction), 0, 'mount', 1e-9);
  // The TRACK ACQUIRED line follows the picture, once per change.
  cockpit.update();
  assert.deepEqual(signals, ['ISS (ZARYA) · STATION VIEW']);
  satellites.getCockpitMount = () => null;
  clock.advance(1000);
  cockpit.update();
  await settle();
  assert.deepEqual(signals, [
    'ISS (ZARYA) · STATION VIEW',
    'ISS (ZARYA) · NADIR VIEW',
  ]);
  assert.equal(store.orbital.mount, null);
  near(angleDeg(shots.at(-1).direction, toCentre), 0, 'nadir again', 1e-9);
  assert.ok(
    Cesium.Cartesian3.equalsEpsilon(shots.at(-1).destination, position, 1e-6),
  );
});

/** The station's views as the satellites layer offers them, by key. */
function stationViews({ docked = true } = {}) {
  const views = [
    { key: 'nauka', label: 'NAUKA' },
    { key: 'zarya', label: 'ZARYA' },
    ...(docked ? [{ key: 'docked', label: 'PROGRESS-MS 34' }] : []),
  ];
  const base = stationMount();
  // Each view sits a different distance above the satellite's position.
  const heights = { nauka: 10, zarya: 20, docked: 30 };
  const asked = [];
  return {
    asked,
    views,
    heightOf(shot) {
      return Math.round(
        Cesium.Cartesian3.distance(shot.destination, satellitePosition()),
      );
    },
    getCockpitMount(key) {
      asked.push(key);
      const view = views.find((entry) => entry.key === key) ?? views[0];
      return {
        ...base,
        position: Cesium.Cartesian3.add(
          satellitePosition(),
          Cesium.Cartesian3.multiplyByScalar(
            base.up,
            heights[view.key],
            new Cesium.Cartesian3(),
          ),
          new Cesium.Cartesian3(),
        ),
        key: view.key,
        label: view.label,
        views,
      };
    },
  };
}

test('the station opens on its first view and the arrows step through the rest', async (t) => {
  const { $, cockpit, satellites, shots, store, clock } = await orbitAt(t);
  const station = stationViews();
  satellites.getCockpitMount = station.getCockpitMount;
  const frame = async () => {
    clock.advance(16);
    cockpit.update();
    await settle();
  };
  await frame();
  // Nothing was chosen: the layer is asked for its first view, Nauka's,
  // though the entry ridden is ISS (ZARYA).
  assert.equal(station.asked[0], null);
  assert.equal(store.orbital.mount, 'NAUKA');
  assert.equal(store.orbital.mountViews, 3);
  assert.equal(station.heightOf(shots.at(-1)), 10);
  assert.equal(
    $('.cockpit-orbital-kicker').textContent,
    'STATION VIEW · NAUKA',
  );
  assert.equal(
    $('#cockpit-orbital-view-next').getAttribute('aria-label'),
    'Next station view',
  );
  assert.equal(
    $('#cockpit-orbital-view-previous').getAttribute('aria-label'),
    'Previous station view',
  );
  assert.equal($('#cockpit-orbital-view-name').textContent, 'NAUKA');

  // A look off to one side is dropped by the step: each view looks its own way.
  press(cockpit, 'ArrowRight');
  await frame();
  assert.equal(store.orbital.look.offset, true);

  // The button, as a click anywhere inside it.
  $('#cockpit-orbital-view-next').dispatchEvent(
    new Event('click', { bubbles: true }),
  );
  await settle();
  assert.equal(store.orbital.mount, 'ZARYA', 'named at once, before a frame');
  await frame();
  assert.equal(station.asked.at(-1), 'zarya');
  assert.equal(station.heightOf(shots.at(-1)), 20);
  assert.equal(store.orbital.look.offset, false);
  near(
    angleDeg(shots.at(-1).direction, stationMount().direction),
    0,
    'reset',
    1e-9,
  );
  assert.equal(
    $('.cockpit-orbital-kicker').textContent,
    'STATION VIEW · ZARYA',
  );

  assert.equal(cockpit.nextOrbitalView(), true);
  await frame();
  assert.equal(store.orbital.mount, 'PROGRESS-MS 34');
  assert.equal(station.heightOf(shots.at(-1)), 30);
  // Round again to the first.
  assert.equal(cockpit.nextOrbitalView(), true);
  await frame();
  assert.equal(store.orbital.mount, 'NAUKA');
  assert.equal(station.heightOf(shots.at(-1)), 10);
});

test('the chosen view is kept while the model is away, and one view has no arrows', async (t) => {
  const { $, cockpit, satellites, store, clock } = await orbitAt(t);
  const station = stationViews({ docked: false });
  satellites.getCockpitMount = station.getCockpitMount;
  // A second per frame: the HUD republishes on its own cadence.
  const frame = async () => {
    clock.advance(1000);
    cockpit.update();
    await settle();
  };
  await frame();
  assert.equal(store.orbital.mountViews, 2);
  cockpit.nextOrbitalView();
  await frame();
  assert.equal(store.orbital.mount, 'ZARYA');
  // The model goes: nadir, no control, nothing to step.
  satellites.getCockpitMount = () => null;
  await frame();
  assert.equal(store.orbital.mount, null);
  assert.equal(store.orbital.mountViews, 0);
  assert.equal($('#cockpit-orbital-view-next'), null);
  assert.equal($('#cockpit-orbital-view-previous'), null);
  assert.equal(cockpit.nextOrbitalView(), false);
  // It comes back: the same view is asked for again.
  satellites.getCockpitMount = station.getCockpitMount;
  await frame();
  assert.equal(station.asked.at(-1), 'zarya');
  assert.equal(store.orbital.mount, 'ZARYA');

  // A station offering a single view shows no control.
  station.views.length = 1;
  await frame();
  assert.equal(store.orbital.mount, 'NAUKA', 'the view on offer');
  assert.equal(store.orbital.mountViews, 1);
  assert.equal($('#cockpit-orbital-view-next'), null);
  assert.equal($('#cockpit-orbital-view-previous'), null);
  assert.equal(cockpit.nextOrbitalView(), false);
});

test('the view arrows do nothing outside a station view', async (t) => {
  const { cockpit, clock } = await orbitAt(t);
  clock.advance(16);
  cockpit.update();
  assert.equal(cockpit.nextOrbitalView(), false);
  assert.equal(cockpit.previousOrbitalView(), false);
  cockpit.exit();
  assert.equal(cockpit.nextOrbitalView(), false);
  assert.equal(cockpit.previousOrbitalView(), false);
});

test('each station view rides its own entry, so the card describes that module', async (t) => {
  const { $, cockpit, satellites, store, clock } = await orbitAt(t);
  // The layer, as it behaves: tracking another entry makes it the subject.
  const names = {
    25544: 'ISS (ZARYA)',
    49044: 'ISS (NAUKA)',
    36086: 'POISK',
    68837: 'PROGRESS-MS 34',
  };
  let subject = { ...ISS, noradId: 68837, id: '68837', name: names[68837] };
  const tracked = [];
  satellites.getCockpitSubject = () => ({ ...subject });
  satellites.trackById = (noradId) => {
    tracked.push(Number(noradId));
    const id = Number(noradId);
    subject = { ...ISS, noradId: id, id: String(id), name: names[id] };
    return true;
  };
  cockpit.subjectId = 68837;
  const base = stationMount();
  const views = [
    { key: 'nauka', label: 'NAUKA', noradId: 49044 },
    { key: 'zarya', label: 'ZARYA', noradId: 25544 },
    { key: 'poisk', label: 'POISK', noradId: 36086 },
    { key: 'docked', label: 'PROGRESS-MS 34', noradId: 68837 },
  ];
  satellites.getCockpitMount = (key) => {
    const view = views.find((entry) => entry.key === key) ?? views[0];
    return { ...base, ...view, views };
  };
  const frame = async () => {
    clock.advance(1000);
    cockpit.update();
    await settle();
  };
  // Entered on the Progress; the view opens on Nauka and rides Nauka.
  await frame();
  await frame();
  assert.deepEqual(tracked, [49044]);
  assert.equal(cockpit.subjectId, 49044);
  assert.equal(store.orbital.name, 'ISS (NAUKA)');
  assert.equal($('.cockpit-orbital-name').textContent, 'ISS (NAUKA)');
  assert.equal(store.orbital.mount, 'NAUKA');

  // Each step rides the next view's entry.
  for (const [noradId, name] of [
    [25544, 'ISS (ZARYA)'],
    [36086, 'POISK'],
    [68837, 'PROGRESS-MS 34'],
    [49044, 'ISS (NAUKA)'],
  ]) {
    assert.equal(cockpit.nextOrbitalView(), true);
    await frame();
    await frame();
    assert.equal(cockpit.subjectId, noradId);
    assert.equal(store.orbital.name, name);
    assert.equal($('.cockpit-orbital-name').textContent, name);
  }
  assert.deepEqual(tracked, [49044, 25544, 36086, 68837, 49044]);
});

test('a view with no entry, or one that cannot be ridden, keeps the subject', async (t) => {
  const { cockpit, satellites, store, clock } = await orbitAt(t);
  const base = stationMount();
  let views = [
    { key: 'nauka', label: 'NAUKA', noradId: null },
    { key: 'zarya', label: 'ZARYA', noradId: 25544 },
  ];
  satellites.getCockpitMount = (key) => {
    const view = views.find((entry) => entry.key === key) ?? views[0];
    return { ...base, ...view, views };
  };
  let asked = 0;
  satellites.trackById = () => {
    asked += 1;
    return false;
  };
  const frame = async () => {
    clock.advance(1000);
    cockpit.update();
    await settle();
  };
  // No entry for Nauka: the ISS stays the subject, and nothing is tracked.
  await frame();
  assert.equal(asked, 0);
  assert.equal(cockpit.subjectId, 25544);
  assert.equal(store.orbital.mount, 'NAUKA');
  // An entry the layer will not track: asked once, not every frame.
  views = [
    { key: 'nauka', label: 'NAUKA', noradId: 49044 },
    { key: 'zarya', label: 'ZARYA', noradId: 25544 },
  ];
  await frame();
  await frame();
  await frame();
  assert.equal(asked, 1);
  assert.equal(cockpit.subjectId, 25544);
  assert.equal(document.body.classList.contains('cockpit-orbit'), true);
});

const CUPOLA_CARD = Object.freeze({
  name: 'CUPOLA',
  classLabel: 'OBSERVATION MODULE · ISS',
  operator: 'European Space Agency (ESA)',
  facts: ['7 WINDOWS', 'LAUNCHED 8 FEB 2010 · STS-130'],
});

test('a view with a card of its own shows it in place of the entry’s identity', async (t) => {
  const { $, cockpit, satellites, store, clock } = await orbitAt(t);
  const base = stationMount();
  const views = [
    { key: 'zarya', label: 'ZARYA', noradId: 25544, card: null },
    { key: 'cupola', label: 'CUPOLA', noradId: 25544, card: CUPOLA_CARD },
  ];
  satellites.getCockpitMount = (key) => {
    const view = views.find((entry) => entry.key === key) ?? views[0];
    return { ...base, ...view, views };
  };
  const frame = async () => {
    clock.advance(1000);
    cockpit.update();
    await settle();
  };
  await frame();
  assert.equal(store.orbital.name, 'ISS (ZARYA)');
  assert.equal(store.orbital.noradId, 25544);
  assert.equal(store.orbital.facts, null);

  cockpit.nextOrbitalView();
  await frame();
  // Same entry ridden (nothing to switch), the Cupola's own card shown.
  assert.equal(cockpit.subjectId, 25544);
  assert.equal(store.orbital.mount, 'CUPOLA');
  assert.equal(store.orbital.name, 'CUPOLA');
  assert.equal($('.cockpit-orbital-name').textContent, 'CUPOLA');
  assert.equal(store.orbital.classLabel, 'OBSERVATION MODULE · ISS');
  assert.equal(store.orbital.operator, 'European Space Agency (ESA)');
  assert.equal(store.orbital.noradId, null);
  assert.equal(store.orbital.tle, null);
  assert.equal(store.orbital.owner, null);
  assert.equal(
    $('.cockpit-orbital-ident-text').textContent,
    '7 WINDOWS · LAUNCHED 8 FEB 2010 · STS-130',
  );
  assert.equal($('#cockpit-orbital-tle-toggle'), null);
  // Altitude, velocity and the sub-satellite point are the station's still.
  assert.ok($('.cockpit-orbital-altitude').textContent.length > 0);

  // Back round to Zarya: the entry's own card again.
  cockpit.nextOrbitalView();
  await frame();
  assert.equal(store.orbital.name, 'ISS (ZARYA)');
  assert.equal(store.orbital.noradId, 25544);
  assert.equal(store.orbital.facts, null);
});

test('leaving a station view selects Nauka; leaving any other keeps the satellite', async (t) => {
  const { cockpit, satellites, clock } = await orbitAt(t);
  const names = { 25544: 'ISS (ZARYA)', 49044: 'ISS (NAUKA)' };
  let subject = { ...ISS };
  const tracked = [];
  satellites.getCockpitSubject = () => ({ ...subject });
  satellites.trackById = (noradId) => {
    const id = Number(noradId);
    tracked.push(id);
    subject = { ...ISS, noradId: id, id: String(id), name: names[id] };
    return true;
  };
  const base = stationMount();
  const views = [
    { key: 'nauka', label: 'NAUKA', noradId: 49044, card: null },
    { key: 'cupola', label: 'CUPOLA', noradId: 25544, card: CUPOLA_CARD },
  ];
  satellites.getCockpitMount = (key) => {
    const view = views.find((entry) => entry.key === key) ?? views[0];
    return { ...base, ...view, views };
  };
  const frame = async () => {
    clock.advance(1000);
    cockpit.update();
    await settle();
  };
  await frame();
  await frame();
  // On the Cupola, riding the ISS's entry, when the Cockpit is left.
  cockpit.nextOrbitalView();
  await frame();
  await frame();
  assert.equal(cockpit.subjectId, 25544);
  satellites.calls.length = 0;
  tracked.length = 0;
  assert.equal(cockpit.exit(), true);
  assert.deepEqual(tracked, [49044], 'Nauka is selected');
  assert.deepEqual(satellites.calls, [
    ['subject', null],
    ['refocus', 49044],
  ]);
});

test('leaving the plain orbital view refocuses the satellite ridden', async (t) => {
  const { cockpit, satellites } = await orbitAt(t);
  const tracked = [];
  satellites.trackById = (noradId) => {
    tracked.push(noradId);
    return true;
  };
  satellites.calls.length = 0;
  assert.equal(cockpit.exit(), true);
  assert.deepEqual(tracked, []);
  assert.deepEqual(satellites.calls, [
    ['subject', null],
    ['refocus', 25544],
  ]);
});

test('the left arrow steps back through the views, wrapping round', async (t) => {
  const { $, cockpit, satellites, shots, store, clock } = await orbitAt(t);
  const station = stationViews();
  satellites.getCockpitMount = station.getCockpitMount;
  const frame = async () => {
    clock.advance(16);
    cockpit.update();
    await settle();
  };
  await frame();
  assert.equal(store.orbital.mount, 'NAUKA');
  // From the first view back to the last.
  $('#cockpit-orbital-view-previous').dispatchEvent(
    new Event('click', { bubbles: true }),
  );
  await settle();
  assert.equal(store.orbital.mount, 'PROGRESS-MS 34');
  await frame();
  // The camera is at the docked vehicle's view (30 m up in this stand-in).
  assert.equal(station.heightOf(shots.at(-1)), 30);
  assert.equal(cockpit.previousOrbitalView(), true);
  await frame();
  assert.equal(store.orbital.mount, 'ZARYA');
  assert.equal(cockpit.nextOrbitalView(), true);
  await frame();
  assert.equal(store.orbital.mount, 'PROGRESS-MS 34');
});
