import { bindFakeCesiumCamera } from '../testSupport/fakeCameraPort.mjs';
import { fakeDrawPort } from '../testSupport/fakeDrawPort.mjs';
import { bindRenderer } from '../render/rendererOf.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  INCIDENT_OVERVIEW_HOLD_SEC,
  INCIDENT_OVERVIEW_PLACES,
} from './bhoteKoshiIncidentPlaces.js';
import { BHOTE_KOSHI_FLOOD_PATH } from './bhoteKoshiFloodPath.js';
import * as Cesium from 'cesium';
import { setLocale } from '../i18n/index.js';
import { describeEntity } from './entityContext.js';
import {
  registerPickOwner,
  setClickCardHitTest,
  unregisterPickOwner,
} from './pickRegistry.js';
import { SceneDirector } from '../scenes/director.js';
import { createPlaybackClock } from '../director/clock.js';
import { createDefaultScenePacks } from '../scenes/packs/defaults.js';
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
  revealLengthFraction,
} from './bhoteKoshiLocator.js';

function checkLocatorCardHeight(module, record, position) {
  const id = 'bhote-koshi-locator';
  const manager = { layers: new Map([[id, { id, module }]]) };
  const card = describeEntity(manager, { layerId: id, id: record.id });
  assert.equal(record.elevationM, undefined);
  assert.equal(card.altitudeM, null);
  assert.ok(
    !card.facts.some(({ field }) => ['elevationM', 'pinHeightM'].includes(field)),
  );
  const drawn = Cesium.Cartographic.fromCartesian(position);
  assert.ok(Math.abs(card.pinHeightM - drawn.height) < 1e-3);
}

/**
 * A viewer with a fake draw port bound; with `camera`, the Cesium camera
 * port over that fake camera too. `_test` reads what is drawn: every live
 * item by id (`drawn`), and `sets` of the layer.
 */
function viewerFixture({ camera } = {}) {
  const draw = fakeDrawPort();
  const viewer = {
    creditDisplay: { addStaticCredit() {}, removeStaticCredit() {} },
  };
  if (camera) {
    viewer.camera = camera;
    bindFakeCesiumCamera(viewer, { draw });
  } else bindRenderer(viewer, { draw });
  const live = () =>
    [...draw.sets.values()].filter(
      (set) => !set.disposed && set.spec.id.startsWith('bhote-koshi-locator:'),
    );
  viewer._test = {
    draw,
    live,
    /** Every live item, by id. */
    drawn() {
      const items = new Map();
      for (const set of live())
        for (const [id, item] of set.items) items.set(id, item);
      return items;
    },
    ids: () => [...viewer._test.drawn().keys()],
    item: (id) => viewer._test.drawn().get(id),
  };
  return viewer;
}

/** Frames that run only when a test ticks them. */
function nonRunningAnimation() {
  let queued = [];
  return {
    scheduleFrame(callback) {
      queued.push(callback);
      return queued.length;
    },
    cancelFrame() {},
    /** Run the frames asked for so far (each asks for its next). */
    tick() {
      const run = queued;
      queued = [];
      for (const callback of run) callback();
    },
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
  assert.deepEqual(
    closeRegionRing([
      [80, 26],
      [88, 26],
      [88, 30],
    ]),
    [
      [80, 26],
      [88, 26],
      [88, 30],
      [80, 26],
    ],
  );
  assert.deepEqual(
    closeRegionRing([
      [80, 26],
      [88, 26],
      [80, 26],
    ]),
    [
      [80, 26],
      [88, 26],
      [80, 26],
    ],
  );
  assert.deepEqual(
    closeRegionRing([
      [80, 26],
      ['bad', 27],
    ]),
    [],
  );
});

test('Bhote Koshi locator selects the largest GeoJSON country exterior', () => {
  const main = [
    [80, 26],
    [88, 26],
    [88, 30],
    [80, 30],
    [80, 26],
  ];
  const island = [
    [82, 25],
    [83, 25],
    [82, 25],
  ];
  assert.equal(
    largestGeoJsonRing({ type: 'Polygon', coordinates: [main] }),
    main,
  );
  assert.equal(
    largestGeoJsonRing({
      type: 'MultiPolygon',
      coordinates: [[island], [main]],
    }),
    main,
  );
  assert.deepEqual(
    largestGeoJsonRing({ type: 'Point', coordinates: [84, 28] }),
    [],
  );
});

test('Bhote Koshi locator reveals a border progressively, vertex by vertex', () => {
  const positions = [
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 40, y: 0, z: 0 },
  ];
  assert.equal(revealLengthFraction(positions, 0), 0);
  // A quarter of the vertices: halfway along the first, shorter segment.
  assert.equal(revealLengthFraction(positions, 0.25), 5 / 40);
  assert.equal(revealLengthFraction(positions, 0.75), 25 / 40);
  assert.equal(revealLengthFraction(positions, 1), 1);
  assert.equal(revealLengthFraction(positions.slice(0, 1), 0.5), 0);
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
  const frames = nonRunningAnimation();
  const layer = createBhoteKoshiLocatorLayer({
    boundaryResolver: async () => ({
      name: 'Nepal',
      ring: [
        [80, 26],
        [88, 26],
        [88, 30],
        [80, 30],
      ],
    }),
    requestRender: (reason) => renders.push(reason),
    overlayHost,
    now: () => nowMs,
    ...frames,
  });

  assert.equal(await layer.init(viewer), true);
  assert.equal(await layer.enable(viewer, { origin: 'scene' }), true);
  const sets = viewer._test.live();
  assert.deepEqual(
    sets.map(({ kind }) => kind),
    ['shapes', 'lines', 'points'],
    'the fill under the lines under the halos',
  );
  assert.ok(sets.every(({ spec }) => spec.pickable === false));
  // The fill is drawn once it is due, below.
  const ids = viewer._test.ids();
  for (const id of [
    'nepal-context-halo',
    'nepal-border-highlight',
    'bhote-koshi-incident-halo',
  ]) {
    assert.ok(ids.includes(id), `${id} belongs to the regional sequence`);
  }
  const incidentHalo = () => viewer._test.item('bhote-koshi-incident-halo');
  const border = () => viewer._test.item('nepal-border-highlight');
  const publication = overlayHost._test.publications.at(-1);
  assert.equal(publication.sourceId, BHOTE_KOSHI_LOCATOR_OVERLAY_SOURCE_ID);
  assert.equal(publication.entries.length, 2);
  const nepal = publication.entries.find(
    ({ id }) => id === 'nepal-context-callout',
  );
  const incident = publication.entries.find(
    ({ id }) => id === 'bhote-koshi-incident-callout',
  );
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
  assert.equal(border().revealFraction, 0);
  assert.equal(border().mode, 'draped');
  assert.equal(border().positions.length, 5);
  assert.equal(viewer._test.item('nepal-border-fill'), undefined);
  assert.equal(incidentHalo().show, false);
  assert.equal(incidentHalo().pixelSize, 16);
  nowMs = 800;
  frames.tick();
  const fill = viewer._test.item('nepal-border-fill');
  assert.equal(fill.height, 'clampGround', 'the fill, due, drapes');
  assert.equal(fill.geometry.rings[0].length, 4);
  assert.ok(border().revealFraction > 0 && border().revealFraction < 0.1);
  nowMs = 3100;
  frames.tick();
  assert.equal(nepal.sourceAlpha(), 1);
  assert.equal(border().revealFraction, 1);
  assert.equal(incidentHalo().show, false);
  const lines = sets.find(({ kind }) => kind === 'lines');
  const lineWrites = lines.writes;
  nowMs = 3300;
  frames.tick();
  frames.tick();
  assert.equal(lines.writes, lineWrites, 'settled lines are not drawn again');
  assert.equal(incidentHalo().show, true);
  assert.equal(incidentHalo().disableDepthTest, Number.POSITIVE_INFINITY);
  assert.equal(incident.sourceAlpha(), 0);
  nowMs = 4500;
  assert.equal(incident.sourceAlpha(), 1);
  assert.equal(incident.leaderProgress(), 1);
  assert.equal(incident.contentAlpha(), 1);
  assert.equal(incident.presentationScale(), 1);
  assert.equal(layer.getStats().status, 'nominal');
  assert.deepEqual(layer.getParams(), {
    presentation: BHOTE_KOSHI_REGIONAL_PRESENTATION,
  });
  assert.ok(renders.includes('bhote-koshi-locator-boundary'));

  assert.equal(await layer.disable(), true);
  assert.equal(viewer._test.live().length, 0, 'its sets let go');
  assert.equal(
    overlayHost._test.clears.at(-1),
    BHOTE_KOSHI_LOCATOR_OVERLAY_SOURCE_ID,
  );
  assert.equal(layer.getStats().status, 'idle');
});

test('Bhote Koshi locator switches between Nepal context and the regional incident treatment', async () => {
  const viewer = viewerFixture();
  const overlayHost = overlayHostFixture();
  const layer = createBhoteKoshiLocatorLayer({
    boundaryResolver: async () => ({
      name: 'Nepal',
      ring: [
        [80, 26],
        [88, 26],
        [88, 30],
        [80, 30],
      ],
    }),
    requestRender() {},
    overlayHost,
    ...nonRunningAnimation(),
  });

  layer.setParams({ presentation: NEPAL_CONTEXT_PRESENTATION });
  await layer.enable(viewer);
  assert.deepEqual(viewer._test.ids(), ['nepal-context-halo']);
  const nepalLabel = overlayHost._test.publications.at(-1).entries[0];
  assert.equal(nepalLabel.variant, 'label');
  assert.equal(nepalLabel.placement, 'right');
  assert.equal(nepalLabel.anchorDot, true);
  assert.equal(layer.getStats().coverage, 'Nepal context');
  assert.deepEqual(
    layer.getRowControls().chips.map(({ id, active }) => ({ id, active })),
    [
      { id: 'nepal-context', active: true },
      { id: 'bhote-koshi-regional', active: false },
      { id: 'bhote-koshi-city-context', active: false },
      { id: 'bhote-koshi-incident-places', active: false },
      { id: 'bhote-koshi-flood-path', active: false },
      { id: 'bhote-koshi-path-overview', active: false },
      { id: 'bhote-koshi-trigger-record', active: false },
    ],
  );

  layer.setParams({ presentation: BHOTE_KOSHI_REGIONAL_PRESENTATION });
  assert.ok(viewer._test.item('nepal-border-highlight'));
  assert.equal(viewer._test.item('bhote-koshi-city-kathmandu'), undefined);
  assert.equal(
    overlayHost._test.publications
      .at(-1)
      .entries.find(({ id }) => id === 'bhote-koshi-incident-callout').variant,
    'card',
  );

  layer.setParams({ presentation: NEPAL_CONTEXT_PRESENTATION });
  assert.deepEqual(viewer._test.ids(), ['nepal-context-halo']);
  await layer.destroy();
});

test('Incident Corridor reveals all fifteen overview pins and keeps layout active through the sequence', async () => {
  const viewer = viewerFixture();
  const overlayHost = overlayHostFixture();
  let nowMs = 0;
  let pulseFrame = null;
  const layer = createBhoteKoshiLocatorLayer({
    boundaryResolver: async () => null,
    requestRender() {},
    overlayHost,
    now: () => nowMs,
    scheduleFrame(callback) {
      pulseFrame = callback;
      return 1;
    },
    cancelFrame() {},
  });
  layer.setParams({ presentation: BHOTE_KOSHI_INCIDENT_PLACES_PRESENTATION });
  await layer.enable(viewer);
  const tick = () => {
    const frame = pulseFrame;
    frame?.();
  };
  const event = JSON.parse(
    await readFile(
      new URL(
        '../../public/events/bhote-koshi-2026/event.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  assert.equal(event.evidenceSpine.length, 16);
  assert.equal(event.evidenceSpine.at(-1).id, 'charaudi');
  assert.equal(viewer._test.ids().length, 15);
  const labels = overlayHost._test.publications.at(-1).entries;
  assert.equal(labels.length, 15);
  assert.equal(overlayHost._test.publications.at(-1).options.moving, true);
  for (const [index, point] of INCIDENT_OVERVIEW_PLACES.entries()) {
    const id = `bhote-koshi-place-${point.id}`;
    const pin = labels.find((entry) => entry.id === id);
    assert.ok(pin, point.id);
    assert.equal(
      pin.title,
      `${String(index + 1).padStart(2, '0')} · ${point.title}`,
    );
    assert.equal(pin.variant, 'label');
    const location = Cesium.Cartographic.fromCartesian(pin.position);
    assert.ok(
      Math.abs(Cesium.Math.toDegrees(location.latitude) - point.lat) < 1e-6,
    );
    assert.ok(
      Math.abs(Cesium.Math.toDegrees(location.longitude) - point.lon) < 1e-6,
    );
    nowMs = 349 + index * 650;
    assert.equal(pin.sourceAlpha(), 0);
    nowMs += 1;
    tick();
    assert.equal(pin.sourceAlpha(), 0);
    assert.equal(
      [...viewer._test.drawn().values()].filter(
        (item) => item.id.endsWith('-halo') && item.show,
      ).length,
      1,
    );
    nowMs += 520;
    assert.equal(pin.sourceAlpha(), 1);
  }
  assert.ok(nowMs < INCIDENT_OVERVIEW_HOLD_SEC * 1000);
  // A repeat halo cycle must not erase already revealed labels.
  nowMs = 350 + 15 * 650;
  tick();
  assert.equal(
    viewer._test.item('bhote-koshi-place-immediate-collapse-viewpoint-halo')
      .show,
    true,
  );
  assert.equal(
    labels
      .find(({ id }) => id === 'bhote-koshi-place-devighat-taadi-khola-bridge')
      .sourceAlpha(),
    1,
  );
  assert.equal(
    labels.some(({ id }) => id === 'bhote-koshi-place-charaudi'),
    false,
  );
  assert.equal(typeof pulseFrame, 'function');
  pulseFrame();
  assert.equal(overlayHost._test.publications.at(-1).options.moving, false);
  layer.setParams({ presentation: BHOTE_KOSHI_REGIONAL_PRESENTATION });
  assert.equal(
    viewer._test.ids().some((id) => id.startsWith('bhote-koshi-place-')),
    false,
  );
  await layer.destroy();
});

test('Bhote Koshi overview pins translate their descriptive titles and keep place names', async (t) => {
  t.after(() => setLocale('en'));
  setLocale('ru');
  const viewer = viewerFixture();
  const overlayHost = overlayHostFixture();
  const layer = createBhoteKoshiLocatorLayer({
    boundaryResolver: async () => null,
    requestRender() {},
    overlayHost,
    now: () => 0,
    ...nonRunningAnimation(),
  });

  layer.setParams({ presentation: BHOTE_KOSHI_FLOOD_PATH_PRESENTATION });
  await layer.enable(viewer);
  const titles = new Map(
    overlayHost._test.publications
      .at(-1)
      .entries.map(({ id, title }) => [id, title]),
  );
  assert.equal(
    titles.get('bhote-koshi-place-immediate-collapse-viewpoint'),
    '01 · ВИД НА ОБРУШЕНИЕ',
  );
  assert.equal(
    titles.get('bhote-koshi-place-gyirong-border-gate'),
    '04 · ПОГРАНПЕРЕХОД',
  );
  assert.equal(
    titles.get('bhote-koshi-place-dandagaun-viewpoint'),
    '11 · СМОТРОВАЯ ПЛОЩАДКА DANDAGAUN',
  );
  assert.equal(
    titles.get('bhote-koshi-place-bidur-trishuli-bridge'),
    '14 · МОСТ BIDUR',
  );
  assert.equal(titles.get('bhote-koshi-place-timure-cluster'), '05 · TIMURE');
  await layer.destroy();
});

test('Bhote Koshi flood path draws a solid cyan sourced route after the place shot', async () => {
  const viewer = viewerFixture();
  const overlayHost = overlayHostFixture();
  let nowMs = 0;
  const frames = nonRunningAnimation();
  const layer = createBhoteKoshiLocatorLayer({
    boundaryResolver: async () => null,
    requestRender() {},
    overlayHost,
    now: () => nowMs,
    ...frames,
  });

  layer.setParams({ presentation: BHOTE_KOSHI_FLOOD_PATH_PRESENTATION });
  await layer.enable(viewer);
  const path = () => viewer._test.item('bhote-koshi-flood-path');
  const labels = overlayHost._test.publications.at(-1).entries;
  const trigger = labels.find(
    ({ id }) => id === 'bhote-koshi-place-immediate-collapse-viewpoint',
  );
  const bidur = labels.find(
    ({ id }) => id === 'bhote-koshi-place-bidur-trishuli-bridge',
  );

  assert.equal(viewer._test.ids().length, 1);
  assert.equal(labels.length, 15);
  assert.equal(bidur.title, '14 · BIDUR BRIDGE');
  for (const place of INCIDENT_OVERVIEW_PLACES) {
    const pin = labels.find(({ id }) => id === `bhote-koshi-place-${place.id}`);
    assert.equal(pin.sourceAlpha(), 1, place.id);
  }
  assert.equal(path().mode, 'draped');
  assert.equal(path().clampTo, 'both');
  assert.equal(path().widthPx, 3.5);
  assert.equal(path().style.kind, 'solid');
  const color = Cesium.Color.fromCssColorString('#20e7f2').withAlpha(0.96);
  assert.ok(
    path().style.color.every(
      (value, i) =>
        Math.abs(value - Cesium.Color.pack(color, [])[i]) <
        Cesium.Math.EPSILON7,
    ),
  );
  assert.equal(path().show, false);
  assert.equal(trigger.sourceAlpha(), 1);
  assert.equal(bidur.sourceAlpha(), 1);

  nowMs = 250;
  frames.tick();
  assert.equal(path().show, true);
  assert.equal(path().revealFraction, 0);
  nowMs = 2250;
  frames.tick();
  // Halfway through its vertices.
  const positions = path().positions;
  assert.equal(path().revealFraction, revealLengthFraction(positions, 0.5));
  assert.ok(path().revealFraction > 0.2 && path().revealFraction < 0.8);
  nowMs = 4250;
  frames.tick();
  assert.equal(path().revealFraction, 1);
  assert.deepEqual(BHOTE_KOSHI_FLOOD_PATH[0], [85.48476, 28.33255]);
  // More observation pins must not extend or straighten the sourced route.
  assert.equal(positions.length, BHOTE_KOSHI_FLOOD_PATH.length);
  positions.forEach((position, i) => {
    const [lon, lat] = BHOTE_KOSHI_FLOOD_PATH[i];
    assert.ok(
      Cesium.Cartesian3.equalsEpsilon(
        position,
        Cesium.Cartesian3.fromDegrees(lon, lat),
        0,
        1e-6,
      ),
    );
  });
  assert.deepEqual(BHOTE_KOSHI_FLOOD_PATH.at(-1), [85.14943, 27.92177]);
  assert.equal(layer.getStats().coverage, 'Bhote Koshi · Flood path');
  assert.deepEqual(layer.getParams(), {
    presentation: BHOTE_KOSHI_FLOOD_PATH_PRESENTATION,
  });
  await layer.destroy();
});

test('Bhote Koshi path-overview presentation keeps the route settled without Nepal border', async () => {
  const viewer = viewerFixture();
  const overlayHost = overlayHostFixture();
  let nowMs = 0;
  const layer = createBhoteKoshiLocatorLayer({
    boundaryResolver: async () => ({
      name: 'Nepal',
      ring: [
        [80, 26],
        [88, 26],
        [88, 30],
        [80, 30],
      ],
    }),
    requestRender() {},
    overlayHost,
    now: () => nowMs,
    ...nonRunningAnimation(),
  });

  layer.setParams({ presentation: BHOTE_KOSHI_PATH_OVERVIEW_PRESENTATION });
  await layer.enable(viewer);
  const path = viewer._test.item('bhote-koshi-flood-path');
  const labels = overlayHost._test.publications.at(-1).entries;

  assert.equal(viewer._test.ids().length, 1);
  assert.equal(labels.length, 15);
  for (const [index, place] of INCIDENT_OVERVIEW_PLACES.entries()) {
    const pin = labels.find(({ id }) => id === `bhote-koshi-place-${place.id}`);
    assert.equal(
      pin.title,
      `${String(index + 1).padStart(2, '0')} · ${place.title}`,
    );
    assert.equal(pin.sourceAlpha(), 1);
  }
  assert.equal(path.show, true);
  assert.equal(path.revealFraction, 1);
  assert.equal(path.positions.length, BHOTE_KOSHI_FLOOD_PATH.length);
  assert.ok(
    Cesium.Cartesian3.equalsEpsilon(
      path.positions[0],
      Cesium.Cartesian3.fromDegrees(85.48476, 28.33255),
      0,
      1e-6,
    ),
  );
  assert.equal(viewer._test.item('nepal-border-fill'), undefined);
  assert.equal(viewer._test.item('nepal-border-highlight'), undefined);
  assert.equal(
    viewer._test.item('bhote-koshi-place-immediate-collapse-viewpoint-halo'),
    undefined,
  );
  assert.equal(layer.getStats().coverage, 'Bhote Koshi · Path overview');
  assert.deepEqual(layer.getParams(), {
    presentation: BHOTE_KOSHI_PATH_OVERVIEW_PRESENTATION,
  });
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
  const publication = overlayHost._test.publications.at(-1);
  const record = publication.entries[0];

  assert.deepEqual(viewer._test.ids(), [
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
  assert.equal(viewer._test.item('nepal-border-highlight'), undefined);
  assert.equal(layer.getStats().coverage, 'Bhote Koshi · Trigger record');
  const [initialReport, ...rest] = layer.getAnalystRecords();
  assert.deepEqual(rest, []);
  assert.equal(initialReport.id, 'us7000tbwb');
  assert.equal(initialReport.name, record.title);
  checkLocatorCardHeight(layer, initialReport, record.position);
  assert.deepEqual([initialReport.lat, initialReport.lon], [28.271, 85.515]);
  assert.equal(initialReport.source, 'USGS');
  assert.match(initialReport.website, /^https:\/\/earthquake\.usgs\.gov\/.*\/us7000tbwb\//);
  assert.deepEqual(layer.getAnalystRecords(0), []);
  assert.deepEqual(layer.getParams(), {
    presentation: BHOTE_KOSHI_TRIGGER_RECORD_PRESENTATION,
  });
  await layer.destroy();
});

test('Bhote Koshi trigger-record waits for the scene camera, zooms, then orbits', async () => {
  const overlayHost = overlayHostFixture();
  const moveStart = new Cesium.Event();
  const moveEnd = new Cesium.Event();
  const flights = [];
  let armedCallback = null;
  const viewer = viewerFixture({
    camera: {
      moveStart,
      moveEnd,
      flyTo(options) {
        flights.push(options);
      },
      cancelFlight() {},
    },
  });
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
  assert.ok(
    Math.abs(Cesium.Math.toDegrees(destination.latitude) - 28.368) < 1e-6,
  );
  assert.ok(
    Math.abs(Cesium.Math.toDegrees(destination.longitude) - 85.473) < 1e-6,
  );
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
    const timers = new Map();
    const callbacks = [];
    const flights = [];
    let nextTimer = 0;
    const moveStart = new Cesium.Event();
    const moveEnd = new Cesium.Event();
    const viewer = viewerFixture({
      camera: {
        moveStart,
        moveEnd,
        flyTo(options) {
          flights.push(options);
        },
        cancelFlight() {},
      },
    });
    // The renderer's camera port relays these; the layer's own come on top.
    const portListeners = [moveStart, moveEnd].map((e) => e.numberOfListeners);
    const layer = createBhoteKoshiLocatorLayer({
      boundaryResolver: async () => null,
      overlayHost: overlayHostFixture(),
      requestRender() {},
      scheduleDelay(callback) {
        callbacks.push(callback);
        timers.set(++nextTimer, callback);
        return nextTimer;
      },
      cancelDelay(id) {
        timers.delete(id);
      },
      ...nonRunningAnimation(),
    });
    const director = {
      _clock: createPlaybackClock({
        isRunning: () => false,
        timingForShot: () => null,
        onProgress() {},
      }),
      _scenePacks: createDefaultScenePacks(),
      dataManager: { layers: new Map([[layer.id, { module: layer }]]) },
      viewer,
      _sceneSeekGeneration: 0,
      _loadGeneration: 0,
      _bumpSceneSeekGeneration:
        SceneDirector.prototype._bumpSceneSeekGeneration,
      _cancelActiveSceneTravel:
        SceneDirector.prototype._cancelActiveSceneTravel,
      _setSceneMediaPlayback: SceneDirector.prototype._setSceneMediaPlayback,
    };
    try {
      layer.setParams({
        presentation: BHOTE_KOSHI_TRIGGER_RECORD_PRESENTATION,
      });
      await layer.enable(viewer);
      if (phase === 'move-end') moveStart.raiseEvent();
      if (phase === 'approach' || phase === 'orbit') callbacks[0]();
      if (phase === 'orbit') flights[0].complete();
      const oldFlights = [...flights];
      SceneDirector.prototype.stopScene.call(director);
      assert.equal(timers.size, 0, 'Stop cancels the actual delayed work');
      assert.deepEqual(
        [moveStart, moveEnd].map((e) => e.numberOfListeners),
        portListeners,
      );
      callbacks[0]();
      moveEnd.raiseEvent();
      for (const flight of oldFlights) flight.complete();
      assert.equal(
        flights.length,
        oldFlights.length,
        'no post-Stop approach or orbit',
      );
      assert.equal(
        layer.getStats().count,
        1,
        'Stop preserves the visible locator',
      );

      layer.setParams({
        presentation: BHOTE_KOSHI_TRIGGER_RECORD_PRESENTATION,
      });
      callbacks.at(-1)();
      const successor = flights.at(-1);
      const count = flights.length;
      callbacks[0]();
      for (const flight of oldFlights) {
        flight.cancel();
        flight.complete();
      }
      assert.equal(flights.length, count, 'old callbacks cannot add a flight');
      successor.complete();
      assert.equal(
        flights.length,
        count + 1,
        'successor retains its own orbit',
      );
    } finally {
      await layer.destroy();
    }
  });
}

test('Bhote Koshi locator keeps the regional context settled while nearby cities stagger in', async () => {
  const viewer = viewerFixture();
  const overlayHost = overlayHostFixture();
  let nowMs = 0;
  const layer = createBhoteKoshiLocatorLayer({
    boundaryResolver: async () => ({
      name: 'Nepal',
      ring: [
        [80, 26],
        [88, 26],
        [88, 30],
        [80, 30],
      ],
    }),
    requestRender() {},
    overlayHost,
    now: () => nowMs,
    ...nonRunningAnimation(),
  });

  layer.setParams({ presentation: BHOTE_KOSHI_CITY_CONTEXT_PRESENTATION });
  await layer.enable(viewer);
  const borderFill = viewer._test.item('nepal-border-fill');
  const entries = overlayHost._test.publications.at(-1).entries;
  const incident = entries.find(
    ({ id }) => id === 'bhote-koshi-incident-callout',
  );
  const kathmandu = entries.find(
    ({ id }) => id === 'bhote-koshi-city-kathmandu',
  );
  const bhaktapur = entries.find(
    ({ id }) => id === 'bhote-koshi-city-bhaktapur',
  );
  const dhulikhel = entries.find(
    ({ id }) => id === 'bhote-koshi-city-dhulikhel',
  );

  assert.ok(borderFill, 'the settled fill is drawn at once');
  assert.equal(viewer._test.item('nepal-border-highlight').revealFraction, 1);
  assert.equal(incident.contentAlpha(), 1);
  assert.equal(kathmandu.title, 'KATHMANDU');
  assert.equal(bhaktapur.title, 'BHAKTAPUR');
  assert.equal(dhulikhel.title, 'DHULIKHEL');
  assert.ok(
    [kathmandu, bhaktapur, dhulikhel].every(
      ({ variant, anchorDot }) => variant === 'label' && anchorDot === true,
    ),
  );
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
  const cities = layer.getAnalystRecords();
  assert.deepEqual(
    cities.map(({ id, name }) => [id, name]),
    [
      ['kathmandu', 'Kathmandu'],
      ['bhaktapur', 'Bhaktapur'],
      ['dhulikhel', 'Dhulikhel'],
    ],
  );
  assert.deepEqual(layer.getAnalystRecords(1), [cities[0]]);
  checkLocatorCardHeight(layer, cities[0], kathmandu.position);
  const point = Cesium.Cartographic.fromCartesian(kathmandu.position);
  assert.ok(
    Math.abs(Cesium.Math.toDegrees(point.latitude) - cities[0].lat) < 1e-6 &&
      Math.abs(Cesium.Math.toDegrees(point.longitude) - cities[0].lon) < 1e-6,
  );
  assert.deepEqual(layer.getParams(), {
    presentation: BHOTE_KOSHI_CITY_CONTEXT_PRESENTATION,
  });
  layer.setParams({ presentation: BHOTE_KOSHI_REGIONAL_PRESENTATION });
  assert.deepEqual(layer.getAnalystRecords(), []);
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
    const ids = viewer._test.ids();
    assert.ok(ids.includes('nepal-context-halo'));
    assert.ok(ids.includes('bhote-koshi-incident-halo'));
    assert.equal(ids.includes('bhote-koshi-city-kathmandu'), false);
    assert.equal(ids.includes('nepal-border-highlight'), false);
    assert.deepEqual(
      overlayHost._test.publications.at(-1).entries.map(({ id }) => id),
      ['nepal-context-callout', 'bhote-koshi-incident-callout'],
    );
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
  const boundary = new Promise((resolve) => {
    releaseBoundary = resolve;
  });
  const layer = createBhoteKoshiLocatorLayer({
    boundaryResolver: async () => boundary,
    requestRender() {},
    overlayHost,
    ...nonRunningAnimation(),
  });

  const enabling = layer.enable(viewer);
  assert.ok(viewer._test.item('nepal-context-halo'));
  assert.equal(viewer._test.item('nepal-border-highlight'), undefined);
  assert.equal(viewer._test.item('bhote-koshi-incident-halo'), undefined);
  assert.equal(overlayHost._test.publications.length, 1);
  assert.deepEqual(
    overlayHost._test.publications[0].entries.map(({ id }) => id),
    ['nepal-context-callout'],
  );

  releaseBoundary({
    ring: [
      [80, 26],
      [88, 26],
      [88, 30],
      [80, 30],
    ],
  });
  await enabling;
  assert.ok(viewer._test.item('bhote-koshi-incident-halo'));
  assert.ok(viewer._test.item('nepal-border-highlight'));
  assert.equal(viewer._test.item('bhote-koshi-city-kathmandu'), undefined);
  assert.equal(overlayHost._test.publications.length, 2);
  assert.deepEqual(
    overlayHost._test.publications.at(-1).entries.map(({ id }) => id),
    ['nepal-context-callout', 'bhote-koshi-incident-callout'],
  );
  await layer.destroy();
});

test('Bhote Koshi locator cancels a stale boundary resolution and removes its surface', async () => {
  const viewer = viewerFixture();
  const controller = new AbortController();
  let releaseBoundary;
  const boundary = new Promise((resolve) => {
    releaseBoundary = resolve;
  });
  const layer = createBhoteKoshiLocatorLayer({
    boundaryResolver: async () => boundary,
    requestRender() {},
    ...nonRunningAnimation(),
  });
  const enabling = layer.enable(viewer, { signal: controller.signal });
  controller.abort();
  releaseBoundary({
    ring: [
      [80, 26],
      [88, 26],
      [88, 30],
    ],
  });
  assert.ok(viewer._test.live().length > 0, 'drawn while it resolves');
  await assert.rejects(enabling, (error) => error?.name === 'AbortError');
  assert.equal(viewer._test.live().length, 0, 'let go');
});

test('Bhote Koshi locator layers draw sets of their own, and halos only as they change', async () => {
  const viewer = viewerFixture();
  const ring = [
    [80, 26],
    [88, 26],
    [88, 30],
    [80, 30],
  ];
  let nowMs = 0;
  const frames = nonRunningAnimation();
  const make = () =>
    createBhoteKoshiLocatorLayer({
      boundaryResolver: async () => ({ name: 'Nepal', ring }),
      requestRender() {},
      overlayHost: overlayHostFixture(),
      now: () => nowMs,
      ...frames,
    });
  const first = make();
  const second = make();
  assert.equal(await first.enable(viewer, { origin: 'scene' }), true);
  assert.equal(await second.enable(viewer, { origin: 'scene' }), true);
  const ids = viewer._test.live().map(({ spec }) => spec.id);
  assert.equal(ids.length, 6);
  assert.equal(new Set(ids).size, 6, 'no two layers share a set');

  // Before the incident halo is due, nothing about any halo changes.
  const halos = viewer._test.live().filter(({ kind }) => kind === 'points');
  nowMs = 100;
  frames.tick();
  const writes = halos.map((set) => set.writes);
  frames.tick();
  frames.tick();
  assert.deepEqual(
    halos.map((set) => set.writes),
    writes,
    'unchanged halos are not drawn again',
  );

  assert.equal(await first.disable(), true);
  assert.equal(viewer._test.live().length, 3, 'the other layer keeps its sets');
  assert.equal(await second.disable(), true);
  assert.equal(viewer._test.live().length, 0);
});

// The trigger record's callout is an actionable card: the layers under it
// stand aside for it, so a click on it opens its source, as its keyboard
// action does; anything else on top is left alone.
test('a click on the locator callout runs its action', async () => {
  const viewer = viewerFixture();
  let onClick = null;
  let top = null;
  const activated = [];
  const layer = createBhoteKoshiLocatorLayer({
    overlayHost: overlayHostFixture(),
    requestRender() {},
    ...nonRunningAnimation(),
    input: () => ({
      onClick(callback) {
        onClick = callback;
        return () => {
          onClick = null;
        };
      },
    }),
  });
  // The card on top at a click, as the host answers the pick registry.
  setClickCardHitTest(() => top);
  await layer.init(viewer);
  await layer.enable(viewer);
  const click = (extra = {}) =>
    onClick?.({
      screenPosition: { x: 5, y: 5 },
      gesture: { travelPx: 0, durationMs: 80 },
      topHit: null,
      hit: null,
      ...extra,
    });
  top = {
    sourceId: BHOTE_KOSHI_LOCATOR_OVERLAY_SOURCE_ID,
    entryId: 'bhote-koshi-trigger-record-callout',
    entry: { activate: () => activated.push('trigger') },
  };
  click();
  assert.deepEqual(activated, ['trigger']);
  top = {
    sourceId: 'earthquake-card',
    entry: { activate: () => activated.push('other') },
  };
  click();
  assert.deepEqual(activated, ['trigger'], 'another layer on top is its own');
  // A drag that ends on it is not a click on it.
  top = {
    sourceId: BHOTE_KOSHI_LOCATOR_OVERLAY_SOURCE_ID,
    entry: { activate: () => activated.push('trigger') },
  };
  click({ gesture: { travelPx: 30, durationMs: 80 } });
  assert.deepEqual(activated, ['trigger'], 'a drag does not open it');
  // On top, it takes the click over an aircraft or a camera under it, exact
  // or a touch contact: those layers stand aside under a card.
  registerPickOwner('test-planes', (id) => id === 'plane:1');
  try {
    const plane = { set: 'planes:1', id: 'plane:1' };
    const cam = { set: 'cams:1', id: 'cam:1' };
    click({ topHit: plane, hit: plane });
    click({ topHit: null, hit: plane });
    click({ topHit: cam, hit: cam });
    assert.equal(activated.length, 4, 'the callout on top acts each time');
  } finally {
    unregisterPickOwner('test-planes');
    setClickCardHitTest(null);
  }
  await layer.disable();
  assert.equal(onClick, null, 'disable removes the click handler');
});
