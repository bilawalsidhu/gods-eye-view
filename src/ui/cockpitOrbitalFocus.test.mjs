// src/ui/cockpitOrbitalFocus.test.mjs — keeping the orbital camera on a
// mapped ground point: a click on the point or FOCUS on the reach list turns
// the view onto it and holds it as the satellite moves; a click elsewhere,
// FOCUS again, NADIR or the point leaving the reach eases the view back,
// never in one jump. Over happy-dom, with the shared context store.
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
import { getContextStore, registerEntityContext } from '../data/contextStore.js';
import { claimPointer, releasePointer } from '../data/inputOwnership.js';
import { ORBITAL_FOCUS_EASE_TAU_MS } from '../cockpitOrbitalFocus.js';

const START_MS = 1_800_000_000_000;
const ASPECT = 16 / 9;
const FRAME_MS = 16;

const ISS = Object.freeze({
  kind: 'satellite',
  layerId: 'satellites',
  id: '25544',
  noradId: 25544,
  name: 'ISS (ZARYA)',
  classKey: 'station',
  classLabel: 'STATION · ISS',
  latitude: 30,
  longitude: -97,
  altitudeM: 420_000,
  velocityMps: 7_660,
  // Track-up: the focus is built on the turned frame.
  groundTrackDeg: 51.6,
  stale: false,
});

const LAYER = 'military-installations';

/** Mapped points: two in reach, one only beyond it. */
const SITES = Object.freeze({
  alpha: { lat: 31, lon: -96.5, label: 'Camp Alpha', at: { x: 100, y: 100 } },
  bravo: { lat: 29.2, lon: -97.8, label: 'Bravo Field', at: { x: 300, y: 300 } },
  far: { lat: 33.5, lon: -101, label: 'Far Range', at: { x: 500, y: 50 } },
});

const EMPTY_GROUND = Object.freeze({ x: 640, y: 360 });

function fixture(t, { reducedMotion = false } = {}) {
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
  const picks = new Map();
  const viewer = {
    trackedEntity: undefined,
    clock: { currentTime: null },
    camera: {
      frustum: { fov: 1, aspectRatio: ASPECT },
      cancelFlight() {},
      setView({ destination, orientation }) {
        shots.push({
          destination: Cesium.Cartesian3.clone(destination),
          direction: Cesium.Cartesian3.clone(orientation.direction),
          up: Cesium.Cartesian3.clone(orientation.up),
        });
      },
    },
    entities: { contains: () => false },
    scene: {
      preUpdate: listeners(),
      screenSpaceCameraController: { enableInputs: true },
      pick: (position) => picks.get(`${position.x},${position.y}`),
    },
    trackedEntityChanged: listeners(),
  };
  // The Viewer's own input handler: its single click picks into
  // selectedEntity, which the Cockpit must still hand it.
  const actions = new Map();
  const handler = {
    stockClicks: 0,
    getInputAction: (type) => actions.get(type),
    setInputAction: (action, type) => actions.set(type, action),
    removeInputAction: (type) => actions.delete(type),
    isDestroyed: () => false,
  };
  const stockClick = () => {
    handler.stockClicks += 1;
  };
  handler.stock = stockClick;
  actions.set(Cesium.ScreenSpaceEventType.LEFT_CLICK, stockClick);
  viewer.screenSpaceEventHandler = handler;

  let subject = { ...ISS };
  const satellites = {
    getCockpitSubject: () => (subject ? { ...subject } : null),
    getCockpitPosition(result) {
      if (!subject) return null;
      return Cesium.Cartesian3.fromDegrees(
        subject.longitude,
        subject.latitude,
        subject.altitudeM,
        Cesium.Ellipsoid.WGS84,
        result,
      );
    },
    setCockpitSubject: () => true,
    refocusTrackedById: () => true,
  };
  const enabled = new Set(['satellites', LAYER]);
  const cockpit = new CockpitViewController(viewer, {
    services: {
      flightsLayer: { getTrackedInfo: () => null },
      militaryFlightsLayer: { getTrackedInfo: () => null },
      aisLiveVesselsLayer: { getCockpitSubject: () => null },
      satellitesLayer: satellites,
      militaryAwarenessLayer: {},
      isTr3b: () => false,
      holdContinuousRender() {},
      releaseContinuousRender() {},
      cachedGroundFloor: () => null,
      GROUND_FLOOR_LIFT_M: 0,
      isLayerEnabled: (layerId) => enabled.has(layerId),
    },
    isEntryAllowed: () => false,
    isBridgeEntryAllowed: () => false,
    isOrbitEntryAllowed: () => true,
    publish: {
      presence: (view) => store.publishPresence(view),
      instruments: (view) => store.publishInstruments(view),
      route: (view) => store.publishRoute(view),
      radar: (view) => store.publishRadar(view),
      orbital: (view) => store.publishOrbital(view),
      orbitalReach: (view) => store.publishOrbitalReach(view),
    },
  });
  Object.assign(cockpit, {
    setVisionMode() {},
    showBriefPage() {},
    startBriefRotation() {},
    stopBriefRotation() {},
    pushCockpitSignal() {},
    scheduleContextLayout() {},
    updateLocalPosition() {},
    maybeRefreshRegionalBrief() {},
    updateContext() {},
    updateRoute() {},
  });

  // The mapped points, registered as the installations layer does.
  const carriers = {};
  for (const [key, site] of Object.entries(SITES)) {
    const carrier = { show: true };
    carriers[key] = carrier;
    registerEntityContext(carrier, {
      id: `site-${key}`,
      layerId: LAYER,
      layerName: 'Mapped Military Installations',
      source: 'OpenStreetMap',
      label: site.label,
      latitude: site.lat,
      longitude: site.lon,
      properties: { military: 'base', name: site.label, _internal: 'x' },
    });
    picks.set(`${site.at.x},${site.at.y}`, { id: carrier });
  }
  // A moving contact is never a focus target.
  const aircraftCarrier = { show: true };
  registerEntityContext(aircraftCarrier, {
    id: 'flight-abc',
    layerId: 'flights',
    label: 'ABC123',
    latitude: 30.2,
    longitude: -97.1,
  });
  enabled.add('flights');
  picks.set('700,700', { id: aircraftCarrier });

  const originalNow = performance.now;
  const originalDateNow = Date.now;
  let nowMs = START_MS;
  performance.now = () => nowMs;
  Date.now = () => nowMs;

  t.after(() => {
    cockpit.stop();
    app.unmount();
    globalThis.matchMedia = previousMatchMedia;
    performance.now = originalNow;
    Date.now = originalDateNow;
    getContextStore().entities.clear();
    document.body.classList.remove('cockpit-mode', 'cockpit-bridge', 'cockpit-orbit');
  });

  const frame = () => {
    nowMs += FRAME_MS;
    cockpit.update();
    return shots.at(-1);
  };
  return {
    $: (selector) => document.querySelector(selector),
    cockpit,
    viewer,
    store,
    shots,
    handler,
    carriers,
    enabled,
    frame,
    click: (position) =>
      actions.get(Cesium.ScreenSpaceEventType.LEFT_CLICK)?.({ position }),
    /** Move the satellite along its track by `deg` of latitude and longitude. */
    move(dLat, dLon) {
      subject = {
        ...subject,
        latitude: subject.latitude + dLat,
        longitude: subject.longitude + dLon,
      };
    },
    drop() {
      subject = null;
    },
  };
}

async function settle() {
  await nextTick();
  await Promise.resolve();
}

async function inOrbit(t, options) {
  const scene = fixture(t, options);
  assert.equal(scene.cockpit.enter(), true);
  await settle();
  scene.frame();
  await settle();
  return scene;
}

const angleDeg = (a, b) =>
  Cesium.Math.toDegrees(Cesium.Cartesian3.angleBetween(a, b));

const sitePosition = (key) =>
  Cesium.Cartesian3.fromDegrees(SITES[key].lon, SITES[key].lat, 0);

/** How far the camera looks from a site, degrees. */
function missDeg(shot, key) {
  const line = Cesium.Cartesian3.subtract(
    sitePosition(key),
    shot.destination,
    new Cesium.Cartesian3(),
  );
  return angleDeg(shot.direction, line);
}

/** The camera's angle from nadir, degrees. */
function offNadir(shot) {
  const toCentre = Cesium.Cartesian3.negate(shot.destination, new Cesium.Cartesian3());
  return angleDeg(shot.direction, toCentre);
}

/** The off-nadir angle to a site from the camera's position, degrees. */
function siteOffNadir(shot, key) {
  const line = Cesium.Cartesian3.subtract(
    sitePosition(key),
    shot.destination,
    new Cesium.Cartesian3(),
  );
  const toCentre = Cesium.Cartesian3.negate(shot.destination, new Cesium.Cartesian3());
  return angleDeg(line, toCentre);
}

/**
 * Run frames, the satellite drifting a little each one, and return the
 * largest turn of the camera between two frames.
 */
function run(scene, frames, { drift = 0.0005 } = {}) {
  let largest = 0;
  let previous = scene.shots.at(-1);
  for (let i = 0; i < frames; i += 1) {
    scene.move(drift, drift);
    const shot = scene.frame();
    largest = Math.max(largest, angleDeg(previous.direction, shot.direction));
    previous = shot;
  }
  return largest;
}

/** Frames enough for the focus easing to land (about 12 time constants). */
const LAND_FRAMES = Math.ceil((12 * ORBITAL_FOCUS_EASE_TAU_MS) / FRAME_MS);

/**
 * No frame turns the camera further than this: a smooth turn, no jump. The
 * focus clock moves about 6% of the way in a 16 ms frame, so even a swing
 * back from the 45° reach stays under it.
 */
const MAX_TURN_PER_FRAME_DEG = 3;

test('a click on a mapped point turns the camera onto it and holds it there', async (t) => {
  const scene = await inOrbit(t);
  const { $, cockpit, store, handler } = scene;
  const before = scene.shots.at(-1);
  assert.ok(missDeg(before, 'alpha') > 10, 'not centred at nadir');

  scene.click(SITES.alpha.at);
  assert.equal(cockpit.orbital.focus.key, 'site-alpha');
  assert.equal(handler.stockClicks, 1, 'Cesium still gets the click');

  // The first frames turn part of the way: no jump onto the target.
  const first = scene.frame();
  assert.ok(missDeg(first, 'alpha') > 5, 'still turning');
  const largest = run(scene, LAND_FRAMES);
  assert.ok(largest > 0.1 && largest < MAX_TURN_PER_FRAME_DEG, `turned ${largest}° in a frame`);

  // Landed, it holds the target dead centre while the satellite moves.
  for (let i = 0; i < 20; i += 1) {
    scene.move(0.002, 0.002);
    const shot = scene.frame();
    assert.ok(missDeg(shot, 'alpha') < 1e-5, `frame ${i}: ${missDeg(shot, 'alpha')}°`);
  }
  // Held still past a HUD beat, the readout matches the last frame.
  for (let i = 0; i < 8; i += 1) scene.frame();

  // The readout gives the single off-nadir angle to it, as image metadata does.
  await settle();
  const shot = scene.shots.at(-1);
  const readout = $('#cockpit-orbital-look-readout').textContent;
  assert.equal(readout, `OFF-NADIR ${siteOffNadir(shot, 'alpha').toFixed(1)}°`);
  assert.equal($('#cockpit-orbital-focus').textContent, 'FOCUS · Camp Alpha');
  assert.equal($('#cockpit-orbital-look-readout').getAttribute('aria-live'), 'off');
  assert.equal(
    $('.cockpit-orbital-kicker').textContent.trim(),
    'ORBITAL VIEW · OFF-NADIR',
  );
  // The swath stays approximate, scaled by the tilt onto the target.
  assert.equal(store.orbital.footprintKm, null);
  assert.ok(store.orbital.look.swathScale > 1);
  assert.match($('.cockpit-orbital-swath').textContent, /^SWATH ≈ [\d.]+ KM$/);
  assert.deepEqual(store.orbital.look.focus, { key: 'site-alpha', label: 'Camp Alpha' });

  // It keeps up with the satellite: the angle changes as it moves.
  scene.move(-0.3, -0.3);
  for (let i = 0; i < 8; i += 1) scene.frame();
  await settle();
  const later = $('#cockpit-orbital-look-readout').textContent;
  assert.notEqual(later, readout);
  assert.equal(later, `OFF-NADIR ${siteOffNadir(scene.shots.at(-1), 'alpha').toFixed(1)}°`);
});

test('a click elsewhere eases the camera back to nadir', async (t) => {
  const scene = await inOrbit(t);
  const { $, cockpit } = scene;
  scene.click(SITES.alpha.at);
  run(scene, LAND_FRAMES);
  const focused = offNadir(scene.shots.at(-1));
  assert.ok(focused > 10);

  scene.click(EMPTY_GROUND);
  assert.equal(cockpit.orbital.focus, null);
  const first = scene.frame();
  assert.ok(offNadir(first) > focused * 0.8, 'no jump back');
  const largest = run(scene, LAND_FRAMES, { drift: 0 });
  assert.ok(largest < MAX_TURN_PER_FRAME_DEG, `turned ${largest}° in a frame`);
  assert.ok(offNadir(scene.shots.at(-1)) < 1e-6, 'back at nadir');
  await settle();
  assert.equal($('.cockpit-orbital-look'), null);
  assert.equal($('#cockpit-orbital-focus').textContent, '');
});

test('a click on a moving contact is not a focus and ends one', async (t) => {
  const scene = await inOrbit(t);
  scene.click(SITES.alpha.at);
  scene.frame();
  scene.click({ x: 700, y: 700 });
  assert.equal(scene.cockpit.orbital.focus, null);
  scene.click({ x: 700, y: 700 });
  assert.equal(scene.cockpit.orbital.focus, null);
});

test('a click on the focused point again keeps the focus', async (t) => {
  const scene = await inOrbit(t);
  scene.click(SITES.alpha.at);
  run(scene, 5);
  scene.click(SITES.alpha.at);
  assert.equal(scene.cockpit.orbital.focus.key, 'site-alpha');
});

test('a click a tool owns is left alone', async (t) => {
  const scene = await inOrbit(t);
  const lease = claimPointer('draw');
  t.after(() => releasePointer(lease));
  scene.click(SITES.alpha.at);
  assert.equal(scene.cockpit.orbital.focus ?? null, null, 'no focus while drawing');
  releasePointer(lease);

  scene.click(SITES.alpha.at);
  assert.equal(scene.cockpit.orbital.focus.key, 'site-alpha');
  const again = claimPointer('draw');
  t.after(() => releasePointer(again));
  scene.click(EMPTY_GROUND);
  assert.equal(scene.cockpit.orbital.focus.key, 'site-alpha', 'kept while drawing');
});

test('the focus ends by itself, easing back, when the point leaves the reach', async (t) => {
  const scene = await inOrbit(t);
  const { cockpit } = scene;
  scene.click(SITES.bravo.at);
  run(scene, LAND_FRAMES, { drift: 0 });
  assert.ok(missDeg(scene.shots.at(-1), 'bravo') < 1e-5);
  // The satellite runs on north-east, away from the point, until the tilt
  // onto it would pass 45°.
  let released = null;
  let previous = scene.shots.at(-1);
  let largest = 0;
  for (let i = 0; i < 2000 && released === null; i += 1) {
    scene.move(0.004, 0.004);
    const shot = scene.frame();
    largest = Math.max(largest, angleDeg(previous.direction, shot.direction));
    previous = shot;
    if (!cockpit.orbital.focus) released = i;
  }
  assert.ok(released > 0, 'the focus ended');
  const atRelease = offNadir(scene.shots.at(-1));
  assert.ok(atRelease > 40, `held to the reach (${atRelease}°)`);
  largest = Math.max(largest, run(scene, LAND_FRAMES, { drift: 0 }));
  assert.ok(largest < MAX_TURN_PER_FRAME_DEG, `turned ${largest}° in a frame`);
  assert.ok(offNadir(scene.shots.at(-1)) < 1e-6, 'back at nadir');
});

test('a mapped point beyond the reach cannot be focused', async (t) => {
  const scene = await inOrbit(t);
  scene.click(SITES.far.at);
  assert.equal(scene.cockpit.orbital.focus ?? null, null);
  assert.equal(scene.cockpit.toggleOrbitalFocus('site-far'), false);
});

test('the reach list offers the points in reach with details and FOCUS', async (t) => {
  const scene = await inOrbit(t);
  const { $, store, cockpit } = scene;
  await settle();
  const reach = store.orbitalReach;
  assert.ok(reach, 'published in orbit');
  // Nearest to nadir first; moving contacts and points beyond reach and
  // frame are left out.
  const keys = reach.entries.map((entry) => entry.key);
  assert.ok(keys.includes('site-alpha') && keys.includes('site-bravo'));
  assert.ok(!keys.includes('flight-abc'));
  assert.ok(!keys.includes('site-far'));
  const angles = reach.entries.map((entry) => entry.offNadirDeg);
  assert.deepEqual(angles, [...angles].sort((a, b) => a - b));
  assert.equal(reach.count, reach.entries.length);

  const toggle = $('#cockpit-orbital-reach-toggle');
  assert.equal(toggle.textContent, `IN REACH · ${reach.count}`);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal($('#cockpit-orbital-reach-body').style.display, 'none');
  toggle.click();
  await settle();
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.notEqual($('#cockpit-orbital-reach-body').style.display, 'none');

  const row = (key) => $(`[data-orbital-reach-key="${key}"]`);
  const name = row('site-alpha').querySelector('.cockpit-orbital-reach-name');
  assert.match(name.textContent, /Camp Alpha/);
  name.click();
  await settle();
  assert.equal(name.getAttribute('aria-expanded'), 'true');
  const details = $('#cockpit-orbital-reach-details');
  assert.match(details.textContent, /OPENSTREETMAP TAGS/);
  assert.match(details.textContent, /military\s*base/);
  assert.doesNotMatch(details.textContent, /_internal/);
  assert.equal(name.getAttribute('aria-controls'), 'cockpit-orbital-reach-details');

  // FOCUS through the delegated listener, as a person presses it.
  const focusButton = (key) => row(key).querySelector('[data-orbital-focus]');
  assert.equal(focusButton('site-alpha').getAttribute('aria-label'), 'Keep the camera on Camp Alpha');
  focusButton('site-alpha').click();
  assert.equal(cockpit.orbital.focus.key, 'site-alpha');
  await settle();
  assert.equal(focusButton('site-alpha').getAttribute('aria-pressed'), 'true');
  assert.equal(focusButton('site-bravo').getAttribute('aria-pressed'), 'false');
  // The list takes its own clicks: none reaches the picture to end the focus.
  run(scene, LAND_FRAMES);
  assert.ok(missDeg(scene.shots.at(-1), 'alpha') < 1e-5);

  // FOCUS on another point switches to it, turning rather than jumping.
  focusButton('site-bravo').click();
  assert.equal(cockpit.orbital.focus.key, 'site-bravo');
  const largest = run(scene, LAND_FRAMES);
  assert.ok(largest < MAX_TURN_PER_FRAME_DEG, `turned ${largest}° in a frame`);
  assert.ok(missDeg(scene.shots.at(-1), 'bravo') < 1e-5);
  await settle();
  assert.equal(focusButton('site-alpha').getAttribute('aria-pressed'), 'false');
  assert.equal(focusButton('site-bravo').getAttribute('aria-pressed'), 'true');

  // FOCUS on the focused point ends the focus.
  focusButton('site-bravo').click();
  assert.equal(cockpit.orbital.focus, null);
  run(scene, LAND_FRAMES, { drift: 0 });
  assert.ok(offNadir(scene.shots.at(-1)) < 1e-6);
});

test('a point in frame but beyond the reach is listed without FOCUS', async (t) => {
  const scene = await inOrbit(t);
  // Tilt the view toward the far point with the arrows: it comes into frame
  // but a focus on it would pass 45°.
  const press = (key) =>
    scene.cockpit.onKeyDown({
      key,
      target: document.body,
      preventDefault() {},
      stopImmediatePropagation() {},
    });
  for (let i = 0; i < 9; i += 1) press('ArrowLeft');
  run(scene, 2 * LAND_FRAMES, { drift: 0 });
  // Rebuild the list on the next frame.
  scene.cockpit.orbital.reachMs = -Infinity;
  scene.frame();
  await settle();
  const far = scene.store.orbitalReach.entries.find((entry) => entry.key === 'site-far');
  assert.ok(far, 'listed while in frame');
  assert.equal(far.reachable, false);
  scene.$('#cockpit-orbital-reach-toggle').click();
  await settle();
  const button = scene.$('[data-orbital-reach-key="site-far"] [data-orbital-focus]');
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  assert.equal(button.title, 'Beyond the off-nadir reach');
  button.click();
  assert.equal(scene.cockpit.orbital.focus ?? null, null);
});

test('turning the layer off or dropping the point ends the focus', async (t) => {
  const scene = await inOrbit(t);
  scene.click(SITES.alpha.at);
  run(scene, 5);
  scene.enabled.delete(LAYER);
  scene.frame();
  assert.equal(scene.cockpit.orbital.focus, null, 'layer off');
  assert.equal(scene.cockpit.orbital.focusReleasing, true, 'easing back');
  scene.cockpit.orbital.reachMs = -Infinity;
  scene.frame();
  assert.equal(scene.store.orbitalReach.count, 0, 'nothing listed from a layer that is off');

  scene.enabled.add(LAYER);
  scene.click(SITES.bravo.at);
  run(scene, 5);
  getContextStore().entities.delete('site-bravo');
  scene.frame();
  assert.equal(scene.cockpit.orbital.focus, null, 'point dropped');

  scene.click(SITES.alpha.at);
  run(scene, 5);
  scene.carriers.alpha.show = false;
  scene.frame();
  assert.equal(scene.cockpit.orbital.focus, null, 'point hidden');
});

test('leaving orbit while focused clears the focus and the list', async (t) => {
  const scene = await inOrbit(t);
  scene.click(SITES.alpha.at);
  run(scene, 5);
  scene.drop();
  scene.frame();
  assert.equal(scene.cockpit.active, false);
  assert.equal(scene.store.orbitalReach, null);
  assert.equal(scene.store.orbital, null);
  // Late clicks and presses after the exit do nothing.
  scene.click(SITES.bravo.at);
  assert.equal(scene.cockpit.toggleOrbitalFocus('site-bravo'), false);
  assert.equal(scene.cockpit.onOrbitalClick(SITES.bravo.at), false);
  assert.equal(scene.handler.stockClicks, 2, 'Cesium kept its clicks');
});

test('NADIR and Home end a focus; an arrow takes the view over where it is', async (t) => {
  const scene = await inOrbit(t);
  const { $, cockpit } = scene;
  const press = (key) =>
    cockpit.onKeyDown({
      key,
      target: document.body,
      preventDefault() {},
      stopImmediatePropagation() {},
    });
  scene.click(SITES.alpha.at);
  run(scene, LAND_FRAMES);
  await settle();
  $('#cockpit-orbital-nadir').click();
  assert.equal(cockpit.orbital.focus, null);
  assert.ok(offNadir(scene.frame()) > 5, 'eases back');

  scene.click(SITES.alpha.at);
  run(scene, LAND_FRAMES);
  press('Home');
  assert.equal(cockpit.orbital.focus, null);

  scene.click(SITES.alpha.at);
  run(scene, LAND_FRAMES);
  const held = { ...cockpit.orbital.lookView };
  press('ArrowUp');
  assert.equal(cockpit.orbital.focus, null);
  // The step continues from the focused look, on the 5° grid.
  assert.equal(cockpit.orbital.lookTarget.pitchDeg, Math.floor(held.pitchDeg / 5 + 1e-9) * 5 + 5);
  const largest = run(scene, LAND_FRAMES, { drift: 0 });
  assert.ok(largest < MAX_TURN_PER_FRAME_DEG);
});

test('reduced motion cuts onto the point and back', async (t) => {
  const scene = await inOrbit(t, { reducedMotion: true });
  scene.click(SITES.alpha.at);
  assert.ok(missDeg(scene.frame(), 'alpha') < 1e-5, 'on it at once');
  scene.click(EMPTY_GROUND);
  assert.ok(offNadir(scene.frame()) < 1e-6, 'back at once');
});

test('stopping the Cockpit hands the single click back to Cesium', async (t) => {
  const scene = fixture(t);
  const type = Cesium.ScreenSpaceEventType.LEFT_CLICK;
  assert.notEqual(scene.handler.getInputAction(type), scene.handler.stock);
  scene.cockpit.stop();
  assert.equal(scene.handler.getInputAction(type), scene.handler.stock);
  scene.click(EMPTY_GROUND);
  assert.equal(scene.handler.stockClicks, 1);
  assert.equal(scene.cockpit.orbital, null);
});
