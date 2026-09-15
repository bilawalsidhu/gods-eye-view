import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { INCIDENT_OVERVIEW_HOLD_SEC, INCIDENT_OVERVIEW_PLACES } from './bhoteKoshiIncidentPlaces.js';
import { BHOTE_KOSHI_FLOOD_PATH } from './bhoteKoshiFloodPath.js';
import * as Cesium from 'cesium';
import { SceneDirector } from '../scenes/director.js';
import {
  anchoredCalloutPresentation,
  BHOTE_KOSHI_CITY_CONTEXT_PRESENTATION,
  BHOTE_KOSHI_FLOOD_PATH_PRESENTATION,
  BHOTE_KOSHI_INCIDENT_PLACES_PRESENTATION,
  BHOTE_KOSHI_LOCATOR_OVERLAY_SOURCE_ID,
  BHOTE_KOSHI_PATH_OVERVIEW_PRESENTATION,
  BHOTE_KOSHI_REGIONAL_PRESENTATION,
  BHOTE_KOSHI_TRIGGER_RECORD_PRESENTATION,
  closeRegionRing,
  createBhoteKoshiLocatorLayer,
  largestGeoJsonRing,
  NEPAL_CONTEXT_PRESENTATION,
  revealPolylinePositions,
} from './bhoteKoshiLocator.js';

function viewerFixture() {
  const added = [];
  const removed = [];
  return {
    creditDisplay: { addStaticCredit() {} },
    dataSources: {
      add(source) { added.push(source); },
      remove(source) { removed.push(source); },
    },
    _test: { added, removed },
  };
}

function nonRunningAnimation() {
  return {
    scheduleFrame() { return 1; },
    cancelFrame() {},
  };
}

function overlayHostFixture() {
  const publications = [];
  const clears = [];
  return {
    setEntries(sourceId, entries, options) {
      publications.push({ sourceId, entries, options });
    },
    clearSource(sourceId) {
      clears.push(sourceId);
    },
    _test: { publications, clears },
  };
}

test('Bhote Koshi locator closes valid region rings once', () => {
  assert.deepEqual(closeRegionRing([[80, 26], [88, 26], [88, 30]]), [
    [80, 26], [88, 26], [88, 30], [80, 26],
  ]);
  assert.deepEqual(closeRegionRing([[80, 26], [88, 26], [80, 26]]), [
    [80, 26], [88, 26], [80, 26],
  ]);
  assert.deepEqual(closeRegionRing([[80, 26], ['bad', 27]]), []);
});

test('Bhote Koshi locator selects the largest GeoJSON country exterior', () => {
  const main = [[80, 26], [88, 26], [88, 30], [80, 30], [80, 26]];
  const island = [[82, 25], [83, 25], [82, 25]];
  assert.equal(largestGeoJsonRing({ type: 'Polygon', coordinates: [main] }), main);
  assert.equal(largestGeoJsonRing({
    type: 'MultiPolygon',
    coordinates: [[island], [main]],
  }), main);
  assert.deepEqual(largestGeoJsonRing({ type: 'Point', coordinates: [84, 28] }), []);
});

test('Bhote Koshi locator reveals a border progressively', () => {
  const positions = [
    new Cesium.Cartesian3(0, 0, 0),
    new Cesium.Cartesian3(10, 0, 0),
    new Cesium.Cartesian3(20, 0, 0),
  ];
  assert.deepEqual(revealPolylinePositions(positions, 0), [positions[0], positions[0]]);
  assert.deepEqual(revealPolylinePositions(positions, 0.25), [
    positions[0],
    new Cesium.Cartesian3(5, 0, 0),
  ]);
  assert.equal(revealPolylinePositions(positions, 1), positions);
});

test('Bhote Koshi locator stages its anchored callout from dot to leader to text', () => {
  assert.deepEqual(anchoredCalloutPresentation(0), {
    alpha: 0,
    leaderProgress: 0,
    contentAlpha: 0,
    scale: 0.96,
  });
  assert.deepEqual(anchoredCalloutPresentation(1200), {
    alpha: 1,
    leaderProgress: 1,
    contentAlpha: 1,
    scale: 1,
  });
});

test('Bhote Koshi regional locator sequences Nepal, border, then the incident', async () => {
  const viewer = viewerFixture();
  const overlayHost = overlayHostFixture();
  const renders = [];
  let nowMs = 0;
  const layer = createBhoteKoshiLocatorLayer({
    boundaryResolver: async () => ({
      name: 'Nepal',
      ring: [[80, 26], [88, 26], [88, 30], [80, 30]],
    }),
    requestRender: (reason) => renders.push(reason),
    overlayHost,
    now: () => nowMs,
    ...nonRunningAnimation(),
  });

  assert.equal(await layer.init(viewer), true);
  assert.equal(await layer.enable(viewer, { origin: 'scene' }), true);
  assert.equal(viewer._test.added.length, 1);
  const source = viewer._test.added[0];
  const ids = source.entities.values.map((entity) => entity.id);
  for (const id of [
    'nepal-context-halo',
    'nepal-border-fill',
    'nepal-border-highlight',
    'bhote-koshi-incident-halo',
  ]) {
    assert.ok(ids.includes(id), `${id} belongs to the regional sequence`);
  }
  const incidentHalo = source.entities.getById('bhote-koshi-incident-halo');
  const border = source.entities.getById('nepal-border-highlight');
  const publication = overlayHost._test.publications.at(-1);
  assert.equal(publication.sourceId, BHOTE_KOSHI_LOCATOR_OVERLAY_SOURCE_ID);
  assert.equal(publication.entries.length, 2);
  const nepal = publication.entries.find(({ id }) => id === 'nepal-context-callout');
  const incident = publication.entries.find(({ id }) => id === 'bhote-koshi-incident-callout');
  assert.equal(nepal.variant, 'label');
  assert.equal(nepal.title, 'NEPAL');
  assert.equal(nepal.anchorDot, true);
  assert.equal(incident.variant, 'card');
  assert.equal(incident.paintLane, 'thumbnail');
  assert.equal(incident.title, 'BHOTE KOSHI FLOOD INCIDENT');
  assert.deepEqual(incident.details, ['NEPAL · 26 AUG 2026']);
  assert.equal(incident.anchorDot, true);
  assert.equal(incident.leaderStyle, 'elbow');
  assert.equal('image' in incident, false);
  assert.equal('requireImage' in incident, false);
  assert.equal(incident.sourceAlpha(), 0);
  assert.equal(incident.leaderProgress(), 0);
  assert.equal(incident.contentAlpha(), 0);
  assert.equal(incident.presentationScale(), 0.96);
  assert.equal(nepal.sourceAlpha(), 0);
  assert.ok(border.polyline.positions.getValue().length < 5);
  assert.equal(incidentHalo.show.getValue(), false);
  assert.equal(incidentHalo.point.pixelSize.getValue(), 16);
  nowMs = 3100;
  assert.equal(nepal.sourceAlpha(), 1);
  assert.equal(border.polyline.positions.getValue().length, 5);
  assert.equal(incidentHalo.show.getValue(), false);
  nowMs = 3300;
  assert.equal(incidentHalo.show.getValue(), true);
  assert.equal(incident.sourceAlpha(), 0);
  nowMs = 4500;
  assert.equal(incident.sourceAlpha(), 1);
  assert.equal(incident.leaderProgress(), 1);
  assert.equal(incident.contentAlpha(), 1);
  assert.equal(incident.presentationScale(), 1);
  assert.equal(layer.getStats().status, 'nominal');
  assert.deepEqual(layer.getParams(), { presentation: BHOTE_KOSHI_REGIONAL_PRESENTATION });
  assert.ok(renders.includes('bhote-koshi-locator-boundary'));

  assert.equal(await layer.disable(), true);
  assert.equal(viewer._test.removed.length, 1);
  assert.equal(overlayHost._test.clears.at(-1), BHOTE_KOSHI_LOCATOR_OVERLAY_SOURCE_ID);
  assert.equal(layer.getStats().status, 'idle');
});

test('Bhote Koshi locator switches between Nepal context and the regional incident treatment', async () => {
  const viewer = viewerFixture();
  const overlayHost = overlayHostFixture();
  const layer = createBhoteKoshiLocatorLayer({
    boundaryResolver: async () => ({
      name: 'Nepal',
      ring: [[80, 26], [88, 26], [88, 30], [80, 30]],
    }),
    requestRender() {},
    overlayHost,
    ...nonRunningAnimation(),
  });

  layer.setParams({ presentation: NEPAL_CONTEXT_PRESENTATION });
  await layer.enable(viewer);
  assert.deepEqual(viewer._test.added[0].entities.values.map((entity) => entity.id), [
    'nepal-context-halo',
  ]);
  const nepalLabel = overlayHost._test.publications.at(-1).entries[0];
  assert.equal(nepalLabel.variant, 'label');
  assert.equal(nepalLabel.placement, 'right');
  assert.equal(nepalLabel.anchorDot, true);
  assert.equal(layer.getStats().coverage, 'Nepal context');
  assert.deepEqual(layer.getRowControls().chips.map(({ id, active }) => ({ id, active })), [
    { id: 'nepal-context', active: true },
    { id: 'bhote-koshi-regional', active: false },
    { id: 'bhote-koshi-city-context', active: false },
    { id: 'bhote-koshi-incident-places', active: false },
    { id: 'bhote-koshi-flood-path', active: false },
    { id: 'bhote-koshi-path-overview', active: false },
    { id: 'bhote-koshi-trigger-record', active: false },
  ]);

  layer.setParams({ presentation: BHOTE_KOSHI_REGIONAL_PRESENTATION });
  assert.ok(viewer._test.added[0].entities.getById('nepal-border-highlight'));
  assert.equal(viewer._test.added[0].entities.getById('bhote-koshi-city-kathmandu'), undefined);
  assert.equal(
    overlayHost._test.publications.at(-1).entries
      .find(({ id }) => id === 'bhote-koshi-incident-callout').variant,
    'card',
  );

  layer.setParams({ presentation: NEPAL_CONTEXT_PRESENTATION });
  assert.deepEqual(viewer._test.added[0].entities.values.map((entity) => entity.id), [
    'nepal-context-halo',
  ]);
  await layer.destroy();
});

test('Incident Corridor reveals all fifteen overview pins and keeps layout active through the sequence', async () => {
  const viewer = viewerFixture();
  const overlayHost = overlayHostFixture();
  let nowMs = 0;
  let pulseFrame = null;
  const layer = createBhoteKoshiLocatorLayer({
    boundaryResolver: async () => null, requestRender() {},
    overlayHost,
    now: () => nowMs,
    scheduleFrame(callback) { pulseFrame = callback; return 1; },
    cancelFrame() {},
  });
  layer.setParams({ presentation: BHOTE_KOSHI_INCIDENT_PLACES_PRESENTATION });
  await layer.enable(viewer);
  const source = viewer._test.added[0];
  const event = JSON.parse(await readFile(new URL('../../public/events/bhote-koshi-2026/event.json', import.meta.url), 'utf8'));
  assert.equal(event.evidenceSpine.length, 16);
  assert.equal(event.evidenceSpine.at(-1).id, 'charaudi');
  assert.equal(source.entities.values.length, 15);
  const labels = overlayHost._test.publications.at(-1).entries;
  assert.equal(labels.length, 15);
  assert.equal(overlayHost._test.publications.at(-1).options.moving, true);
  for (const [index, point] of INCIDENT_OVERVIEW_PLACES.entries()) {
    const id = `bhote-koshi-place-${point.id}`;
    const pin = labels.find((entry) => entry.id === id);
    assert.ok(pin, point.id);
    assert.equal(pin.title, `${String(index + 1).padStart(2, '0')} · ${point.title}`);
    assert.equal(pin.variant, 'label');
    const location = Cesium.Cartographic.fromCartesian(pin.position);
    assert.ok(Math.abs(Cesium.Math.toDegrees(location.latitude) - point.lat) < 1e-6);
    assert.ok(Math.abs(Cesium.Math.toDegrees(location.longitude) - point.lon) < 1e-6);
    nowMs = 349 + index * 650;
    assert.equal(pin.sourceAlpha(), 0);
    nowMs += 1;
    assert.equal(pin.sourceAlpha(), 0);
    assert.equal(source.entities.values.filter(entity => entity.id.endsWith('-halo') && entity.show.getValue()).length, 1);
    nowMs += 520;
    assert.equal(pin.sourceAlpha(), 1);
  }
  assert.ok(nowMs < INCIDENT_OVERVIEW_HOLD_SEC * 1000);
  // A repeat halo cycle must not erase already revealed labels.
  nowMs = 350 + 15 * 650;
  assert.equal(source.entities.getById('bhote-koshi-place-immediate-collapse-viewpoint-halo').show.getValue(), true);
  assert.equal(labels.find(({ id }) => id === 'bhote-koshi-place-devighat-taadi-khola-bridge').sourceAlpha(), 1);
  assert.equal(labels.some(({ id }) => id === 'bhote-koshi-place-charaudi'), false);
  assert.equal(typeof pulseFrame, 'function');
  pulseFrame();
  assert.equal(overlayHost._test.publications.at(-1).options.moving, false);
  layer.setParams({ presentation: BHOTE_KOSHI_REGIONAL_PRESENTATION });
  assert.equal(source.entities.values.some(entity => entity.id.startsWith('bhote-koshi-place-')), false);
  await layer.destroy();
});

test('Bhote Koshi flood path draws a solid cyan sourced route after the place shot', async () => {
  const viewer = viewerFixture();
  const overlayHost = overlayHostFixture();
  let nowMs = 0;
  const layer = createBhoteKoshiLocatorLayer({
    boundaryResolver: async () => null,
    requestRender() {},
    overlayHost,
    now: () => nowMs,
    ...nonRunningAnimation(),
  });

  layer.setParams({ presentation: BHOTE_KOSHI_FLOOD_PATH_PRESENTATION });
  await layer.enable(viewer);
  const source = viewer._test.added[0];
  const path = source.entities.getById('bhote-koshi-flood-path');
  const labels = overlayHost._test.publications.at(-1).entries;
  const trigger = labels.find(({ id }) => id === 'bhote-koshi-place-immediate-collapse-viewpoint');
  const bidur = labels.find(({ id }) => id === 'bhote-koshi-place-bidur-trishuli-bridge');

  assert.equal(source.entities.values.length, 1);
  assert.equal(labels.length, 15);
  assert.equal(bidur.title, '14 · BIDUR BRIDGE');
  for (const place of INCIDENT_OVERVIEW_PLACES) {
    const pin = labels.find(({ id }) => id === `bhote-koshi-place-${place.id}`);
    assert.equal(pin.sourceAlpha(), 1, place.id);
  }
  assert.equal(path.polyline.clampToGround.getValue(), true);
  assert.ok(path.polyline.material instanceof Cesium.ColorMaterialProperty);
  assert.ok(path.polyline.material.color.getValue().equalsEpsilon(
    Cesium.Color.fromCssColorString('#20e7f2').withAlpha(0.96),
    Cesium.Math.EPSILON7,
  ));
  assert.equal(path.show.getValue(), false);
  assert.equal(trigger.sourceAlpha(), 1);
  assert.equal(bidur.sourceAlpha(), 1);

  nowMs = 250;
  assert.equal(path.show.getValue(), true);
  assert.equal(path.polyline.positions.getValue().length, 2);
  nowMs = 2250;
  const halfwayCount = path.polyline.positions.getValue().length;
  assert.ok(Math.abs(halfwayCount - BHOTE_KOSHI_FLOOD_PATH.length / 2) <= 2);
  nowMs = 4250;
  assert.equal(path.polyline.positions.getValue().length, BHOTE_KOSHI_FLOOD_PATH.length);
  assert.deepEqual(BHOTE_KOSHI_FLOOD_PATH[0], [85.48476, 28.33255]);
  // More observation pins must not extend or straighten the sourced route.
  assert.deepEqual(path.polyline.positions.getValue(), BHOTE_KOSHI_FLOOD_PATH.map(([lon, lat]) => (
    Cesium.Cartesian3.fromDegrees(lon, lat)
  )));
  assert.deepEqual(BHOTE_KOSHI_FLOOD_PATH.at(-1), [85.14943, 27.92177]);
  assert.equal(layer.getStats().coverage, 'Bhote Koshi · Flood path');
  assert.deepEqual(layer.getParams(), { presentation: BHOTE_KOSHI_FLOOD_PATH_PRESENTATION });
  await layer.destroy();
});

test('Bhote Koshi path-overview presentation keeps the route settled without Nepal border', async () => {
  const viewer = viewerFixture();
  const overlayHost = overlayHostFixture();
  let nowMs = 0;
  const layer = createBhoteKoshiLocatorLayer({
    boundaryResolver: async () => ({
      name: 'Nepal',
      ring: [[80, 26], [88, 26], [88, 30], [80, 30]],
    }),
    requestRender() {},
    overlayHost,
    now: () => nowMs,
    ...nonRunningAnimation(),
  });

  layer.setParams({ presentation: BHOTE_KOSHI_PATH_OVERVIEW_PRESENTATION });
  await layer.enable(viewer);
  const source = viewer._test.added[0];
  const path = source.entities.getById('bhote-koshi-flood-path');
  const labels = overlayHost._test.publications.at(-1).entries;

  assert.equal(source.entities.values.length, 1);
  assert.equal(labels.length, 15);
  for (const [index, place] of INCIDENT_OVERVIEW_PLACES.entries()) {
    const pin = labels.find(({ id }) => id === `bhote-koshi-place-${place.id}`);
    assert.equal(pin.title, `${String(index + 1).padStart(2, '0')} · ${place.title}`);
    assert.equal(pin.sourceAlpha(), 1);
  }
  assert.equal(path.show.getValue(), true);
  assert.equal(path.polyline.positions.getValue().length, BHOTE_KOSHI_FLOOD_PATH.length);
  assert.ok(Cesium.Cartesian3.equals(path.polyline.positions.getValue()[0],
    Cesium.Cartesian3.fromDegrees(85.48476, 28.33255)));
  assert.equal(source.entities.getById('nepal-border-fill'), undefined);
  assert.equal(source.entities.getById('nepal-border-highlight'), undefined);
  assert.equal(
    source.entities.getById('bhote-koshi-place-immediate-collapse-viewpoint-halo'),
    undefined,
  );
  assert.equal(layer.getStats().coverage, 'Bhote Koshi · Path overview');
  assert.deepEqual(layer.getParams(), { presentation: BHOTE_KOSHI_PATH_OVERVIEW_PRESENTATION });
  await layer.destroy();
});

test('Bhote Koshi trigger-record presentation reveals sourced incident details', async () => {
  const viewer = viewerFixture();
  const overlayHost = overlayHostFixture();
  let nowMs = 0;
  const layer = createBhoteKoshiLocatorLayer({
    boundaryResolver: async () => null,
    requestRender() {},
    overlayHost,
    now: () => nowMs,
    ...nonRunningAnimation(),
  });

  layer.setParams({
    presentation: BHOTE_KOSHI_TRIGGER_RECORD_PRESENTATION,
    preview: true,
  });
  await layer.enable(viewer);
  const source = viewer._test.added[0];
  const publication = overlayHost._test.publications.at(-1);
  const record = publication.entries[0];

  assert.deepEqual(source.entities.values.map(({ id }) => id), [
    'bhote-koshi-flood-path',
    'bhote-koshi-trigger-record-halo',
  ]);
  assert.equal(record.title, 'USGS INITIAL REPORT');
  assert.deepEqual(record.details, [
    '26 AUG 2026 · 08:37 NPT',
    '28.2710° N · 85.5150° E',
    'INITIAL M4.4 · RECLASSIFIED M5.2 LANDSLIDE',
    'USGS EVENT us7000tbwb · OPEN SOURCE',
  ]);
  assert.equal(record.interactive, true);
  assert.equal(typeof record.activate, 'function');
  assert.equal(record.sourceAlpha(), 0);
  nowMs = 1200;
  assert.equal(record.sourceAlpha(), 1);
  assert.equal(source.entities.getById('nepal-border-highlight'), undefined);
  assert.equal(layer.getStats().coverage, 'Bhote Koshi · Trigger record');
  assert.deepEqual(layer.getParams(), {
    presentation: BHOTE_KOSHI_TRIGGER_RECORD_PRESENTATION,
  });
  await layer.destroy();
});

test('Bhote Koshi trigger-record waits for the scene camera, zooms, then orbits', async () => {
  const viewer = viewerFixture();
  const overlayHost = overlayHostFixture();
  const moveStart = new Cesium.Event();
  const moveEnd = new Cesium.Event();
  const flights = [];
  let armedCallback = null;
  viewer.camera = {
    moveStart,
    moveEnd,
    flyTo(options) { flights.push(options); },
    cancelFlight() {},
  };
  const layer = createBhoteKoshiLocatorLayer({
    boundaryResolver: async () => null,
    requestRender() {},
    overlayHost,
    scheduleDelay(callback) {
      armedCallback = callback;
      return 1;
    },
    cancelDelay() {},
    ...nonRunningAnimation(),
  });

  layer.setParams({ presentation: BHOTE_KOSHI_TRIGGER_RECORD_PRESENTATION });
  await layer.enable(viewer);
  assert.equal(flights.length, 0);
  assert.equal(typeof armedCallback, 'function');
  moveStart.raiseEvent();
  assert.equal(flights.length, 0);
  moveEnd.raiseEvent();
  assert.equal(flights.length, 1);
  assert.equal(flights[0].duration, 4.6);
  const destination = Cesium.Cartographic.fromCartesian(flights[0].destination);
  assert.ok(Math.abs(Cesium.Math.toDegrees(destination.latitude) - 28.368) < 1e-6);
  assert.ok(Math.abs(Cesium.Math.toDegrees(destination.longitude) - 85.473) < 1e-6);
  assert.ok(Math.abs(destination.height - 10526) < 1e-4);
  flights[0].complete();
  assert.equal(flights.length, 2);
  assert.equal(flights[1].duration, 2.8);
  const orbit = Cesium.Cartographic.fromCartesian(flights[1].destination);
  assert.ok(Math.abs(Cesium.Math.toDegrees(orbit.latitude) - 28.3769) < 1e-6);
  assert.ok(Math.abs(Cesium.Math.toDegrees(orbit.longitude) - 85.4923) < 1e-6);
  assert.ok(Math.abs(orbit.height - 10526) < 1e-4);
  await layer.destroy();
});

for (const phase of ['timer', 'move-end', 'approach', 'orbit']) {
  test(`Scene Stop revokes locator ${phase} and stale callbacks cannot own a successor`, async () => {
    const viewer = viewerFixture();
    const timers = new Map();
    const callbacks = [];
    const flights = [];
    let nextTimer = 0;
    const moveStart = new Cesium.Event();
    const moveEnd = new Cesium.Event();
    viewer.camera = {
      moveStart, moveEnd,
      flyTo(options) { flights.push(options); },
      cancelFlight() {},
    };
    const layer = createBhoteKoshiLocatorLayer({
      boundaryResolver: async () => null,
      overlayHost: overlayHostFixture(),
      requestRender() {},
      scheduleDelay(callback) {
        callbacks.push(callback);
        timers.set(++nextTimer, callback);
        return nextTimer;
      },
      cancelDelay(id) { timers.delete(id); },
      ...nonRunningAnimation(),
    });
    const director = {
      dataManager: { layers: new Map([[layer.id, { module: layer }]]) },
      viewer,
      _sceneSeekGeneration: 0,
      _loadGeneration: 0,
      _cancelActiveSceneTravel: SceneDirector.prototype._cancelActiveSceneTravel,
    };
    try {
      layer.setParams({ presentation: BHOTE_KOSHI_TRIGGER_RECORD_PRESENTATION });
      await layer.enable(viewer);
      if (phase === 'move-end') moveStart.raiseEvent();
      if (phase === 'approach' || phase === 'orbit') callbacks[0]();
      if (phase === 'orbit') flights[0].complete();
      const oldFlights = [...flights];
      SceneDirector.prototype.stopScene.call(director);
      assert.equal(timers.size, 0, 'Stop cancels the actual delayed work');
      assert.equal(moveStart.numberOfListeners, 0);
      assert.equal(moveEnd.numberOfListeners, 0);
      callbacks[0]();
      moveEnd.raiseEvent();
      for (const flight of oldFlights) flight.complete();
      assert.equal(flights.length, oldFlights.length, 'no post-Stop approach or orbit');
      assert.equal(layer.getStats().count, 1, 'Stop preserves the visible locator');

      layer.setParams({ presentation: BHOTE_KOSHI_TRIGGER_RECORD_PRESENTATION });
      callbacks.at(-1)();
      const successor = flights.at(-1);
      const count = flights.length;
      callbacks[0]();
      for (const flight of oldFlights) { flight.cancel(); flight.complete(); }
      assert.equal(flights.length, count, 'old callbacks cannot add a flight');
      successor.complete();
      assert.equal(flights.length, count + 1, 'successor retains its own orbit');
    } finally { await layer.destroy(); }
  });
}

test('Bhote Koshi locator keeps the regional context settled while nearby cities stagger in', async () => {
  const viewer = viewerFixture();
  const overlayHost = overlayHostFixture();
  let nowMs = 0;
  const layer = createBhoteKoshiLocatorLayer({
    boundaryResolver: async () => ({
      name: 'Nepal',
      ring: [[80, 26], [88, 26], [88, 30], [80, 30]],
    }),
    requestRender() {},
    overlayHost,
    now: () => nowMs,
    ...nonRunningAnimation(),
  });

  layer.setParams({ presentation: BHOTE_KOSHI_CITY_CONTEXT_PRESENTATION });
  await layer.enable(viewer);
  const source = viewer._test.added[0];
  const borderFill = source.entities.getById('nepal-border-fill');
  const entries = overlayHost._test.publications.at(-1).entries;
  const incident = entries.find(({ id }) => id === 'bhote-koshi-incident-callout');
  const kathmandu = entries.find(({ id }) => id === 'bhote-koshi-city-kathmandu');
  const bhaktapur = entries.find(({ id }) => id === 'bhote-koshi-city-bhaktapur');
  const dhulikhel = entries.find(({ id }) => id === 'bhote-koshi-city-dhulikhel');

  assert.equal(borderFill.show.getValue(), true);
  assert.equal(incident.contentAlpha(), 1);
  assert.equal(kathmandu.title, 'KATHMANDU');
  assert.equal(bhaktapur.title, 'BHAKTAPUR');
  assert.equal(dhulikhel.title, 'DHULIKHEL');
  assert.ok([kathmandu, bhaktapur, dhulikhel].every(({ variant, anchorDot }) => (
    variant === 'label' && anchorDot === true
  )));
  assert.equal(kathmandu.sourceAlpha(), 0);
  assert.equal(bhaktapur.sourceAlpha(), 0);
  assert.equal(dhulikhel.sourceAlpha(), 0);

  nowMs = 350;
  assert.equal(kathmandu.sourceAlpha(), 0);
  assert.equal(bhaktapur.sourceAlpha(), 0);
  nowMs = 850;
  assert.equal(kathmandu.sourceAlpha(), 1);
  assert.ok(bhaktapur.sourceAlpha() > 0);
  assert.ok(dhulikhel.sourceAlpha() > 0);
  nowMs = 1300;
  assert.equal(dhulikhel.sourceAlpha(), 1);
  assert.equal(layer.getStats().coverage, 'Bhote Koshi · Nearby cities');
  assert.deepEqual(layer.getParams(), { presentation: BHOTE_KOSHI_CITY_CONTEXT_PRESENTATION });
  await layer.destroy();
});

test('Bhote Koshi locator degrades to labels when the regional boundary is unavailable', async () => {
  const viewer = viewerFixture();
  const overlayHost = overlayHostFixture();
  const originalWarn = console.warn;
  console.warn = () => {};
  const layer = createBhoteKoshiLocatorLayer({
    boundaryResolver: async () => null,
    requestRender() {},
    overlayHost,
    ...nonRunningAnimation(),
  });
  try {
    await layer.enable(viewer);
    const ids = viewer._test.added[0].entities.values.map((entity) => entity.id);
    assert.ok(ids.includes('nepal-context-halo'));
    assert.ok(ids.includes('bhote-koshi-incident-halo'));
    assert.equal(ids.includes('bhote-koshi-city-kathmandu'), false);
    assert.equal(ids.includes('nepal-border-highlight'), false);
    assert.deepEqual(overlayHost._test.publications.at(-1).entries.map(({ id }) => id), [
      'nepal-context-callout',
      'bhote-koshi-incident-callout',
    ]);
    assert.equal(layer.getStats().status, 'degraded');
  } finally {
    console.warn = originalWarn;
    await layer.destroy();
  }
});

test('Bhote Koshi regional locator waits for its boundary before starting the full sequence', async () => {
  const viewer = viewerFixture();
  const overlayHost = overlayHostFixture();
  let releaseBoundary;
  const boundary = new Promise((resolve) => { releaseBoundary = resolve; });
  const layer = createBhoteKoshiLocatorLayer({
    boundaryResolver: async () => boundary,
    requestRender() {},
    overlayHost,
    ...nonRunningAnimation(),
  });

  const enabling = layer.enable(viewer);
  assert.ok(viewer._test.added[0].entities.getById('nepal-context-halo'));
  assert.equal(viewer._test.added[0].entities.getById('nepal-border-highlight'), undefined);
  assert.equal(viewer._test.added[0].entities.getById('bhote-koshi-incident-halo'), undefined);
  assert.equal(overlayHost._test.publications.length, 1);
  assert.deepEqual(overlayHost._test.publications[0].entries.map(({ id }) => id), [
    'nepal-context-callout',
  ]);

  releaseBoundary({ ring: [[80, 26], [88, 26], [88, 30], [80, 30]] });
  await enabling;
  assert.ok(viewer._test.added[0].entities.getById('bhote-koshi-incident-halo'));
  assert.ok(viewer._test.added[0].entities.getById('nepal-border-highlight'));
  assert.equal(viewer._test.added[0].entities.getById('bhote-koshi-city-kathmandu'), undefined);
  assert.equal(overlayHost._test.publications.length, 2);
  assert.deepEqual(overlayHost._test.publications.at(-1).entries.map(({ id }) => id), [
    'nepal-context-callout',
    'bhote-koshi-incident-callout',
  ]);
  await layer.destroy();
});

test('Bhote Koshi locator cancels a stale boundary resolution and removes its surface', async () => {
  const viewer = viewerFixture();
  const controller = new AbortController();
  let releaseBoundary;
  const boundary = new Promise((resolve) => { releaseBoundary = resolve; });
  const layer = createBhoteKoshiLocatorLayer({
    boundaryResolver: async () => boundary,
    requestRender() {},
    ...nonRunningAnimation(),
  });
  const enabling = layer.enable(viewer, { signal: controller.signal });
  controller.abort();
  releaseBoundary({ ring: [[80, 26], [88, 26], [88, 30]] });
  await assert.rejects(enabling, (error) => error?.name === 'AbortError');
  assert.equal(viewer._test.removed.length, 1);
});
