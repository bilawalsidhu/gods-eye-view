import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurbulenceLayer, containsPoint } from './index.js';
import { SURFACE_FLOOR_M } from './rendering.js';
import {
  FEET_TO_METERS,
  normalizeGairmet,
  normalizePireps,
  normalizeSigmets,
  validateTurbulenceSnapshot,
} from './records.js';
import { GAIRMET_FORE6, PIREPS, SIGMETS } from './awc.fixture.mjs';
import { createWorldClock } from '../../time/worldClock.js';
import { layerFeedState } from '../../data/feedState.js';
import { fakeInput } from '../../input/testDoubles.mjs';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';

const H = 3_600_000;
// The fixtures were captured at about 20:20Z on 2026-11-17.
const NOW = Date.parse('2026-11-17T20:20:00Z');
const T15 = Date.parse('2026-11-17T15:00:00Z');

/** The proxy's snapshot: the captured G-AIRMET hour copied to all five. */
function snapshot(overrides = {}) {
  const forecasts = [0, 3, 6, 9, 12].flatMap((fore) =>
    normalizeGairmet(
      {
        features: GAIRMET_FORE6.features.map((feature) => ({
          ...feature,
          properties: {
            ...feature.properties,
            validTime: new Date(T15 + fore * H).toISOString(),
          },
        })),
      },
      { now: NOW },
    ),
  );
  return validateTurbulenceSnapshot({
    schemaVersion: 1,
    fetchedAt: NOW,
    stale: false,
    partial: false,
    unavailable: false,
    reason: null,
    forecasts,
    warnings: normalizeSigmets(SIGMETS, { now: NOW }),
    reports: normalizePireps(PIREPS, { now: NOW }),
    ...overrides,
  });
}

function harness({ feed = { getSnapshot: async () => snapshot() } } = {}) {
  let pickResult = null;
  let ground = null;
  const viewer = { scene: { pick: () => pickResult } };
  const { draw } = bindFakeDraw(viewer);
  const input = fakeInput(viewer);
  const overlay = { entries: new Map(), visible: null };
  const clock = createWorldClock({
    now: () => NOW,
    requestFrame: null,
    cancelFrame: null,
  });
  const layer = createTurbulenceLayer({
    feed,
    overlayHost: {
      setEntries: (id, entries) => overlay.entries.set(id, entries),
      setVisible: (id, visible) => (overlay.visible = visible),
      clearSource: (id) => overlay.entries.delete(id),
      hitTest: () => null,
    },
    inputFor: () => input.input,
    picking: {
      resolvePickId: (picked) => picked?.id?.id ?? picked?.id ?? null,
      isOwnedByOtherLayer: (layerId, id) => String(id).startsWith('other:'),
    },
    clock,
    groundLonLat: () => ground,
  });
  layer.init(viewer);
  layer.enable(viewer);
  const live = (part) =>
    [...draw.sets.values()].filter(
      (record) => !record.disposed && record.spec.id.includes(`:${part}`),
    );
  return {
    layer,
    draw,
    clock,
    overlay,
    forecastSets: () => live('forecast:'),
    shownForecast: () => live('forecast:').filter((set) => set.show),
    warnings: () => live('warnings')[0],
    reports: () => live('reports')[0],
    click(at = null, pick = null) {
      ground = at;
      pickResult = pick;
      input.click({ x: 20, y: 20 });
    },
    card: () => overlay.entries.get('weather-turbulence')?.[0] ?? null,
  };
}

test('volumes run from floor to top; one set per forecast hour, the nearest shown', async (t) => {
  const h = harness();
  t.after(() => h.layer.destroy());
  assert.equal(await h.layer.update(), true);
  assert.equal(h.forecastSets().length, 5);
  const [shown] = h.shownForecast();
  assert.equal(h.shownForecast().length, 1);
  assert.match(
    shown.spec.id,
    new RegExp(`:forecast:${T15 + 6 * H}$`),
    'at 20:20Z the 21Z snapshot',
  );
  assert.equal(shown.spec.pickable, false, 'volumes never take part in picks');
  assert.equal(shown.spec.blend, 'translucent');
  const items = [...shown.items.values()];
  const high = items.find(
    (item) => item.extrudeHeight === 34_000 * FEET_TO_METERS,
  );
  assert.ok(high, 'FL340 top');
  assert.equal(high.height, 'absolute');
  assert.equal(high.lit, false);
  assert.equal(high.geometry.rings[0][0].height, 18_000 * FEET_TO_METERS);
  const surface = items.find(
    (item) => item.extrudeHeight === 18_000 * FEET_TO_METERS,
  );
  assert.equal(
    surface.geometry.rings[0][0].height,
    SURFACE_FLOOR_M,
    'SFC floor buried',
  );
  assert.ok(h.warnings().show && h.reports().show);
});

test('scrubbing the timeline switches the hour without rebuilding a set', async (t) => {
  const h = harness();
  t.after(() => h.layer.destroy());
  await h.layer.update();
  const writes = () => h.forecastSets().map((set) => set.writes);
  const before = writes();
  for (const hours of [9, 12, 0, 3]) {
    h.clock.seek(T15 + hours * H);
    assert.match(
      h.shownForecast()[0].spec.id,
      new RegExp(`:forecast:${T15 + hours * H}$`),
    );
  }
  assert.deepEqual(writes(), before, 'no forecast set was rewritten');
  // Far beyond the last snapshot: no forecast shown.
  h.clock.seek(T15 + 20 * H);
  assert.equal(h.shownForecast().length, 0);
});

test('warnings follow their validity, reports the three hours before', async (t) => {
  const h = harness();
  t.after(() => h.layer.destroy());
  await h.layer.update();
  const regions = () =>
    new Set([...h.warnings().items.keys()].map((id) => id.split(':')[1]));
  assert.deepEqual(
    regions(),
    new Set(['ZGGG', 'CWAO', 'RUMG', 'SCFA']),
    'four warnings in force at 20:20Z',
  );
  assert.equal(h.reports().items.size, 5);
  h.clock.seek(Date.parse('2026-11-17T21:50:00Z'));
  assert.deepEqual(regions(), new Set(['RUMG']), 'only Magadan runs to 22:00Z');
  assert.equal(h.reports().items.size, 4, 'the 18:48Z report has aged out');
  h.clock.seek(Date.parse('2026-11-18T00:00:00Z'));
  assert.equal(h.warnings().items.size, 0);
  assert.equal(h.reports().items.size, 0);
  const reportItem = () => [...h.reports().items.values()][0];
  h.clock.seek(NOW);
  assert.equal(reportItem().height, 'absolute');
  assert.equal(reportItem().pos.height, 39_000 * FEET_TO_METERS);
  // Zoomed out, a dot spans kilometres: drawn over depth so the globe does
  // not cut it, and culled past the horizon instead.
  assert.equal(reportItem().disableDepthTest, Number.POSITIVE_INFINITY);
  assert.equal(h.reports().spec.horizonCull, true);
});

test('filters hide records; the panel chips carry the toggles', async (t) => {
  const h = harness();
  t.after(() => h.layer.destroy());
  await h.layer.update();
  h.layer.setParams({ high: false });
  const items = [...h.shownForecast()[0].items.values()];
  assert.ok(items.length > 0);
  assert.ok(
    items.every((item) => item.extrudeHeight === 18_000 * FEET_TO_METERS),
    'only the low (SFC to FL180) area is left',
  );
  h.layer.setParams({ high: true, severe: false });
  assert.equal(h.warnings().items.size, 0, 'every SIGMET is severe');
  h.layer.setParams({ forecasts: false, severe: true });
  assert.equal(h.forecastSets().length, 0);
  assert.equal(h.layer.getParams().forecasts, false);
  const { summary } = h.layer.getRowControls();
  const sources = summary.settings.find((s) => s.id === 'sources');
  const forecasts = sources.chips.find((c) => c.id === 'sources-forecasts');
  assert.equal(forecasts.active, false);
  assert.deepEqual(forecasts.params, { forecasts: true });
  h.layer.setParams({ nonsense: false, light: 'no' });
  assert.equal(
    h.layer.getParams().light,
    true,
    'unknown or non-boolean params are ignored',
  );
});

test('a map click inside a volume opens its card; outside clears it', async (t) => {
  const h = harness();
  t.after(() => h.layer.destroy());
  await h.layer.update();
  // Inside the 2W TURB-HI area off South Carolina, valid 21Z.
  h.click({ lon: -79, lat: 32 });
  const card = h.card();
  assert.ok(card, 'card published');
  assert.match(card.title, /TURBULENCE FORECAST/);
  assert.ok(
    card.details.some((line) => /FL180/.test(line) && /FL340/.test(line)),
  );
  assert.equal(
    card.details.at(-1),
    'Informational only · not for flight planning',
  );
  assert.ok(card.position, 'anchored in the world');
  h.click({ lon: 10, lat: 10 });
  assert.equal(h.card(), null, 'empty map clears it');
});

test('a renderer that picks a volume anyway still selects by the map point', async (t) => {
  const h = harness();
  t.after(() => h.layer.destroy());
  await h.layer.update();
  const [shown] = h.shownForecast();
  const [itemId] = [...shown.items.keys()];
  h.click({ lon: -79, lat: 32 }, { id: { set: shown.spec.id, id: itemId } });
  assert.match(h.card()?.title ?? '', /TURBULENCE FORECAST/);
});

test('a severe warning outranks a forecast at the same spot', async (t) => {
  const square = [
    [-80, 31],
    [-78, 31],
    [-78, 33],
    [-80, 33],
    [-80, 31],
  ];
  const h = harness({
    feed: {
      getSnapshot: async () => {
        const base = snapshot();
        return {
          ...base,
          warnings: [
            {
              ...base.warnings[0],
              id: 'warning:KKCI:X:1',
              region: 'MIAMI OCEANIC',
              polygons: [[square]],
            },
          ],
        };
      },
    },
  });
  t.after(() => h.layer.destroy());
  await h.layer.update();
  h.click({ lon: -79, lat: 32 });
  assert.match(h.card().title, /SIGMET/);
});

test('a click on a pilot report opens its card', async (t) => {
  const h = harness();
  t.after(() => h.layer.destroy());
  await h.layer.update();
  const [reportId] = [...h.reports().items.keys()];
  h.click(null, { id: { set: h.reports().spec.id, id: reportId } });
  const card = h.card();
  assert.match(card.title, /PILOT REPORT/);
  assert.ok(card.details.some((line) => /FL390/.test(line)));
  assert.ok(card.details.some((line) => /B737/.test(line)));
});

test("another layer's owned pick is left alone", async (t) => {
  const h = harness();
  t.after(() => h.layer.destroy());
  await h.layer.update();
  h.click({ lon: -79, lat: 32 });
  assert.ok(h.card());
  h.click(null, { id: { set: 'flights:1', id: 'other:abc' } });
  assert.ok(h.card(), 'an aircraft click does not clear the turbulence card');
});

test('failures and unavailable snapshots report an error but keep the layer on', async (t) => {
  let mode = 'throw';
  const h = harness({
    feed: {
      getSnapshot: async () => {
        if (mode === 'throw') throw new Error('Turbulence HTTP 502');
        return snapshot({
          unavailable: true,
          reason: 'Turbulence data unavailable',
          forecasts: [],
          warnings: [],
          reports: [],
        });
      },
    },
  });
  t.after(() => h.layer.destroy());
  assert.equal(
    await h.layer.update(),
    true,
    'a first failure must not fail enabling',
  );
  assert.equal(h.layer.getStats().error, 'Turbulence HTTP 502');
  mode = 'unavailable';
  assert.equal(await h.layer.update(), true);
  assert.equal(h.layer.getStats().error, 'Turbulence data unavailable');
  assert.equal(h.forecastSets().length, 0);
  assert.equal(
    h.layer.getRowControls().summary.status,
    'Turbulence data unavailable',
  );
});

test('stale and partial snapshots show in the chip, not as errors', async (t) => {
  const h = harness({
    feed: { getSnapshot: async () => snapshot({ stale: true, partial: true }) },
  });
  t.after(() => h.layer.destroy());
  await h.layer.update();
  const stats = h.layer.getStats();
  assert.equal(stats.error, null);
  assert.equal(stats.stale, true);
  assert.equal(stats.partial, true);
  assert.equal(layerFeedState(stats), 'stale');
  assert.equal(h.layer.getRowControls().summary.status, 'Stale source');
});

test('turned off, the layer leaves no draw set behind; on again, it redraws', async (t) => {
  const h = harness();
  t.after(() => h.layer.destroy());
  await h.layer.update();
  assert.ok(h.forecastSets().length && h.warnings() && h.reports());
  h.layer.disable();
  const live = [...h.draw.sets.values()].filter((set) => !set.disposed);
  assert.deepEqual(
    live.map((set) => set.spec.id),
    [],
    'every turbulence set is disposed',
  );
  h.layer.enable();
  await h.layer.update();
  assert.equal(h.forecastSets().length, 5);
  assert.equal(h.shownForecast().length, 1);
  assert.ok(h.warnings().show && h.reports().show, 'redrawn and shown');
});

test('the clock is held while on and offers the forecast span', async (t) => {
  const h = harness();
  t.after(() => h.layer.destroy());
  assert.equal(h.clock.follows('weather-turbulence'), true);
  await h.layer.update();
  const span = h.clock.coverage();
  assert.equal(span.start, T15 - 1.5 * H);
  assert.equal(span.end, T15 + 13.5 * H);
  assert.equal(h.clock.isSupported(), true);
  h.layer.disable();
  assert.equal(h.clock.follows('weather-turbulence'), false);
  assert.equal(h.clock.coverage(), null);
});

test('readout: counts, three setting groups, a categorical legend, the disclaimer', async (t) => {
  const h = harness();
  t.after(() => h.layer.destroy());
  await h.layer.update();
  const controls = h.layer.getRowControls();
  assert.equal(controls.readout, true);
  assert.equal(controls.legendCategorical, true);
  assert.deepEqual(
    controls.legend.map((band) => band.color),
    ['#ffd54f', '#ff9800', '#f44336', '#d500f9'],
  );
  assert.deepEqual(
    controls.summary.settings.map((s) => s.id),
    ['severity', 'altitude', 'sources'],
  );
  // The English label column is 56px (weather.css, held by
  // english-css-parity.test.mjs): about six letter-spaced capitals.
  for (const { label } of controls.summary.settings)
    assert.ok(label.length <= 6, `"${label}" fits the English label column`);
  assert.match(controls.summary.detail, /21:00/);
  assert.match(
    controls.summary.lines[0].text,
    /Forecast areas 3 · Warnings 4 · Pilot reports 5/,
  );
  assert.ok(
    controls.summary.lines.some(
      (line) =>
        line.text === 'Informational only · not for flight planning' &&
        line.muted,
    ),
  );
  assert.equal(h.layer.getStats().count, 12);
  const records = h.layer.getAnalystRecords();
  assert.equal(records.length, 12);
  assert.ok(
    records.every((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon)),
  );
});

test('containsPoint skips holes and unwraps across the antimeridian', () => {
  const ring = (w, s, e, n) => [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
    [w, s],
  ];
  const donut = { polygons: [[ring(0, 0, 10, 10), ring(4, 4, 6, 6)]] };
  assert.equal(containsPoint(donut, 2, 2), true);
  assert.equal(containsPoint(donut, 5, 5), false, 'inside the hole');
  const pacific = {
    polygons: [
      [
        [
          [170, 10],
          [-170, 10],
          [-170, 20],
          [170, 20],
          [170, 10],
        ],
      ],
    ],
  };
  assert.equal(containsPoint(pacific, 179, 15), true);
  assert.equal(containsPoint(pacific, -179, 15), true);
  assert.equal(containsPoint(pacific, 0, 15), false);
});
