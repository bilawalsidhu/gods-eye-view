// src/ui/cockpitOrbitalFocus.test.mjs — the orbital view's Live Signals
// rows and its ground focus: the rows list the Mapped Installations layer's
// sites around the satellite (getNearby) and the nearest satellites; a site
// row, or a click on the site's marker (the layer's pick ids), turns the
// camera onto it and holds it as the satellite moves; a click elsewhere, the
// row again, NADIR or the site leaving the reach eases the view back, never
// in one jump; a satellite row rides that satellite and stays in orbit.
// The layers are stubs with the real methods' shapes. Over happy-dom.
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
import { claimPointer, releasePointer } from '../data/inputOwnership.js';
import { ORBITAL_FOCUS_EASE_TAU_MS } from '../cockpitOrbitalFocus.js';
import { ORBITAL_HOP_MS } from '../cockpitOrbitalSatellites.js';

const START_MS = 1_800_000_000_000;
const ASPECT = 16 / 9;
const FRAME_MS = 16;

/** Satellites the layer knows, by NORAD id: the ridden one and its neighbours. */
const SATELLITES = Object.freeze({
  25544: { name: 'ISS (ZARYA)', lat: 30, lon: -97, alt: 420_000, cls: 'stations' },
  49260: { name: 'LANDSAT 9', lat: 31.5, lon: -95, alt: 705_000, cls: 'imaging' },
  40697: { name: 'SENTINEL-2A', lat: 26, lon: -99, alt: 786_000, cls: 'imaging' },
  99001: { name: 'DEB FRAGMENT', lat: 30.2, lon: -97.1, alt: 430_000, cls: 'debris' },
});

/** Mapped sites as the installations layer keeps them. */
const SITES = Object.freeze({
  alpha: {
    id: 'osm:military:way/101',
    osmKey: 'way/101',
    name: 'Camp Alpha',
    class: 'base',
    lat: 31,
    lon: -96.5,
    memberNames: ['North Field'],
    at: { x: 100, y: 100 },
  },
  bravo: {
    id: 'osm:military:way/202',
    osmKey: 'way/202',
    name: 'Bravo Field',
    class: 'airfield',
    lat: 29.2,
    lon: -97.8,
    at: { x: 300, y: 300 },
  },
  // Beyond the ±45° reach of the ISS at its start.
  far: {
    id: 'osm:military:way/303',
    osmKey: 'way/303',
    name: 'Far Range',
    class: 'range',
    lat: 33.5,
    lon: -101,
    at: { x: 500, y: 50 },
  },
});

const EMPTY_GROUND = Object.freeze({ x: 640, y: 360 });

/** The Mapped Installations layer: its records, getNearby, getById, findByPick. */
function installationsLayer() {
  const records = Object.values(SITES).map((site) => ({
    id: site.id,
    osmKey: site.osmKey,
    name: site.name,
    class: site.class,
    kind: 'installation',
    latitude: site.lat,
    longitude: site.lon,
    memberNames: site.memberNames || [],
    sources: [{ name: 'OpenStreetMap', id: site.osmKey }],
  }));
  const layer = {
    enabled: true,
    records,
    calls: { getNearby: 0 },
    withPosition(record) {
      return {
        ...record,
        position: Cesium.Cartesian3.fromDegrees(record.longitude, record.latitude, 0),
      };
    },
    // As the layer's own: loaded installations within `rangeM` of
    // `center`, nearest first, each with its drawn position and distance.
    getNearby(center, rangeM, maxCount = 50) {
      layer.calls.getNearby += 1;
      if (!center) return [];
      const from = Cesium.Cartographic.fromCartesian(center);
      const geodesic = new Cesium.EllipsoidGeodesic();
      return layer.records
        .filter((record) => record.kind === 'installation')
        .map((record) => {
          geodesic.setEndPoints(
            from,
            Cesium.Cartographic.fromDegrees(record.longitude, record.latitude),
          );
          return { ...layer.withPosition(record), distanceM: geodesic.surfaceDistance };
        })
        .filter((record) => record.distanceM <= rangeM)
        .sort((a, b) => a.distanceM - b.distanceM)
        .slice(0, maxCount);
    },
    getById(id) {
      if (!layer.enabled) return null;
      const record = layer.records.find((r) => r.id === String(id));
      return record ? layer.withPosition(record) : null;
    },
    findByPick(picked) {
      const id =
        picked?.id?.installationId ||
        (typeof picked?.id?.id === 'string' ? picked.id.id : null);
      return id ? layer.getById(id) : null;
    },
  };
  return layer;
}

/** The satellites layer: tracking, the Cockpit subject and every position. */
function satellitesLayer(viewer) {
  const positions = new Map(
    Object.entries(SATELLITES).map(([id, sat]) => [Number(id), { ...sat }]),
  );
  const layer = {
    tracked: 25544,
    calls: [],
    position(id) {
      const sat = positions.get(id);
      return Cesium.Cartesian3.fromDegrees(sat.lon, sat.lat, sat.alt);
    },
    move(dLat, dLon) {
      const sat = positions.get(layer.tracked);
      sat.lat += dLat;
      sat.lon += dLon;
    },
    getCockpitSubject() {
      if (layer.tracked === null) return null;
      const sat = positions.get(layer.tracked);
      return {
        kind: 'satellite',
        layerId: 'satellites',
        id: String(layer.tracked),
        noradId: layer.tracked,
        name: sat.name,
        classLabel: sat.cls.toUpperCase(),
        latitude: sat.lat,
        longitude: sat.lon,
        altitudeM: sat.alt,
        velocityMps: 7_600,
        groundTrackDeg: 51.6,
        satelliteClass: sat.cls,
        stale: false,
      };
    },
    getCockpitPosition(result) {
      if (layer.tracked === null) return null;
      return Cesium.Cartesian3.clone(layer.position(layer.tracked), result);
    },
    getAllPositions(maxCount = 300) {
      return [...positions.entries()].slice(0, maxCount).map(([id, sat]) => ({
        id,
        label: sat.name,
        position: layer.position(id),
        latitude: sat.lat,
        longitude: sat.lon,
        altitudeM: sat.alt,
        satelliteClass: sat.cls,
      }));
    },
    // As the layer's: the nearest shown satellites, bounded, with the
    // asked-for ids and classes left out.
    getNearestPositions(center, maxCount = 8, { excludeIds = [], excludeClasses = [] } = {}) {
      layer.calls.push(['nearest']);
      const skip = new Set(excludeIds.map(String));
      return layer
        .getAllPositions()
        .filter((entry) => !skip.has(String(entry.id)))
        .filter((entry) => !excludeClasses.includes(entry.satelliteClass))
        .map((entry) => ({
          ...entry,
          distanceM: Cesium.Cartesian3.distance(center, entry.position),
        }))
        .sort((a, b) => a.distanceM - b.distanceM)
        .slice(0, maxCount);
    },
    /** The satellite leaves the catalogue. */
    remove(id) {
      positions.delete(Number(id));
    },
    // As the layer's: tracking hands the camera to Cesium's follow.
    trackById(noradId) {
      const id = Number(noradId);
      if (!positions.has(id)) return false;
      layer.calls.push(['track', id]);
      layer.tracked = id;
      viewer.trackedEntity = { position: { getValue: () => layer.position(id) } };
      return true;
    },
    setCockpitSubject(noradId) {
      layer.calls.push(['subject', noradId]);
      return true;
    },
    refocusTrackedById: () => true,
    drop() {
      layer.tracked = null;
    },
  };
  return layer;
}

function fixture(t, { reducedMotion = false } = {}) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(
    defineComponent(() => () => [h(ContextView), h(IntelHudView), h(CockpitView)]),
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
  // selectedEntity; its double-click tracks what it picks, which would end
  // the orbital view.
  const actions = new Map();
  const handler = {
    stockClicks: 0,
    stockDoubleClicks: 0,
    getInputAction: (type) => actions.get(type),
    setInputAction: (action, type) => actions.set(type, action),
    removeInputAction: (type) => actions.delete(type),
    isDestroyed: () => false,
  };
  handler.stock = () => {
    handler.stockClicks += 1;
  };
  handler.stockDouble = ({ position }) => {
    handler.stockDoubleClicks += 1;
    const picked = viewer.scene.pick(position);
    viewer.trackedEntity = picked
      ? { position: { getValue: () => null } }
      : undefined;
  };
  actions.set(Cesium.ScreenSpaceEventType.LEFT_CLICK, handler.stock);
  actions.set(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK, handler.stockDouble);
  viewer.screenSpaceEventHandler = handler;

  const sites = installationsLayer();
  const satellites = satellitesLayer(viewer);
  const modeEvents = [];
  const onMode = (event) => modeEvents.push(event.detail);
  window.addEventListener('gev:cockpit-mode-changed', onMode);
  const cockpit = new CockpitViewController(viewer, {
    services: {
      flightsLayer: { getTrackedInfo: () => null },
      militaryFlightsLayer: { getTrackedInfo: () => null },
      aisLiveVesselsLayer: { getCockpitSubject: () => null },
      satellitesLayer: satellites,
      militaryInstallationsLayer: sites,
      militaryAwarenessLayer: {},
      isLayerEnabled: (layerId) =>
        layerId === 'military-installations' ? sites.enabled : true,
      isTr3b: () => false,
      holdContinuousRender() {},
      releaseContinuousRender() {},
      cachedGroundFloor: () => null,
      GROUND_FLOOR_LIFT_M: 0,
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
      signals: (rows) => store.publishSignals(rows),
    },
  });
  Object.assign(cockpit, {
    setVisionMode() {},
    showBriefPage() {},
    startBriefRotation() {},
    stopBriefRotation() {},
    scheduleContextLayout() {},
    updateLocalPosition() {},
    maybeRefreshRegionalBrief() {},
    updateContext() {},
    updateRoute() {},
  });
  // Named markers pick as `{ installationId }`, as the layer draws them.
  for (const site of Object.values(SITES))
    picks.set(`${site.at.x},${site.at.y}`, {
      id: { installationId: site.id },
      primitive: {},
    });

  const originalNow = performance.now;
  const originalDateNow = Date.now;
  let nowMs = START_MS;
  performance.now = () => nowMs;
  Date.now = () => nowMs;

  t.after(() => {
    window.removeEventListener('gev:cockpit-mode-changed', onMode);
    cockpit.stop();
    app.unmount();
    globalThis.matchMedia = previousMatchMedia;
    performance.now = originalNow;
    Date.now = originalDateNow;
    document.body.classList.remove('cockpit-mode', 'cockpit-bridge', 'cockpit-orbit');
  });

  const frame = () => {
    nowMs += FRAME_MS;
    cockpit.update();
    return shots.at(-1);
  };
  const fire = (type, position) => actions.get(type)?.({ position });
  return {
    $: (selector) => document.querySelector(selector),
    cockpit,
    viewer,
    store,
    shots,
    handler,
    sites,
    satellites,
    modeEvents,
    frame,
    click: (position) => fire(Cesium.ScreenSpaceEventType.LEFT_CLICK, position),
    /** A double-click as Cesium fires it: two clicks, then the double. */
    doubleClick(position) {
      fire(Cesium.ScreenSpaceEventType.LEFT_CLICK, position);
      fire(Cesium.ScreenSpaceEventType.LEFT_CLICK, position);
      fire(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK, position);
    },
    /** Rebuild the Context card on the next frame, past its clock. */
    refreshCard() {
      nowMs += 1000;
      cockpit.update();
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
  scene.refreshCard();
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
    scene.satellites.move(drift, drift);
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

/** A Live Signals row's button, by layer and id. */
const rowButton = (scene, layerId, id) =>
  scene.$(
    `#cockpit-signal-list button[data-signal-layer="${layerId}"][data-signal-id="${id}"]`,
  );
const siteRow = (scene, key) =>
  rowButton(scene, 'military-installations', SITES[key].id);
const satelliteRow = (scene, id) => rowButton(scene, 'satellites', String(id));
/** The rows as published: title, detail, tone and target. */
const rows = (scene) => scene.store.signals ?? [];
/** Rebuild the rows and let the view render them. */
async function refreshRows(scene) {
  scene.refreshCard();
  await settle();
}

test('in orbit Live Signals lists the sites getNearby finds and the nearest satellites', async (t) => {
  const scene = await inOrbit(t);
  const { $, sites } = scene;
  assert.ok(sites.calls.getNearby > 0, 'asked the installations layer');
  assert.equal($('#cockpit-context').hidden, true, 'no Contact card in orbit');
  const shown = rows(scene);
  assert.ok(shown.length <= 5, 'five rows at most');
  assert.equal(shown[0].title, 'TRACK ACQUIRED', 'the track row stays first');
  // Two site rows, nearest to nadir first, then the satellites (debris out).
  const sitesShown = shown.filter((row) => row.target?.layerId === 'military-installations');
  assert.deepEqual(
    sitesShown.map((row) => row.target.id).sort(),
    [SITES.alpha.id, SITES.bravo.id].sort(),
  );
  for (const row of sitesShown) {
    assert.match(row.detail, /^(BASE|AIRFIELD) · OFF-NADIR \d+\.\d°$/);
    assert.match(row.className, /nearby actionable/);
  }
  const satellitesShown = shown.filter((row) => row.target?.layerId === 'satellites');
  assert.deepEqual(satellitesShown.map((row) => row.title), ['LANDSAT 9', 'SENTINEL-2A']);
  assert.match(satellitesShown[0].detail, /^SATELLITE · (AHEAD|[LR] \d{3}°) · [\d,.]+\s+KM$/);
  // Each row names its own action.
  assert.equal(siteRow(scene, 'alpha').getAttribute('aria-label'), 'Keep the camera on Camp Alpha');
  assert.equal(satelliteRow(scene, 49260).getAttribute('aria-label'), 'Ride LANDSAT 9');
  // Rebuilt on the clock, rows keep their keys and times.
  const before = shown.map((row) => [row.key, row.time]);
  await refreshRows(scene);
  assert.deepEqual(rows(scene).map((row) => [row.key, row.time]), before);
});

test('a site row turns the camera onto it, holds it, and reads its off-nadir angle', async (t) => {
  const scene = await inOrbit(t);
  const { $, cockpit, store } = scene;
  assert.ok(missDeg(scene.shots.at(-1), 'alpha') > 10, 'not centred at nadir');
  siteRow(scene, 'alpha').click();
  assert.equal(cockpit.orbital.focus.key, SITES.alpha.id);
  // The first frames turn part of the way: no jump onto the site.
  assert.ok(missDeg(scene.frame(), 'alpha') > 5, 'still turning');
  const largest = run(scene, LAND_FRAMES);
  assert.ok(largest > 0.1 && largest < MAX_TURN_PER_FRAME_DEG, `turned ${largest}° in a frame`);
  for (let i = 0; i < 20; i += 1) {
    scene.satellites.move(0.002, 0.002);
    const shot = scene.frame();
    assert.ok(missDeg(shot, 'alpha') < 1e-5, `frame ${i}: ${missDeg(shot, 'alpha')}°`);
  }
  for (let i = 0; i < 8; i += 1) scene.frame();
  await settle();
  const shot = scene.shots.at(-1);
  assert.equal(
    $('#cockpit-orbital-look-readout').textContent,
    `OFF-NADIR ${siteOffNadir(shot, 'alpha').toFixed(1)}°`,
  );
  assert.equal($('#cockpit-orbital-focus').textContent, 'FOCUS · Camp Alpha');
  assert.equal($('#cockpit-orbital-look-readout').getAttribute('aria-live'), 'off');
  assert.equal(store.orbital.footprintKm, null);
  assert.match($('.cockpit-orbital-swath').textContent, /^SWATH ≈ [\d.]+ KM$/);
  // The held site's row reads as the subject does, first among the sites.
  const held = rows(scene).find((row) => row.target?.id === SITES.alpha.id);
  assert.match(held.className, /^track actionable$/);
  assert.match(held.detail, /^FOCUS · BASE · OFF-NADIR/);
  assert.equal(siteRow(scene, 'alpha').getAttribute('aria-label'), 'Release the camera from Camp Alpha');
});

test('another site row switches the focus; the held site row ends it', async (t) => {
  const scene = await inOrbit(t);
  const { cockpit } = scene;
  siteRow(scene, 'alpha').click();
  run(scene, LAND_FRAMES);
  await settle();
  siteRow(scene, 'bravo').click();
  assert.equal(cockpit.orbital.focus.key, SITES.bravo.id);
  const largest = run(scene, LAND_FRAMES);
  assert.ok(largest < MAX_TURN_PER_FRAME_DEG, `turned ${largest}° in a frame`);
  assert.ok(missDeg(scene.shots.at(-1), 'bravo') < 1e-5);
  await settle();
  assert.match(rows(scene).find((row) => row.target?.id === SITES.alpha.id).className, /^nearby/);
  siteRow(scene, 'bravo').click();
  assert.equal(cockpit.orbital.focus, null);
  const back = run(scene, LAND_FRAMES, { drift: 0 });
  assert.ok(back < MAX_TURN_PER_FRAME_DEG);
  assert.ok(offNadir(scene.shots.at(-1)) < 1e-6, 'back at nadir');
});

test('a click on a site marker focuses it through the layer; a click elsewhere eases back', async (t) => {
  const scene = await inOrbit(t);
  const { cockpit, handler } = scene;
  scene.click(SITES.alpha.at);
  assert.equal(cockpit.orbital.focus.key, SITES.alpha.id);
  assert.equal(handler.stockClicks, 1, 'Cesium still gets the click');
  run(scene, LAND_FRAMES);
  assert.ok(missDeg(scene.shots.at(-1), 'alpha') < 1e-5);
  scene.click(SITES.alpha.at);
  assert.equal(cockpit.orbital.focus.key, SITES.alpha.id, 'kept on a second click');
  const focused = offNadir(scene.shots.at(-1));
  scene.click(EMPTY_GROUND);
  assert.equal(cockpit.orbital.focus, null);
  assert.ok(offNadir(scene.frame()) > focused * 0.8, 'no jump back');
  const largest = run(scene, LAND_FRAMES, { drift: 0 });
  assert.ok(largest < MAX_TURN_PER_FRAME_DEG);
  assert.ok(offNadir(scene.shots.at(-1)) < 1e-6);
  // A site beyond the reach is not focused, and ends a focus as a click
  // elsewhere does.
  scene.click(SITES.far.at);
  assert.equal(cockpit.orbital.focus ?? null, null);
  scene.click(SITES.alpha.at);
  assert.equal(cockpit.orbital.focus.key, SITES.alpha.id);
  scene.click(SITES.far.at);
  assert.equal(cockpit.orbital.focus, null);
});

test('a click a tool owns is left alone', async (t) => {
  const scene = await inOrbit(t);
  const lease = claimPointer('draw');
  t.after(() => releasePointer(lease));
  scene.click(SITES.alpha.at);
  assert.equal(scene.cockpit.orbital.focus ?? null, null, 'no focus while drawing');
  releasePointer(lease);
  scene.click(SITES.alpha.at);
  const again = claimPointer('draw');
  t.after(() => releasePointer(again));
  scene.click(EMPTY_GROUND);
  assert.equal(scene.cockpit.orbital.focus.key, SITES.alpha.id, 'kept while drawing');
});

test('a double-click on a site focuses it and keeps the orbital view', async (t) => {
  const scene = await inOrbit(t);
  const { cockpit, viewer, handler } = scene;
  scene.doubleClick(SITES.alpha.at);
  assert.equal(handler.stockDoubleClicks, 0, 'Cesium does not track the site');
  assert.equal(viewer.trackedEntity, undefined);
  scene.frame();
  assert.equal(cockpit.active, true, 'still in orbit');
  assert.equal(cockpit.orbital.focus.key, SITES.alpha.id);
  scene.doubleClick(SITES.bravo.at);
  assert.equal(cockpit.orbital.focus.key, SITES.bravo.id);
  scene.doubleClick(SITES.far.at);
  assert.equal(handler.stockDoubleClicks, 0, 'beyond reach: not focused, not tracked');
  scene.frame();
  assert.equal(cockpit.active, true);
  scene.doubleClick(EMPTY_GROUND);
  assert.equal(handler.stockDoubleClicks, 1, 'anywhere else goes on to Cesium');
});

test('the focus ends by itself, easing back, when the site leaves the reach', async (t) => {
  const scene = await inOrbit(t);
  const { cockpit } = scene;
  siteRow(scene, 'bravo').click();
  run(scene, LAND_FRAMES, { drift: 0 });
  let released = null;
  let previous = scene.shots.at(-1);
  let largest = 0;
  for (let i = 0; i < 2000 && released === null; i += 1) {
    scene.satellites.move(0.004, 0.004);
    const shot = scene.frame();
    largest = Math.max(largest, angleDeg(previous.direction, shot.direction));
    previous = shot;
    if (!cockpit.orbital.focus) released = i;
  }
  assert.ok(released > 0, 'the focus ended');
  assert.ok(offNadir(scene.shots.at(-1)) > 40, 'held to the reach');
  largest = Math.max(largest, run(scene, LAND_FRAMES, { drift: 0 }));
  assert.ok(largest < MAX_TURN_PER_FRAME_DEG, `turned ${largest}° in a frame`);
  assert.ok(offNadir(scene.shots.at(-1)) < 1e-6, 'back at nadir');
});

test('turning the layer off ends the focus and says why; a reload around the site keeps it', async (t) => {
  const scene = await inOrbit(t);
  scene.click(SITES.alpha.at);
  run(scene, 5);
  scene.sites.enabled = false;
  scene.frame();
  assert.equal(scene.cockpit.orbital.focus, null, 'layer off');
  assert.equal(scene.cockpit.orbital.focusReleasing, true, 'easing back');
  await refreshRows(scene);
  const status = rows(scene).find((row) => row.title === 'SITES STANDBY');
  assert.ok(status, 'a status row says why no site is listed');
  assert.equal(status.detail, 'ENABLE MAPPED INSTALLATIONS FOR SITE PINGS');
  assert.equal(status.className, 'warning');
  assert.ok(!rows(scene).some((row) => row.target?.layerId === 'military-installations'));
  assert.equal(rows(scene).filter((row) => row.target?.layerId === 'satellites').length, 2);
  scene.sites.enabled = true;
  await refreshRows(scene);
  assert.ok(!rows(scene).some((row) => row.title === 'SITES STANDBY'));
  scene.click(SITES.bravo.at);
  run(scene, LAND_FRAMES);
  // The layer reloads its thinned view: the site leaves its records for a
  // while. It has not moved, so the focus stays on it.
  const loaded = scene.sites.records;
  scene.sites.records = loaded.filter((r) => r.id !== SITES.bravo.id);
  run(scene, 10);
  assert.equal(scene.cockpit.orbital.focus.key, SITES.bravo.id, 'kept through a reload');
  assert.ok(missDeg(scene.shots.at(-1), 'bravo') < 1e-5, 'still centred');
  scene.sites.records = loaded;
  // A row the list shows works even if the layer just dropped its site.
  await refreshRows(scene);
  scene.sites.records = loaded.filter((r) => r.id !== SITES.alpha.id);
  siteRow(scene, 'alpha').click();
  assert.equal(scene.cockpit.orbital.focus.key, SITES.alpha.id);
});

test('a satellite row rides it, staying in orbit; RETURN goes back', async (t) => {
  const scene = await inOrbit(t);
  const { cockpit, satellites, viewer, modeEvents } = scene;
  assert.ok(!rows(scene).some((row) => row.title.startsWith('RETURN')), 'no history yet');
  siteRow(scene, 'alpha').click();
  run(scene, 5);
  const before = Cesium.Cartesian3.clone(scene.shots.at(-1).destination);

  const firstTrack = cockpit.signalItems.find((item) => item.key === 'track');
  firstTrack.timestamp -= 60_000;
  satelliteRow(scene, 49260).click();
  const newTrack = cockpit.signalItems.filter((item) => item.key === 'track');
  assert.equal(newTrack.length, 1);
  assert.ok(newTrack[0].timestamp > firstTrack.timestamp, 'the new ride’s own time');
  assert.deepEqual(satellites.calls.slice(-2), [['track', 49260], ['subject', 49260]]);
  assert.equal(viewer.trackedEntity, undefined, 'the Cockpit keeps the camera');
  assert.equal(cockpit.subjectId, 49260);
  assert.equal(cockpit.orbital.focus, null, 'the focus is reset');
  assert.equal(modeEvents.at(-1)?.active, true);
  await settle();
  const shown = rows(scene);
  assert.deepEqual([shown[0].title, shown[0].detail], ['TRACK ACQUIRED', 'LANDSAT 9 · NADIR VIEW']);
  assert.equal(shown.filter((row) => row.title === 'TRACK ACQUIRED').length, 1);
  const back = shown.find((row) => row.title === 'RETURN · ISS (ZARYA)');
  assert.ok(back, 'a RETURN row while there is history');
  assert.equal(back.detail, 'PREVIOUS SATELLITE');
  assert.equal(satelliteRow(scene, 25544).getAttribute('aria-label'), 'Return to ISS (ZARYA)');
  assert.ok(!shown.some((row) => row.title === 'ISS (ZARYA)'), 'listed once, as RETURN');

  // The camera hops along the way, never in one jump.
  const target = satellites.position(49260);
  const hopM = Cesium.Cartesian3.distance(before, target);
  let previous = before;
  let largestStep = 0;
  for (let i = 0; i < Math.ceil(ORBITAL_HOP_MS / FRAME_MS) + 2; i += 1) {
    const shot = scene.frame();
    assert.equal(cockpit.active, true, `still in orbit at frame ${i}`);
    largestStep = Math.max(largestStep, Cesium.Cartesian3.distance(previous, shot.destination));
    previous = shot.destination;
  }
  assert.ok(largestStep < hopM * 0.1, `largest step ${largestStep} m of ${hopM} m`);
  assert.ok(Cesium.Cartesian3.distance(previous, target) < 1, 'landed on the satellite');
  run(scene, LAND_FRAMES, { drift: 0 });
  assert.ok(offNadir(scene.shots.at(-1)) < 1e-6, 'looking at nadir');

  // On to another, then RETURN twice back to the start.
  await refreshRows(scene);
  satelliteRow(scene, 40697).click();
  assert.equal(cockpit.subjectId, 40697);
  await settle();
  assert.ok(rows(scene).some((row) => row.title === 'RETURN · LANDSAT 9'));
  satelliteRow(scene, 49260).click();
  assert.equal(cockpit.subjectId, 49260);
  await settle();
  satelliteRow(scene, 25544).click();
  assert.equal(cockpit.subjectId, 25544);
  await settle();
  assert.ok(!rows(scene).some((row) => row.title.startsWith('RETURN')), 'back at the start');
  scene.frame();
  assert.equal(cockpit.active, true);
  assert.ok(!satellites.calls.some(([, id]) => id === 99001), 'debris never offered');
});

test('while the camera hops, no stale rows; on landing, rows measured from the new satellite', async (t) => {
  const scene = await inOrbit(t);
  const { cockpit } = scene;
  satelliteRow(scene, 49260).click();
  await settle();
  // Mid-hop: TRACK ACQUIRED and RETURN only, nothing measured from the old
  // satellite's frame (which would list LANDSAT 9 itself at 0 km).
  let shown = rows(scene);
  assert.deepEqual(
    shown.map((row) => row.title),
    ['TRACK ACQUIRED', 'RETURN · ISS (ZARYA)'],
  );
  scene.frame();
  scene.refreshCard();
  await settle();
  assert.ok(cockpit.orbital.hop, 'still hopping');
  assert.deepEqual(rows(scene).map((row) => row.title), ['TRACK ACQUIRED', 'RETURN · ISS (ZARYA)']);
  // Landed: the first frame on the satellite rebuilds them at once.
  for (let i = 0; i < Math.ceil(ORBITAL_HOP_MS / FRAME_MS) + 2; i += 1) scene.frame();
  await settle();
  shown = rows(scene);
  assert.ok(shown.some((row) => row.target?.layerId === 'military-installations'), 'sites back');
  const satellitesShown = shown.filter((row) => row.title !== 'TRACK ACQUIRED' && row.target?.layerId === 'satellites');
  assert.ok(!satellitesShown.some((row) => row.title === 'LANDSAT 9'), 'never the ridden one');
  assert.equal(satellitesShown.filter((row) => row.target.id === '25544').length, 1, 'ISS only as RETURN');
});

test('RETURN to a satellite that left the catalogue offers the one before it', async (t) => {
  const scene = await inOrbit(t);
  const { cockpit, satellites } = scene;
  satelliteRow(scene, 49260).click();
  for (let i = 0; i < 80; i += 1) scene.frame();
  await settle();
  satelliteRow(scene, 40697).click();
  for (let i = 0; i < 80; i += 1) scene.frame();
  await settle();
  assert.ok(rows(scene).some((row) => row.title === 'RETURN · LANDSAT 9'));
  satellites.remove(49260);
  satelliteRow(scene, 49260).click();
  assert.equal(cockpit.subjectId, 40697, 'still on the same satellite');
  await settle();
  assert.ok(rows(scene).some((row) => row.title === 'RETURN · ISS (ZARYA)'), 'the one before');
  satelliteRow(scene, 25544).click();
  assert.equal(cockpit.subjectId, 25544);
});

test('with Installations off no site is offered, by row, list or click', async (t) => {
  const scene = await inOrbit(t);
  const { cockpit, sites } = scene;
  // The real layer keeps its records and getNearby answers while off.
  sites.enabled = false;
  await refreshRows(scene);
  assert.ok(rows(scene).some((row) => row.title === 'SITES STANDBY'));
  assert.equal(cockpit.orbital.listedSites.size, 0, 'nothing kept to focus from');
  assert.equal(cockpit.toggleOrbitalFocus(SITES.alpha.id), false);
  scene.click(SITES.alpha.at);
  assert.equal(cockpit.orbital.focus ?? null, null);
});

test('an arrow during the ease back from a focus turns on the arrows’ clock', async (t) => {
  const scene = await inOrbit(t);
  const { cockpit } = scene;
  siteRow(scene, 'alpha').click();
  run(scene, LAND_FRAMES);
  scene.click(EMPTY_GROUND);
  scene.frame();
  assert.equal(cockpit.orbital.focusReleasing, true);
  const view = { ...cockpit.orbital.lookView };
  assert.ok(Math.abs(view.pitchDeg) > 1 || Math.abs(view.yawDeg) > 1, 'still turned');
  cockpit.onKeyDown({
    key: 'ArrowUp',
    target: document.body,
    preventDefault() {},
    stopImmediatePropagation() {},
  });
  assert.equal(cockpit.orbital.focusReleasing, false);
  // The arrow tilts on from where the view is, not from nadir.
  assert.ok(
    Math.abs(cockpit.orbital.lookTarget.yawDeg - view.yawDeg) < 1e-6,
    'across kept',
  );
  assert.ok(cockpit.orbital.lookTarget.pitchDeg > view.pitchDeg, 'tilted on up');
});

test('leaving orbit leaves no orbital rows to act on', async (t) => {
  const scene = await inOrbit(t);
  scene.click(SITES.alpha.at);
  run(scene, 5);
  scene.satellites.drop();
  scene.frame();
  assert.equal(scene.cockpit.active, false);
  assert.equal(scene.store.presence.context, false);
  scene.click(SITES.bravo.at);
  assert.equal(scene.cockpit.toggleOrbitalFocus(SITES.bravo.id), false);
  assert.equal(scene.cockpit.onOrbitalClick(SITES.bravo.at), false);
  assert.equal(scene.cockpit.rideOrbitalSatellite(49260), false);
  assert.equal(scene.cockpit.handleOrbitalSignalClick('satellites', '49260'), false);
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
  assert.equal(
    cockpit.orbital.lookTarget.pitchDeg,
    Math.floor(held.pitchDeg / 5 + 1e-9) * 5 + 5,
  );
});

test('reduced motion cuts onto the site, back, and between satellites', async (t) => {
  const scene = await inOrbit(t, { reducedMotion: true });
  await settle();
  scene.click(SITES.alpha.at);
  assert.ok(missDeg(scene.frame(), 'alpha') < 1e-5, 'on it at once');
  scene.click(EMPTY_GROUND);
  assert.ok(offNadir(scene.frame()) < 1e-6, 'back at once');
  satelliteRow(scene, 49260).click();
  const shot = scene.frame();
  assert.ok(Cesium.Cartesian3.distance(shot.destination, scene.satellites.position(49260)) < 1);
});

test('stopping the Cockpit hands both clicks back to Cesium', async (t) => {
  const scene = fixture(t);
  const click = Cesium.ScreenSpaceEventType.LEFT_CLICK;
  const double = Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK;
  assert.notEqual(scene.handler.getInputAction(click), scene.handler.stock);
  scene.cockpit.stop();
  assert.equal(scene.handler.getInputAction(click), scene.handler.stock);
  assert.equal(scene.handler.getInputAction(double), scene.handler.stockDouble);
});

test('the focused site keeps its row after nearer sites push it down', async (t) => {
  const scene = await inOrbit(t);
  siteRow(scene, 'alpha').click();
  run(scene, LAND_FRAMES);
  // Eight more sites appear right below the satellite, all nearer to nadir.
  for (let i = 0; i < 8; i += 1)
    scene.sites.records.push({
      id: `osm:military:way/9${i}`,
      osmKey: `way/9${i}`,
      name: `Near ${i}`,
      class: 'base',
      kind: 'installation',
      latitude: 30.4 + i * 0.01,
      longitude: -96.6,
      memberNames: [],
      sources: [],
    });
  await refreshRows(scene);
  const sitesShown = rows(scene).filter((row) => row.target?.layerId === 'military-installations');
  assert.equal(sitesShown.length, 2);
  assert.equal(sitesShown[0].target.id, SITES.alpha.id, 'the focused site is kept, first');
  siteRow(scene, 'alpha').click();
  assert.equal(scene.cockpit.orbital.focus, null, 'its row still ends the focus');
});

test('a site the layer drops in a reload keeps its row, and its row still focuses it', async (t) => {
  const scene = await inOrbit(t);
  await settle();
  const before = rows(scene).map((row) => row.key);
  const loaded = scene.sites.records;
  // The thinned view reloads without Camp Alpha for a moment.
  scene.sites.records = loaded.filter((r) => r.id !== SITES.alpha.id);
  await refreshRows(scene);
  assert.deepEqual(rows(scene).map((row) => row.key), before, 'the rows hold still');
  siteRow(scene, 'alpha').click();
  assert.equal(scene.cockpit.orbital.focus?.key, SITES.alpha.id, 'focused from its row');
  siteRow(scene, 'alpha').click();
  // Gone for good: after a while it leaves the rows.
  for (let i = 0; i < 12; i += 1) await refreshRows(scene);
  assert.ok(!rows(scene).some((row) => row.target?.id === SITES.alpha.id), 'forgotten later');
});

test('shown rows keep their places while they still qualify', async (t) => {
  const scene = await inOrbit(t);
  await settle();
  const sitesBefore = rows(scene)
    .filter((row) => row.target?.layerId === 'military-installations')
    .map((row) => row.target.id);
  // A site appears right below the satellite, nearer to nadir than both.
  scene.sites.records.push({
    id: 'osm:military:way/999',
    osmKey: 'way/999',
    name: 'Directly Below',
    class: 'base',
    kind: 'installation',
    latitude: 30.01,
    longitude: -97.01,
    memberNames: [],
    sources: [],
  });
  await refreshRows(scene);
  const sitesAfter = rows(scene)
    .filter((row) => row.target?.layerId === 'military-installations')
    .map((row) => row.target.id);
  assert.deepEqual(sitesAfter, sitesBefore, 'no row moves while its site is in reach');
  // Once a shown site leaves the list, the nearer one takes its slot.
  scene.sites.records = scene.sites.records.filter((r) => r.id !== SITES.bravo.id);
  for (let i = 0; i < 12; i += 1) await refreshRows(scene);
  assert.ok(
    rows(scene).some((row) => row.target?.id === 'osm:military:way/999'),
    'the nearer site fills the freed slot',
  );
});
