import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CPCB_POLLUTANTS,
  cpcbObservationTime,
  normalizeCpcbRecords,
} from './cpcb.js';
import { createAirQualitySource } from './providers.js';
import { createAirQualityLayer } from './index.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { airQualitySettled } from '../../testSupport/airQualityViewer.mjs';

const now = Date.parse('2026-10-18T06:30:00Z');
const row = (patch = {}) => ({
  country: 'India',
  state: 'Delhi',
  city: 'Delhi',
  station: 'Test station',
  latitude: '28.6',
  longitude: '77.2',
  pollutant_id: 'PM2.5',
  pollutant_avg: '123',
  last_update: '18-10-2026 12:00:00',
  ...patch,
});
const normalize = (records) => normalizeCpcbRecords({ records }, { now });
const readingsOf = (records) => normalize(records).readings;

test('OGD dates are IST, independent of host timezone, and invalid dates are rejected', () => {
  assert.equal(cpcbObservationTime('18-10-2026 12:00:00'), now);
  for (const date of [
    '31-02-2026 12:00:00',
    '18-10-2026 24:00:00',
    '',
    null,
    '2026-10-18',
  ])
    assert.equal(cpcbObservationTime(date), null);
});

test('missing values never become zero; stale, future and invalid locations are omitted', () => {
  for (const pollutant_avg of [
    '',
    'NA',
    null,
    undefined,
    ' ',
    -1,
    Infinity,
    true,
  ])
    assert.deepEqual(readingsOf([row({ pollutant_avg })]), []);
  assert.equal(readingsOf([row({ pollutant_avg: '0' })])[0].value, 0);
  for (const patch of [
    { latitude: null },
    { longitude: 190 },
    { latitude: '' },
    { last_update: '17-10-2026 12:00:00' },
    { last_update: '19-10-2026 12:00:00' },
  ])
    assert.deepEqual(readingsOf([row(patch)]), []);
});

test('one reading per station and pollutant, newest wins; reported averages are not labeled AQI', () => {
  const rows = readingsOf([
    row({ last_update: '18-10-2026 11:00:00' }),
    row({ pollutant_avg: 150 }),
    row({ pollutant_id: 'CO', pollutant_avg: '1.2' }),
  ]);
  assert.deepEqual(
    rows.map((reading) => [reading.parameter, reading.value]),
    [
      ['CO', 1.2],
      ['PM2.5', 150],
    ],
  );
  for (const reading of rows) {
    assert.equal(reading.provider, 'cpcb');
    assert.equal(reading.scale, reading.parameter);
    assert.equal('risk' in reading, false);
    assert.equal(reading.band, null);
  }
  assert.equal(readingsOf([row(), row({ state: 'Other' })]).length, 2);
  assert.equal(normalizeCpcbRecords({ error: 'denied' }), null);
});

test("OZONE is the layer's O3; pollutants without a view are left out", () => {
  assert.deepEqual([...CPCB_POLLUTANTS].sort(), [
    'CO',
    'NO2',
    'O3',
    'PM10',
    'PM2.5',
    'SO2',
  ]);
  assert.deepEqual(
    readingsOf([
      row({ pollutant_id: 'OZONE' }),
      row({ pollutant_id: 'NH3' }),
      row({ pollutant_id: 'Unknown' }),
    ]).map((reading) => reading.parameter),
    ['O3'],
  );
});

test('the station catalog keeps stations whose readings are all out of date', () => {
  const { stations, readings } = normalize([
    row(),
    row({ station: 'Silent station', last_update: '17-10-2026 12:00:00' }),
  ]);
  assert.equal(readings.length, 1);
  assert.deepEqual(
    stations.map((station) => station.name),
    ['Silent station', 'Test station'],
  );
});

test('current OGD avg_value schema is accepted alongside legacy pollutant_avg', () => {
  const liveShape = row({ avg_value: '42', min_value: '7', max_value: '80' });
  delete liveShape.pollutant_avg;
  assert.equal(readingsOf([liveShape])[0].value, 42);
  assert.equal(
    readingsOf([row({ avg_value: '42', pollutant_avg: '99' })])[0].value,
    42,
  );
  assert.deepEqual(
    readingsOf([row({ avg_value: 'NA', pollutant_avg: '99' })]),
    [],
  );
});

test('India readings are unrated and keep the reported value', () => {
  const [reading] = readingsOf([row()]);
  assert.equal(reading.units, null);
  assert.equal(reading.averagingMinutes, undefined);
  assert.equal(reading.rated, false);
  assert.equal(reading.aqi, null);
  assert.equal(reading.color, '#8cb4ce');
  assert.equal(reading.label, '123');
});

// ── India in the layer, through the default providers ─────────────────────

/** An OGD `last_update` stamp (IST wall time) for an instant. */
const istStamp = (ms) => {
  const ist = new Date(ms + 330 * 60_000).toISOString();
  return `${ist.slice(8, 10)}-${ist.slice(5, 7)}-${ist.slice(0, 4)} ${ist.slice(11, 19)}`;
};
const recent = () => istStamp(Date.now() - 10 * 60_000);
const snapshot = (body = {}) => ({
  schemaVersion: 1,
  stations: [],
  readings: [],
  ...body,
});
/** What the local India route answers for these OGD rows. */
const indiaSnapshot = (records) =>
  snapshot(normalizeCpcbRecords({ records }, { now: Date.now() }));
const openAqCopy = (lat, lon) => ({
  id: 'openaq:9:PM2.5',
  provider: 'openaq',
  stationId: '9',
  name: 'OpenAQ copy',
  zone: 'India',
  country: 'IN',
  lat,
  lon,
  parameter: 'PM2.5',
  scale: 'PM2.5',
  units: 'µg/m³',
  value: 120,
  averagingMinutes: 60,
  observedMs: Date.now() - 5 * 60_000,
  kind: 'observation',
  label: '120.00 µg/m³',
});

function indiaLayer(routes) {
  const requests = [];
  const source = createAirQualitySource({
    fetchImpl: async (url) => {
      requests.push(String(url));
      const answer = routes[String(url).split('?')[0]];
      if (!answer) throw new Error(`unexpected request ${url}`);
      return typeof answer === 'function' ? answer() : Response.json(answer);
    },
  });
  const viewer = {};
  const { draw } = bindFakeDraw(viewer, {
    camera: {
      on: () => () => {},
      viewRectangle: () => ({ west: 76, south: 28, east: 78, north: 29 }),
    },
  });
  const layer = createAirQualityLayer({
    source,
    overlayHost: { setEntries() {}, clearSource() {}, setVisible() {} },
  });
  layer.init(viewer);
  layer.enable();
  const points = () =>
    [...draw.sets.values()].find(
      (set) => set.kind === 'points' && !set.disposed,
    );
  return { layer, points, requests };
}

test('India readings are drawn as one more observation provider', async () => {
  const { layer, points, requests } = indiaLayer({
    '/api/air-quality/india': indiaSnapshot([row({ last_update: recent() })]),
    // An aggregator's copy of the same station, 50 m away.
    '/api/air-quality/openaq': snapshot({
      readings: [openAqCopy(28.6 + 50 / 111_320, 77.2)],
    }),
  });
  assert.equal(await layer.update(), true);
  await airQualitySettled(layer);
  assert.ok(requests.includes('/api/air-quality/india'));
  assert.ok(requests.some((url) => url.startsWith('/api/air-quality/openaq?')));
  const drawn = () =>
    [...points().items.values()].map((point) => point.meta.provider);
  // India is unrated and OpenAQ's copy has a computed US AQI: the rated
  // copy wins, in the AQI view as in a pollutant view.
  assert.deepEqual(drawn(), ['openaq']);
  const india = layer.getProviderStates().find((state) => state.id === 'cpcb');
  assert.equal(india.status, 'ok');
  assert.equal(india.requiresKeyId, 'data-gov-in');
  // In PM2.5 OpenAQ's copy is rated and India's is not: the rated copy wins.
  layer.setParams({ view: 'PM2.5' });
  await layer.update();
  await airQualitySettled(layer);
  assert.deepEqual(drawn(), ['openaq']);
  layer.destroy();
});

test('unverified India readings are unrated and leave the AQI alone', async () => {
  const { layer, points } = indiaLayer({
    '/api/air-quality/india': indiaSnapshot([row({ last_update: recent() })]),
    '/api/air-quality/openaq': snapshot(),
  });
  assert.equal(layer.getParams().view, 'aqi');
  await layer.update();
  for (const view of ['aqi', 'PM2.5']) {
    if (view !== 'aqi') {
      layer.setParams({ view });
      await layer.update();
    }
    const [station] = [...points().items.values()];
    assert.equal(station.meta.provider, 'cpcb', view);
    assert.equal(station.color, '#8cb4ce', view);
    assert.equal(station.meta.aqi, null, view);
    assert.equal(station.meta.rated, false, view);
    assert.equal(station.meta.assessment?.label, undefined, view);
  }
  assert.match(
    [...points().items.values()][0].meta.assessment.reason,
    /units or averaging period .* not confirmed/,
  );
  layer.destroy();
});

test('a rejected data.gov.in key is reported as a key problem', async () => {
  const { layer } = indiaLayer({
    '/api/air-quality/india': () =>
      Response.json({ error: 'key_rejected' }, { status: 403 }),
    '/api/air-quality/openaq': snapshot(),
  });
  await layer.update();
  const india = layer.getProviderStates().find((state) => state.id === 'cpcb');
  assert.equal(india.status, 'failed');
  assert.match(india.error, /Provider key rejected/);
  layer.destroy();
});

test('without a data.gov.in key India asks for it and the others still draw', async () => {
  const { layer, points } = indiaLayer({
    '/api/air-quality/india': () =>
      Response.json({ error: 'no_key' }, { status: 428 }),
    '/api/air-quality/openaq': snapshot({
      readings: [openAqCopy(28.6, 77.2)],
    }),
  });
  assert.equal(await layer.update(), true);
  const india = layer.getProviderStates().find((state) => state.id === 'cpcb');
  assert.equal(india.status, 'no-key');
  assert.match(india.error, /DATA_GOV_IN_API_KEY/);
  assert.match(india.error, /Provider Settings/);
  assert.equal(layer.getStats().error, null);
  assert.deepEqual(
    [...points().items.values()].map((point) => point.meta.provider),
    ['openaq'],
  );
  layer.destroy();
});

test('the India source asks the local route and keeps its stale status', async () => {
  const urls = [];
  const source = createAirQualitySource({
    fetchImpl: async (url) => {
      urls.push(url);
      return Response.json({
        ...indiaSnapshot([
          row({ last_update: recent() }),
          row({
            pollutant_id: 'NO2',
            pollutant_avg: '40',
            last_update: recent(),
          }),
        ]),
        stale: true,
      });
    },
  });
  const readings = await source.getSnapshot({
    provider: 'cpcb',
    parameter: 'NO2',
  });
  assert.deepEqual(urls, ['/api/air-quality/india']);
  assert.deepEqual(
    readings.map((reading) => [reading.parameter, reading.value]),
    [['NO2', 40]],
  );
  assert.equal(source.getCoverage('cpcb').stale, true);
});

test('a stale India snapshot is asked again on the next refresh; a fresh one is reused', async () => {
  let clock = Date.now(),
    stale = true;
  const urls = [];
  const source = createAirQualitySource({
    now: () => clock,
    fetchImpl: async (url) => {
      urls.push(url);
      return Response.json({
        ...indiaSnapshot([row({ last_update: recent() })]),
        stale,
      });
    },
  });
  const ask = () =>
    source.getSnapshot({ provider: 'cpcb', parameter: 'PM2.5' });
  await ask();
  assert.equal(source.getCoverage('cpcb').stale, true);
  // The route has recovered by the next layer refresh.
  stale = false;
  clock += 60_000;
  await ask();
  assert.equal(urls.length, 2);
  assert.equal(source.getCoverage('cpcb').stale, false);
  clock += 60_000;
  await ask();
  assert.equal(urls.length, 2, 'a fresh national snapshot is reused');
});

test('an already aborted India request does not fetch', async () => {
  const source = createAirQualitySource({
    fetchImpl: () => assert.fail('unexpected fetch'),
  });
  await assert.rejects(
    source.getSnapshot({ provider: 'cpcb', signal: AbortSignal.abort() }),
    { name: 'AbortError' },
  );
});

/**
 * Default provider definitions with a hand-driven snapshot per provider:
 * rows, `'hold'`, or a function of the request returning either.
 */
/** A network publishing its own monitors, beside the default providers. */
const NATIONAL = {
  id: 'national',
  title: 'National',
  label: 'Air quality · National',
  network: 'NATIONAL',
  direct: true,
  parameters: ['PM2.5', 'PM10', 'NO2', 'O3', 'SO2', 'CO'],
};

function heldLayer(answers) {
  const pending = new Map();
  const source = {
    definitions: [NATIONAL, ...createAirQualitySource().definitions],
    getSnapshot: (request) => {
      const { provider } = request;
      const answer =
        typeof answers[provider] === 'function'
          ? answers[provider](request)
          : answers[provider];
      return answer === 'hold'
        ? new Promise((resolve) => pending.set(provider, resolve))
        : Promise.resolve(answer ?? []);
    },
  };
  const layer = createAirQualityLayer({
    source,
    overlayHost: { setEntries() {}, clearSource() {}, setVisible() {} },
  });
  const viewer = {};
  bindFakeDraw(viewer);
  layer.init(viewer);
  return { layer, release: (provider, rows) => pending.get(provider)(rows) };
}

/**
 * Default provider definitions; every India request is held until released,
 * and the stub ignores the abort signal, as a slow network answer would.
 */
function queuedLayer() {
  const india = [];
  const source = {
    definitions: createAirQualitySource().definitions,
    getSnapshot: ({ provider }) =>
      provider === 'cpcb'
        ? new Promise((resolve) => india.push(resolve))
        : Promise.resolve([]),
  };
  const layer = createAirQualityLayer({
    source,
    overlayHost: { setEntries() {}, clearSource() {}, setVisible() {} },
  });
  const viewer = {};
  const { draw } = bindFakeDraw(viewer);
  layer.init(viewer);
  const drawnIds = () => {
    const set = [...draw.sets.values()].find(
      (candidate) => candidate.kind === 'points' && !candidate.disposed,
    );
    return [...(set?.items.values() ?? [])].map((point) => point.meta.id);
  };
  return { layer, india, drawnIds };
}
const indiaStation = (station) =>
  normalizeCpcbRecords(
    { records: [row({ station, last_update: recent() })] },
    { now: Date.now() },
  ).readings;
const indiaRows = () =>
  normalizeCpcbRecords(
    { records: [row({ last_update: recent() })] },
    { now: Date.now() },
  ).readings;
/** A national network's station PM2.5, rated. */
const nationalRows = () => [
  {
    ...indiaRows()[0],
    id: 'national:test-station:PM2.5',
    provider: 'national',
    rated: undefined,
  },
];
/** PM2.5 rows in the PM2.5 view, nothing in the others. */
const pm25Only = (rows) => (request) =>
  request.parameter === 'PM2.5' ? rows : [];

test('switching view clears old markers and a late answer for the old view cannot replace India', async () => {
  const { layer, release } = heldLayer({
    national: (request) => (request.mode === 'aqi' ? 'hold' : []),
    cpcb: pm25Only(indiaRows()),
  });
  layer.enable();
  const pending = layer.update();
  layer.setParams({ view: 'PM2.5' });
  await layer.update();
  release('national', nationalRows());
  await pending;
  assert.deepEqual(
    layer.getAnalystRecords().map((record) => record.provider),
    ['cpcb'],
  );
  assert.equal(layer.getStats().count, 1);
  assert.equal(layer.getParams().view, 'PM2.5');
  layer.destroy();
});

test('a late India response after the view changes is dropped', async () => {
  const { layer, release } = heldLayer({
    cpcb: (request) => (request.parameter === 'PM2.5' ? 'hold' : []),
    national: (request) => (request.mode === 'aqi' ? nationalRows() : []),
  });
  layer.setParams({ view: 'PM2.5' });
  layer.enable();
  const pendingIndia = layer.update();
  layer.setParams({ view: 'aqi' });
  assert.equal(await layer.update(), true);
  release('cpcb', indiaRows());
  await pendingIndia;
  assert.equal(layer.getParams().view, 'aqi');
  assert.equal(layer.getStats().count, 1);
  assert.deepEqual(
    layer.getAnalystRecords().map((record) => record.provider),
    ['national'],
  );
  assert.equal(layer.getRowControls().legend.length, 6);
  layer.destroy();
});

test('in one view, a superseded India answer never replaces the newer one', async () => {
  const { layer, india, drawnIds } = queuedLayer();
  layer.setParams({ view: 'PM2.5' });
  layer.enable();
  const first = layer.update();
  const second = layer.update();
  assert.equal(india.length, 2);
  india[1](indiaStation('Newer station'));
  await second;
  const newer = drawnIds();
  assert.equal(newer.length, 1);
  assert.match(newer[0], /Newer station/);
  india[0](indiaStation('Older station'));
  await first;
  assert.deepEqual(drawnIds(), newer);
  assert.equal(layer.getStats().count, 1);
  layer.destroy();
});

test('an India answer that lands after the layer is switched off draws nothing', async () => {
  const { layer, india, drawnIds } = queuedLayer();
  layer.setParams({ view: 'PM2.5' });
  layer.enable();
  const pending = layer.update();
  layer.disable();
  india[0](indiaStation('Late station'));
  await pending;
  assert.deepEqual(drawnIds(), []);
  assert.equal(layer.getStats().count, 0);
  layer.destroy();
});
