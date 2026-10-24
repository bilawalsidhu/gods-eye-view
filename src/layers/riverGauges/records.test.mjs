import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RIVER_GAUGE_CATEGORIES,
  countGaugesInFlood,
  countRiverGauges,
  forecastIsCurrent,
  mapRiverGaugeAnalystRecord,
  newestRiverGaugeObservation,
  normalizeRiverGaugeSnapshot,
  riverGaugeCategory,
  riverGaugePageUrl,
  toFeet,
  toKcfs,
} from './records.js';

const status = (category, extra = {}) => ({
  stage: 4.2,
  stageUnit: 'ft',
  flow: 1.3,
  flowUnit: 'kcfs',
  category,
  time: '2026-10-24T01:15:00.000Z',
  ...extra,
});
const gauge = (lid, category = 'no_flooding', extra = {}) => ({
  lid,
  name: `Gauge ${lid}`,
  lat: 30,
  lon: -97,
  state: 'TX',
  wfo: 'EWX',
  observed: status(category),
  forecast: null,
  ...extra,
});

test('categories carry the NWS flood colours and rank flood stages first', () => {
  const byId = Object.fromEntries(RIVER_GAUGE_CATEGORIES.map((c) => [c.id, c]));
  assert.equal(byId.action.color, '#ffee00');
  assert.equal(byId.minor.color, '#ff9900');
  assert.equal(byId.moderate.color, '#ff2020');
  assert.equal(byId.major.color, '#cc33ff');
  assert.deepEqual(
    RIVER_GAUGE_CATEGORIES.filter((c) => c.inFlood).map((c) => c.id),
    ['major', 'moderate', 'minor', 'action'],
  );
  // A flood is drawn larger than any reading below flood stage.
  const smallestFlood = Math.min(
    ...RIVER_GAUGE_CATEGORIES.filter((c) => c.inFlood).map((c) => c.size),
  );
  for (const c of RIVER_GAUGE_CATEGORIES.filter((c) => !c.inFlood))
    assert.ok(c.size < smallestFlood, c.id);
  for (const id of ['not_defined', 'obs_not_current', 'out_of_service'])
    assert.equal(byId[id].dim, true, id);
  assert.equal(riverGaugeCategory('record').id, 'not_defined');
  assert.equal(riverGaugeCategory('fcst_not_current').inFlood, false);
});

test('a snapshot validates rows and keeps the server stale flag', () => {
  const snapshot = normalizeRiverGaugeSnapshot({
    generatedAt: '2026-10-24T02:00:00.000Z',
    stale: true,
    regions: { total: 27, failed: ['alaska'] },
    gauges: [
      gauge('AAIT2', 'moderate'),
      gauge('../x1'),
      gauge('BBBB1', 'no_flooding', { lat: 91 }),
      gauge('CCCC1', 'bogus', {
        forecast: status('fcst_not_current', {
          stage: null,
          flow: null,
          time: null,
        }),
      }),
    ],
  });
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.failedRegions, 1);
  assert.deepEqual(
    snapshot.gauges.map((g) => [g.id, g.observed.category]),
    [
      ['river-gauge:AAIT2', 'moderate'],
      ['river-gauge:CCCC1', 'not_defined'],
    ],
  );
  assert.equal(snapshot.gauges[1].forecast.category, 'fcst_not_current');
  assert.equal(normalizeRiverGaugeSnapshot({}), null);
  assert.equal(normalizeRiverGaugeSnapshot(null), null);
});

test('counts cover every category and flood counts action and above', () => {
  const counts = countRiverGauges([
    gauge('A', 'major'),
    gauge('B', 'minor'),
    gauge('C', 'minor'),
    gauge('D', 'action'),
    gauge('E', 'no_flooding'),
    gauge('F', 'out_of_service'),
  ]);
  assert.equal(Object.keys(counts).length, RIVER_GAUGE_CATEGORIES.length);
  assert.equal(counts.minor, 2);
  assert.equal(counts.moderate, 0);
  assert.equal(countGaugesInFlood(counts), 4);
});

test('forecasts show only when current; the page link needs a valid id', () => {
  assert.equal(forecastIsCurrent(null), false);
  assert.equal(forecastIsCurrent(status('fcst_not_current')), false);
  assert.equal(forecastIsCurrent(status('minor', { time: null })), false);
  assert.equal(
    forecastIsCurrent(status('minor', { stage: null, flow: null })),
    false,
  );
  assert.equal(forecastIsCurrent(status('minor')), true);
  assert.equal(
    riverGaugePageUrl('AAIT2'),
    'https://water.noaa.gov/gauges/AAIT2',
  );
  assert.equal(riverGaugePageUrl('aait2'), null);
  assert.equal(riverGaugePageUrl('AAIT2/../x'), null);
});

test('analyst records use feet and kcfs whatever unit NWPS sent', () => {
  assert.equal(toFeet(2, 'm'), 6.56);
  assert.equal(toFeet(2, 'ft'), 2);
  assert.equal(toFeet(2, 'furlong'), null);
  assert.equal(toKcfs(2500, 'cfs'), 2.5);
  assert.equal(toKcfs(1.2, 'kcfs'), 1.2);
  assert.equal(toKcfs(null, 'kcfs'), null);
  const record = mapRiverGaugeAnalystRecord(
    gauge('AAIT2', 'minor', { forecast: status('moderate') }),
  );
  assert.deepEqual(record, {
    id: 'AAIT2',
    name: 'Gauge AAIT2',
    state: 'TX',
    category: 'minor',
    stageFt: 4.2,
    flowKcfs: 1.3,
    observedMs: Date.parse('2026-10-24T01:15:00.000Z'),
    lat: 30,
    lon: -97,
  });
  assert.equal(
    newestRiverGaugeObservation([
      gauge('A'),
      gauge('B', 'minor', {
        observed: status('minor', { time: '2026-10-24T03:00:00Z' }),
      }),
      gauge('C', 'minor', { observed: status('minor', { time: null }) }),
    ]),
    Date.parse('2026-10-24T03:00:00Z'),
  );
});
