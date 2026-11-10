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
import ContextView from './views/ContextView.vue';
import IntelHudView from './views/IntelHudView.vue';
import {
  ORBITAL_PREFETCH_INTERVAL_MS,
  ORBITAL_PREFETCH_MAX_TILES,
  ORBITAL_SETTLE_BLUR_PX,
  ORBITAL_SETTLE_MAX_MS,
  ORBITAL_ZOOM_TRANSITION_MS,
  cesiumFrustumFovRad,
  fovForZoom,
  orbitalBaseFovRad,
} from '../cockpitOrbital.js';
import { vesselCockpitInfo } from '../layers/vessels/cockpitSubject.js';
import { prefetchImageryAhead } from './cockpitOrbitalView.js';
import { claimPointer, releasePointer } from '../data/inputOwnership.js';

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
    viewer.trackedEntity = undefined;
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
    defineComponent(() => () => [
      h(ContextView),
      h(IntelHudView),
      h(CockpitView),
    ]),
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
    trackedEntity: undefined,
    clock: { currentTime: null },
    camera: {
      frustum: { fov: SAVED_FOV, aspectRatio: ASPECT },
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
  const events = [];
  const onMode = (event) => events.push(event.detail);
  window.addEventListener('gev:cockpit-mode-changed', onMode);
  t.after(() => {
    window.removeEventListener('gev:cockpit-mode-changed', onMode);
    cockpit.stop();
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

test('a tracked satellite offers an ORBIT entry in Contacts and the readout', async (t) => {
  const { $, cockpit } = fixture(t);
  cockpit.syncEntry();
  await nextTick();
  for (const selector of ['#cockpit-entry', '#cockpit-entry-readout']) {
    const entry = $(selector);
    assert.equal(entry.hidden, false, selector);
    assert.match(entry.textContent, /satellite_alt/);
    assert.match(entry.textContent, /ORBIT/);
  }
  assert.equal($('#tr3b-toggle').hidden, true, 'TR-3B stays aircraft-only');
});

test('a shut orbit gate keeps the entry hidden and refuses entry', async (t) => {
  const { $, cockpit } = fixture(t, { orbitAllowed: false });
  cockpit.syncEntry();
  await nextTick();
  assert.equal($('#cockpit-entry').hidden, true);
  assert.equal($('#cockpit-entry-readout').hidden, true);
  assert.equal(cockpit.enter(), false);
  assert.equal(cockpit.active, false);
});

test('ORBIT enters the orbital view; voice-style aircraft entry refuses it', async (t) => {
  const { $, cockpit } = fixture(t);
  assert.equal(cockpit.enter({ kind: 'aircraft' }), false);
  cockpit.syncEntry();
  await nextTick();
  $('#cockpit-entry').click();
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
  assert.equal(viewer.trackedEntity, undefined);
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
  viewer.trackedEntity = aircraft;
  clock.advance(16);
  cockpit.update();
  assert.equal(cockpit.active, false);
  assert.equal(viewer.trackedEntity, aircraft);
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
  air.viewer.trackedEntity = air.aircraft;
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
function doubleClickNearSatellite(viewer, offsetPx) {
  viewer.scene.cartesianToCanvasCoordinates = (position, result) =>
    position ? Object.assign(result, { x: 400, y: 300 }) : undefined;
  const handler = viewer.screenSpaceEventHandler;
  const before = handler.stockCalls;
  handler.doubleClick({ x: 400 + offsetPx, y: 300 });
  return { stock: handler.stockCalls > before };
}

test('double-clicking the followed satellite enters the orbital view', async (t) => {
  const { viewer, store } = fixture(t);
  const miss = doubleClickNearSatellite(viewer, 60);
  assert.equal(miss.stock, true, 'a double-click elsewhere goes to Cesium');
  assert.equal(store.orbital, null);
  const hit = doubleClickNearSatellite(viewer, 20);
  assert.equal(hit.stock, false, 'Cesium never sees it');
  await settle();
  assert.ok(store.orbital, 'the orbital HUD is up');
  assert.equal(
    doubleClickNearSatellite(viewer, 0).stock,
    true,
    'inside, a double-click is not the entry',
  );
});

test('a double-click a tool owns, or one the gate refuses, does not enter', async (t) => {
  const { cockpit, viewer, store } = fixture(t, { orbitAllowed: false });
  // On the track but refused: no entry, and no untracking either.
  assert.equal(doubleClickNearSatellite(viewer, 0).stock, false);
  assert.equal(store.orbital, null);
  cockpit.isOrbitEntryAllowed = () => true;
  // Drawing ends a shape with a double-click.
  const lease = claimPointer('draw');
  t.after(() => releasePointer(lease));
  doubleClickNearSatellite(viewer, 0);
  assert.equal(store.orbital, null);
  releasePointer(lease);
  doubleClickNearSatellite(viewer, 0);
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
  const { viewer, aircraft, store } = fixture(t, { aircraftInfo });
  viewer.trackedEntity = aircraft;
  // The model is a primitive, not an Entity: Cesium's own double-click
  // would untrack it.
  doubleClickNearSatellite(viewer, 0);
  await settle();
  assert.equal(viewer.screenSpaceEventHandler.stockCalls, 0);
  assert.equal(store.presence.active, true, 'the cockpit is entered');
});

test('the Cockpit hands the double-click back to Cesium when it stops', async (t) => {
  const { cockpit, viewer } = fixture(t);
  cockpit.stop();
  doubleClickNearSatellite(viewer, 0);
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

test('a tracked aircraft takes entry before a tracked satellite', async (t) => {
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
  viewer.trackedEntity = aircraft;
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

/** A globe draping one Web Mercator imagery layer that records requests. */
function imageryGlobe(viewer, { requestImage } = {}) {
  const requests = [];
  const requestObjects = [];
  const provider = {
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    tileWidth: 256,
    maximumLevel: 19,
    requestImage:
      requestImage ??
      ((x, y, level, request) => {
        requests.push(`${level}/${x}/${y}`);
        requestObjects.push(request);
        return Promise.resolve({});
      }),
  };
  viewer.scene.globe = { show: true, tilesLoaded: true };
  viewer.scene.canvas = { clientWidth: 1600, clientHeight: 900 };
  viewer.imageryLayers = {
    length: 1,
    get: () => ({ show: true, alpha: 1, imageryProvider: provider }),
  };
  return { requests, requestObjects, provider };
}

const WORLDVIEW_ON_TRACK = Object.freeze({ ...WORLDVIEW, groundTrackDeg: 52 });

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

test('from 16x the imagery ahead of the ground track is pre-loaded', async (t) => {
  const { cockpit, viewer, store, clock } = await orbitAt(t, {
    satellite: WORLDVIEW_ON_TRACK,
  });
  const { requests } = imageryGlobe(viewer);
  for (const zoom of [2, 4, 8]) {
    press(cockpit, '+');
    assert.equal(store.orbital.zoom, zoom);
    clock.advance(ORBITAL_PREFETCH_INTERVAL_MS);
    cockpit.update();
  }
  assert.deepEqual(requests, [], 'nothing below 16x');
  press(cockpit, '+');
  assert.equal(store.orbital.zoom, 16);
  clock.advance(16);
  cockpit.update();
  assert.ok(requests.length > 0, 'tiles ahead are asked for');
  assert.ok(requests.length <= ORBITAL_PREFETCH_MAX_TILES, 'bounded');
  assert.equal(new Set(requests.map((key) => key.split('/')[0])).size, 1);
  const first = requests.length;
  // Not again until the interval has passed, and never the same tile twice.
  clock.advance(16);
  cockpit.update();
  assert.equal(requests.length, first);
  clock.advance(ORBITAL_PREFETCH_INTERVAL_MS);
  cockpit.update();
  assert.equal(new Set(requests).size, requests.length, 'no repeats');
  // A tighter zoom needs a finer level.
  press(cockpit, '+');
  assert.equal(store.orbital.zoom, 32);
  clock.advance(ORBITAL_PREFETCH_INTERVAL_MS);
  cockpit.update();
  const levels = requests.map((key) => Number(key.split('/')[0]));
  assert.equal(levels.at(-1), levels[0] + 1);
  // Back below 16x, and after the exit: no more work.
  const before = requests.length;
  press(cockpit, '-');
  press(cockpit, '-');
  assert.equal(store.orbital.zoom, 8);
  clock.advance(ORBITAL_PREFETCH_INTERVAL_MS);
  cockpit.update();
  assert.equal(requests.length, before, 'stops below 16x');
  press(cockpit, '+');
  cockpit.exit();
  clock.advance(ORBITAL_PREFETCH_INTERVAL_MS);
  cockpit.update();
  assert.equal(
    prefetchImageryAhead.call(cockpit, WORLDVIEW_ON_TRACK, Infinity),
    0,
  );
  assert.equal(requests.length, before, 'stops after the exit');
});

test('the pre-load skips a hidden globe and a provider that cannot fetch', async (t) => {
  const { cockpit, viewer, store, clock } = await orbitAt(t, {
    satellite: WORLDVIEW_ON_TRACK,
  });
  const { requests, provider } = imageryGlobe(viewer);
  for (let i = 0; i < 4; i += 1) press(cockpit, '+');
  assert.equal(store.orbital.zoom, 16);
  // Google 3D tiles drawn, the globe hidden: nothing to pre-load.
  viewer.scene.globe.show = false;
  clock.advance(ORBITAL_PREFETCH_INTERVAL_MS);
  cockpit.update();
  assert.deepEqual(requests, []);
  viewer.scene.globe.show = true;
  // No requestImage, or one that throws: no error, nothing remembered.
  delete provider.requestImage;
  clock.advance(ORBITAL_PREFETCH_INTERVAL_MS);
  assert.doesNotThrow(() => cockpit.update());
  provider.requestImage = () => {
    throw new Error('offline');
  };
  clock.advance(ORBITAL_PREFETCH_INTERVAL_MS);
  assert.doesNotThrow(() => cockpit.update());
  assert.equal(store.orbital.zoom, 16, 'the view carries on');
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

test('the pre-load is throttled, at the level Cesium draws, and waits out a tilt', async (t) => {
  const { cockpit, viewer, store, clock } = await orbitAt(t, {
    satellite: WORLDVIEW_ON_TRACK,
  });
  const { requests, requestObjects } = imageryGlobe(viewer);
  for (let i = 0; i < 4; i += 1) press(cockpit, '+');
  assert.equal(store.orbital.zoom, 16);
  // Tilted off nadir the view looks away from the track: nothing asked.
  press(cockpit, 'ArrowRight');
  clock.advance(ORBITAL_PREFETCH_INTERVAL_MS);
  cockpit.update();
  assert.deepEqual(requests, [], 'nothing while tilted');
  press(cockpit, 'Home');
  for (let frame = 0; frame < 30; frame += 1) {
    clock.advance(16);
    cockpit.update();
  }
  assert.ok(requests.length > 0, 'back at nadir it pre-loads');
  // Every request may be declined while Cesium is busy with the screen.
  for (const request of requestObjects) {
    assert.ok(request instanceof Cesium.Request);
    assert.equal(request.throttle, true);
    assert.equal(request.throttleByServer, true);
    assert.equal(
      request.priority,
      Number.MAX_VALUE,
      'never ahead of the screen',
    );
    assert.equal(request.type, Cesium.RequestType.IMAGERY);
  }
  // The level Cesium's own selection takes for this view, worked by hand:
  // at 16x from 617 km the 900 px canvas is ~49.5 m a pixel. The ellipsoid
  // terrain's level-zero error is 6378137 · 2π / 4 / 128 ≈ 78,272 m; it first
  // meets Cesium's screen-space error of 2 px (≤ 99 m) at level 10, 76.4 m.
  // A Web Mercator level-zero texel at 30° is 6378137 · 2π · cos 30° / 256
  // ≈ 135,570 m, so the imagery level is round(log2(135,570 / 76.4)) = 11.
  assert.equal(Number(requests[0].split('/')[0]), 11);
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

test('exit cancels pending pre-loads, and a dropped one is asked again', async (t) => {
  const { cockpit, viewer, store, clock } = await orbitAt(t, {
    satellite: WORLDVIEW_ON_TRACK,
  });
  const asked = [];
  let fail = true;
  const pending = [];
  imageryGlobe(viewer, {
    requestImage: (x, y, level, request) => {
      asked.push(`${level}/${x}/${y}`);
      // Cesium's scheduler drops a request by rejecting with no error.
      if (fail) return Promise.reject(undefined);
      pending.push(request);
      return new Promise(() => {});
    },
  });
  for (let i = 0; i < 4; i += 1) press(cockpit, '+');
  assert.equal(store.orbital.zoom, 16);
  clock.advance(ORBITAL_PREFETCH_INTERVAL_MS);
  cockpit.update();
  await settle();
  const firstAsk = asked.slice();
  assert.ok(firstAsk.length > 0);
  fail = false;
  clock.advance(ORBITAL_PREFETCH_INTERVAL_MS);
  cockpit.update();
  assert.deepEqual(asked.slice(firstAsk.length), firstAsk, 'asked again');
  assert.ok(pending.length > 0);
  cockpit.exit();
  assert.ok(
    pending.every((request) => request.cancelled === true),
    'cancelled on exit',
  );
});

test('the pre-load waits while the world clock is away from now', async (t) => {
  const { cockpit, viewer, store, clock } = await orbitAt(t, {
    satellite: { ...WORLDVIEW_ON_TRACK, atMs: START_MS - 3_600_000 },
  });
  const { requests } = imageryGlobe(viewer);
  for (let i = 0; i < 4; i += 1) press(cockpit, '+');
  assert.equal(store.orbital.zoom, 16);
  clock.advance(ORBITAL_PREFETCH_INTERVAL_MS);
  cockpit.update();
  assert.deepEqual(requests, []);
});

test('a tile that fails to load is not asked again', async (t) => {
  const { cockpit, viewer, store, clock } = await orbitAt(t, {
    satellite: WORLDVIEW_ON_TRACK,
  });
  const asked = [];
  imageryGlobe(viewer, {
    requestImage: (x, y, level) => {
      asked.push(`${level}/${x}/${y}`);
      return Promise.reject(new Error('404'));
    },
  });
  for (let i = 0; i < 4; i += 1) press(cockpit, '+');
  assert.equal(store.orbital.zoom, 16);
  clock.advance(ORBITAL_PREFETCH_INTERVAL_MS);
  cockpit.update();
  await settle();
  const first = asked.length;
  assert.ok(first > 0);
  clock.advance(ORBITAL_PREFETCH_INTERVAL_MS);
  cockpit.update();
  assert.equal(new Set(asked).size, asked.length, 'none asked twice');
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
