import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createRiverGaugesLayer } from './index.js';
import { layerFeedState } from '../../data/feedState.js';

const status = (category, stage = 4.2) => ({
  stage,
  stageUnit: 'ft',
  flow: 1.3,
  flowUnit: 'kcfs',
  category,
  time: '2026-10-24T01:15:00.000Z',
});
const gauge = (lid, category, lat = 30, lon = -97) => ({
  id: `river-gauge:${lid}`,
  lid,
  name: `Gauge ${lid}`,
  lat,
  lon,
  state: 'TX',
  wfo: 'EWX',
  observed: status(category),
  forecast: null,
});
const snapshot = (gauges, extra = {}) => ({
  gauges,
  generatedAt: '2026-10-24T02:00:00.000Z',
  stale: false,
  failedRegions: 0,
  ...extra,
});
const DETAIL = {
  lid: 'MODR1',
  usgsId: '08158930',
  inService: true,
  stageUnit: 'ft',
  flowUnit: 'cfs',
  thresholds: {
    action: { stage: 10, flow: null },
    minor: { stage: 13, flow: null },
    moderate: { stage: 14, flow: null },
    major: { stage: 18, flow: null },
  },
  crests: {
    historic: [{ time: '2015-10-30T16:12:00.000Z', stage: 16.1, flow: 11293 }],
    recent: [{ time: '2019-05-04T03:10:00.000Z', stage: 14.94, flow: 8402 }],
  },
};

/** The real layer over a viewer stand-in: scene, camera, picking, overlay host. */
function harness({ getSnapshot, getGauge = async () => DETAIL }) {
  const primitives = [];
  const cards = new Map();
  const opened = [];
  const owners = new Map();
  let clickAction = null;
  let picked;
  let cardHit = null;
  const viewer = {
    trackedEntity: null,
    camera: {
      // Above Texas, 3,000 km up.
      positionWC: Cesium.Cartesian3.fromDegrees(-97, 30, 3_000_000),
      viewMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
      heading: 0,
      flights: [],
      flyToBoundingSphere(sphere) {
        this.flights.push(sphere);
      },
    },
    scene: {
      canvas: {},
      preRender: new Cesium.Event(),
      primitives: {
        add: (p) => (primitives.push(p), p),
        remove: (p) => primitives.splice(primitives.indexOf(p), 1),
      },
      pick: () => picked,
    },
  };
  const layer = createRiverGaugesLayer({
    source: { getSnapshot, getGauge, label: 'NOAA NWPS · OBSERVED' },
    overlayHost: {
      setEntries: (id, entries) => cards.set(id, entries),
      setVisible() {},
      clearSource: (id) => cards.delete(id),
      hitTest: () => cardHit,
    },
    picking: {
      resolvePickId: (p) => (typeof p?.id === 'string' ? p.id : null),
      isOwnedByOtherLayer: (layerId, id) => id.startsWith('flight:'),
      registerPickOwner: (id, owns) => owners.set(id, owns),
      unregisterPickOwner: (id) => owners.delete(id),
    },
    pointer: { isPointerFree: () => true },
    openExternal: (url) => opened.push(url),
    screenSpaceEventHandlerFactory: () => ({
      setInputAction: (fn) => (clickAction = fn),
      destroy: () => (clickAction = null),
    }),
  });
  layer.init(viewer);
  return {
    layer,
    viewer,
    primitives,
    opened,
    owners,
    card: () => cards.get('river-gauges')?.[0] || null,
    points: () => primitives[0],
    pointFor: (lid) => {
      const collection = primitives[0];
      for (let i = 0; i < collection.length; i++)
        if (collection.get(i).id === `river-gauge:${lid}`)
          return collection.get(i);
      return null;
    },
    click(id, hit = null) {
      picked = id ? { id } : undefined;
      cardHit = hit;
      clickAction({ position: new Cesium.Cartesian2(10, 10) });
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a snapshot draws one point per gauge, floods on top and larger', async () => {
  const h = harness({
    getSnapshot: async () =>
      snapshot([
        gauge('MODR1', 'moderate'),
        gauge('CALM1', 'no_flooding'),
        gauge('GONE1', 'out_of_service'),
        gauge('ACTN1', 'action'),
      ]),
  });
  h.layer.enable();
  assert.equal(await h.layer.update(), true);
  const points = h.points();
  assert.equal(points.length, 4);
  // Drawn least severe first, so floods paint over quiet gauges.
  assert.equal(points.get(points.length - 1).id, 'river-gauge:MODR1');
  assert.equal(points.get(0).id, 'river-gauge:GONE1');
  assert.ok(h.pointFor('MODR1').pixelSize > h.pointFor('CALM1').pixelSize);
  assert.ok(h.pointFor('GONE1').color.alpha < 1, 'out of service is dimmed');
  assert.ok(
    h
      .pointFor('MODR1')
      .color.equals(Cesium.Color.fromCssColorString('#ff2020')),
  );
  const stats = h.layer.getStats();
  assert.equal(stats.count, 4);
  assert.equal(stats.countLabel, '4 gauges · 1 moderate · 1 at action');
  assert.equal(stats.countsByCategory.moderate, 1);
  assert.equal(stats.observedAt, Date.parse('2026-10-24T01:15:00.000Z'));
  assert.equal(layerFeedState(stats), 'nominal');
  const legend = h.layer.getRowControls().legend;
  assert.equal(legend.find((l) => l.label === 'Moderate flooding').count, 1);
  assert.ok(h.owners.get('river-gauges')('river-gauge:MODR1'));
});

test('gauges on the far side of the globe are hidden', async () => {
  const h = harness({
    getSnapshot: async () =>
      snapshot([gauge('NEAR1', 'minor'), gauge('FARR1', 'minor', -30, 83)]),
  });
  h.layer.enable();
  await h.layer.update();
  assert.equal(h.pointFor('NEAR1').show, true);
  assert.equal(h.pointFor('FARR1').show, false);
  // The camera moves to the other side; the next frame re-culls.
  h.viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(
    83,
    -30,
    3_000_000,
  );
  h.viewer.camera.viewMatrix = Cesium.Matrix4.fromUniformScale(2);
  h.viewer.scene.preRender.raiseEvent();
  assert.equal(h.pointFor('NEAR1').show, false);
  assert.equal(h.pointFor('FARR1').show, true);
});

test('a click opens the card, loads flood stages, and the card opens NWPS', async () => {
  const asked = [];
  const h = harness({
    getSnapshot: async () => snapshot([gauge('MODR1', 'moderate')]),
    getGauge: async (lid) => (asked.push(lid), DETAIL),
  });
  h.layer.enable();
  await h.layer.update();
  h.click('river-gauge:MODR1');
  let card = h.card();
  assert.equal(card.title, 'Gauge MODR1');
  assert.equal(card.accent, '#ff2020');
  assert.ok(card.details.includes('Moderate flooding'));
  assert.ok(card.details.includes('Loading flood stages…'));
  assert.ok(h.pointFor('MODR1').pixelSize > 13, 'selected point grows');
  await settle();
  card = h.card();
  assert.deepEqual(asked, ['MODR1']);
  assert.ok(
    card.details.includes(
      'Flood stages (ft): action 10 · minor 13 · moderate 14 · major 18',
    ),
    card.details.join('\n'),
  );
  assert.ok(card.details.includes('Recent crest 14.94\u00a0ft on May 4, 2019'));
  assert.ok(
    card.details.includes('Highest crest 16.1\u00a0ft on Oct 30, 2015'),
  );
  assert.ok(card.details.includes('USGS site 08158930'));
  // A click on the card itself opens the gauge page and keeps the selection.
  h.click(null, { entryId: card.id });
  assert.deepEqual(h.opened, ['https://water.noaa.gov/gauges/MODR1']);
  assert.ok(h.card());
  // Another layer's aircraft leaves the selection alone; empty map clears it.
  h.click('flight:abc123');
  assert.ok(h.card());
  h.click(null);
  assert.equal(h.card(), null);
  assert.equal(h.pointFor('MODR1').pixelSize, 13);
  // Detail is kept for the session: reselecting asks NWPS nothing new.
  h.click('river-gauge:MODR1');
  await settle();
  assert.deepEqual(asked, ['MODR1']);
});

test('a failed detail read says so and is asked again on reselection', async () => {
  let fail = true;
  const h = harness({
    getSnapshot: async () => snapshot([gauge('MODR1', 'moderate')]),
    getGauge: async () => {
      if (fail) throw new Error('NWPS HTTP 502');
      return DETAIL;
    },
  });
  h.layer.enable();
  await h.layer.update();
  h.click('river-gauge:MODR1');
  await settle();
  assert.ok(h.card().details.includes('Flood stages unavailable'));
  h.click(null);
  fail = false;
  h.click('river-gauge:MODR1');
  await settle();
  assert.ok(
    h.card().details.some((line) => line.startsWith('Flood stages (ft)')),
  );
});

test('SHOW MOST SEVERE selects the worst flood and flies there', async () => {
  const h = harness({
    getSnapshot: async () =>
      snapshot([
        gauge('MINR1', 'minor', 30, -97),
        gauge('MAJR1', 'major', 40, -90),
        gauge('CALM1', 'no_flooding'),
      ]),
  });
  h.layer.enable();
  await h.layer.update();
  const chip = h.layer.getRowControls().chips[0];
  assert.equal(chip.disabled, false);
  assert.equal(chip.onClick(), true);
  assert.equal(h.card().title, 'Gauge MAJR1');
  assert.equal(h.viewer.camera.flights.length, 1);
});

test('a failed refresh keeps the gauges up as stale with a fixed error', async () => {
  let fail = false;
  const h = harness({
    getSnapshot: async () => {
      if (fail) throw new Error('NWPS HTTP 503');
      return snapshot([gauge('MODR1', 'moderate')]);
    },
  });
  h.layer.enable();
  await h.layer.update();
  fail = true;
  assert.equal(await h.layer.update(), false);
  const stats = h.layer.getStats();
  assert.equal(stats.count, 1);
  assert.equal(stats.stale, true);
  assert.equal(stats.error, 'NWPS HTTP 503');
  assert.equal(layerFeedState(stats), 'stale');
  assert.equal(h.points().length, 1);
});

test('a server snapshot with failed regions reads stale; none yet reads unavailable', async () => {
  const h = harness({
    getSnapshot: async () =>
      snapshot([gauge('MODR1', 'moderate')], { stale: true, failedRegions: 1 }),
  });
  h.layer.enable();
  await h.layer.update();
  assert.equal(h.layer.getStats().stale, true);
  assert.equal(h.layer.getStats().loadingLabel, 'Some regions not refreshed');

  const empty = harness({
    getSnapshot: async () => {
      throw new Error('NWPS HTTP 503');
    },
  });
  empty.layer.enable();
  await empty.layer.update();
  assert.equal(layerFeedState(empty.layer.getStats()), 'unavailable');
  assert.equal(empty.layer.getStats().stale, false);
});

test('a response landing after disable draws nothing; destroy releases the scene', async () => {
  let release;
  const h = harness({
    getSnapshot: () =>
      new Promise((resolve) => {
        release = () => resolve(snapshot([gauge('MODR1', 'moderate')]));
      }),
  });
  h.layer.enable();
  const pending = h.layer.update();
  assert.equal(h.layer.getStats().loading, true);
  h.layer.disable();
  release();
  assert.equal(await pending, false);
  assert.equal(h.points().length, 0);
  assert.equal(h.points().show, false);
  assert.equal(h.owners.size, 0);
  assert.deepEqual(h.layer.getAnalystRecords(), []);
  h.layer.destroy();
  assert.equal(h.primitives.length, 0);
});
