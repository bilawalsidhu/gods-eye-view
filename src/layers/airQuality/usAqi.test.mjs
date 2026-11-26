import test from 'node:test';
import assert from 'node:assert/strict';
import {
  US_AQI_BANDS,
  US_AQI_LIMITS,
  aqiStations,
  plausibility,
  stationIndex,
  usAqi,
  usAqiBand,
} from './usAqi.js';
import { concentrationFactor, concentrationIn } from './units.js';
import { interpretHourly } from './interpretation.js';
import {
  createAirQualitySnapshotSource,
  createAirQualitySource,
  createDefaultAirQualityProviders,
} from './providers.js';
import { createAirQualityLayer } from './index.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { onAqiPeriods } from '../../testSupport/airQualityViewer.mjs';

test('breakpoints match the EPA table', () => {
  assert.equal(usAqi({ pm25: 9.0 }).index, 50);
  assert.equal(usAqi({ pm25: 35.4 }).index, 100);
  // The next row starts at 35.5 µg/m³ = 101 (EPA Table 6, Equation 1).
  assert.equal(usAqi({ pm25: 35.5 }).index, 101);
  assert.equal(usAqi({ o3: 70 * 1.963 }).index, 100);
  assert.equal(usAqi({ co: 9.4 * 1.1456 }).index, 100);
  assert.equal(usAqi({ no2: 100 * 1.882 }).index, 100);
  assert.equal(usAqi({ so2: 75 * 2.62 }).index, 100);
  assert.equal(usAqi({ pm10: 154 }).index, 100);
  assert.equal(usAqi({ pm10: 155 }).index, 101);
  assert.equal(usAqi({ pm25: 0 }).index, 0);
});

test('concentrations are truncated before the table, as the EPA example', () => {
  // EPA: an 8-hour O3 value of 0.07853333 ppm truncates to 0.078 and gives 126.
  assert.equal(usAqi({ o3: 78.53333 * 1.963 }).index, 126);
  // EPA: O3 0.078 ppm, PM2.5 35.9 µg/m³ and CO 8.4 ppm give 126, O3 leading.
  assert.deepEqual(usAqi({ o3: 78 * 1.963, pm25: 35.9, co: 8.4 * 1.1456 }), {
    index: 126,
    leading: 'o3',
  });
  assert.equal(usAqi({ pm25: 35.49 }).index, 100);
});

test('the highest sub-index wins and names its pollutant', () => {
  assert.equal(usAqi({ pm25: 5, o3: 160 }).leading, 'o3');
  assert.equal(usAqi({ pm25: 60, o3: 20 }).leading, 'pm25');
});

test('above the table the index runs on past 500 in the hazardous row (EPA)', () => {
  // EPA: values above 500 use Equation 1 with the concentration for 500.
  assert.equal(usAqi({ pm25: 325.4 }).index, 500);
  assert.equal(usAqi({ pm25: 425.3 }).index, 699);
  assert.equal(usAqi({ pm10: 604 }).index, 500);
  assert.equal(usAqiBand(699).id, 'hazardous');
});

test('ozone rates its 8-hour value, and its 1-hour mean only where the 1-hour rows apply (EPA)', () => {
  const o3 = (eightHour, hour) =>
    usAqi(
      { o3: eightHour * 1.963 },
      hour === undefined ? {} : { hourValues: { o3: hour * 1.963 } },
    );
  // EPA: a 1-hour value of 0.162 ppm and an 8-hour value of 0.078 ppm are
  // both rated and the higher kept, ozone leading. The document prints 148
  // for the 1-hour part, but its own Equation 1 gives
  // 49 / 0.039 × 0.037 + 101 = 147.49, which rounds to 147.
  assert.deepEqual(o3(78, 162), { index: 147, leading: 'o3' });
  assert.equal(o3(78).index, 126);
  // EPA: a 1-hour value of 0.104 ppm is below the 1-hour rows: 126.
  assert.equal(o3(78, 104).index, 126);
  // One value is not put through both tables: 0.162 ppm as an 8-hour value
  // alone is 260 on the 8-hour rows.
  assert.equal(o3(162).index, 260);
  // The 8-hour rows end at 0.200 ppm (300); above, only the 1-hour rows
  // define the index (note 2), and without one it holds at 300.
  assert.equal(o3(200).index, 300);
  assert.equal(o3(300).index, 300);
  assert.equal(o3(210, 405).index, 301);
  assert.equal(o3(210, 604).index, 500);
  assert.equal(usAqiBand(o3(210, 604).index).id, 'hazardous');
  // The index never falls as the 1-hour mean rises.
  let previous = -Infinity;
  for (let ppb = 100; ppb <= 700; ppb++) {
    const index = o3(78, ppb).index;
    assert.ok(index >= previous, `${ppb} ppb: ${index} < ${previous}`);
    previous = index;
  }
});

test('SO2 rates 1-hour values to 304 ppb, and above them a 24-hour average (EPA)', () => {
  const so2 = (hour, day) =>
    usAqi(
      { so2: hour * 2.62 },
      day === undefined ? {} : { dayValues: { so2: day * 2.62 } },
    ).index;
  assert.equal(so2(304), 200);
  // A 1-hour value of 305 ppb or more without a 24-hour average of 305 ppb
  // or more is fixed at 200 exactly.
  assert.equal(so2(305), 200);
  assert.equal(so2(900), 200);
  assert.equal(so2(900, 200), 200);
  // With one, the 24-hour rows rate: 305 ppb is 201, 1004 ppb 500.
  assert.equal(so2(900, 305), 201);
  assert.equal(so2(1200, 1004), 500);
  // A 1-hour value below 305 ppb uses the 1-hour rows.
  assert.equal(so2(75), 100);
});

test('no rated value gives null', () => {
  assert.equal(usAqi({}), null);
  assert.equal(usAqi({ pm25: NaN, pm10: -1, co2: 420 }), null);
  assert.equal(usAqi(null), null);
});

test('plausible drops PM2.5 well above PM10', () => {
  assert.deepEqual(plausibility({ pm25: 308, pm10: 92 }).kept, { pm10: 92 });
  assert.deepEqual(plausibility({ pm25: 40, pm10: 92 }).kept, {
    pm25: 40,
    pm10: 92,
  });
});

test('a lone outlier does not reach 500', () => {
  assert.deepEqual(plausibility({ co: 150 }).kept, { co: 150 });
  assert.deepEqual(plausibility({ pm10: 20_001 }).kept, {});
  assert.equal(usAqi(plausibility({ pm10: 20_001 }).kept), null);
  assert.deepEqual(
    plausibility({
      pm25: 3001,
      o3: 2401,
      no2: 8001,
      so2: 6001,
      co: 201,
    }).kept,
    {},
  );
  assert.deepEqual(plausibility({ pm25: 3000, co: 100 }).kept, {
    pm25: 3000,
    co: 100,
  });
});

test('a hazardous reading up to twice its table top is kept and runs past 500', () => {
  // Table 6, note 4: the concentration each table puts at 500, in the
  // layer's units (gases at 25 °C).
  const tops = {
    o3: 0.604 * 1000 * 1.963,
    pm25: 325.4,
    pm10: 604,
    co: 50.4 * 1.1456,
    so2: 1004 * 2.62,
    no2: 2049 * 1.882,
  };
  for (const [key, top] of Object.entries(tops)) {
    assert.deepEqual(plausibility({ [key]: 2 * top }).kept, {
      [key]: 2 * top,
    });
    // A 1-hour SO2 value stops at 200 and an 8-hour ozone one at 300: past
    // them a 24-hour SO2 average and a 1-hour ozone mean rate.
    const extra = {
      hourValues: { o3: top * 1.01 },
      dayValues: { so2: top * 1.01 },
    };
    assert.ok(usAqi({ [key]: top * 1.01 }, extra).index > 500, key);
  }
  // NO2 at 2,000 ppb (3,764 µg/m³) is hazardous, not a fault.
  assert.equal(usAqi(plausibility({ no2: 3764 }).kept).index, 488);
});

test('a low-cost sensor gets no US AQI; its values say why', () => {
  const station = {
    values: { pm25: 60, no2: 20 },
    valueTimes: { pm25: 1000, no2: 2000 },
    excluded: { o3: 'flagged' },
  };
  assert.equal(stationIndex(station).aqi.index, 154);
  // Unmarked stations count as monitors; only `monitor: false` is a sensor.
  assert.equal(stationIndex({ ...station, monitor: true }).aqi.index, 154);
  assert.deepEqual(stationIndex({ ...station, monitor: false }), {
    aqi: null,
    used: {},
    excluded: { o3: 'flagged', pm25: 'sensor', no2: 'sensor' },
    observedMs: 2000,
  });
});

test('the bands are the EPA categories and colours', () => {
  assert.deepEqual(US_AQI_LIMITS, [50, 100, 150, 200, 300]);
  assert.deepEqual(
    US_AQI_BANDS.map((band) => band.color),
    ['#00e400', '#ffff00', '#ff7e00', '#ff0000', '#8f3f97', '#7e0023'],
  );
  assert.equal(US_AQI_BANDS[2].short, 'Sensitive groups');
  assert.equal(usAqiBand(50).id, 'good');
  assert.equal(usAqiBand(51).id, 'moderate');
  assert.equal(usAqiBand(301).id, 'hazardous');
  assert.equal(usAqiBand(null), null);
});

test('concentrations convert to the layer units at 25 °C', () => {
  assert.equal(concentrationIn('NO2', 10, 'µg/m³'), 10);
  assert.equal(concentrationIn('NO2', 10, 'ppb'), 18.82);
  assert.equal(concentrationIn('CO', 2, 'ppm'), 2 * 1.1456);
  assert.equal(concentrationIn('CO', 500, 'µg/m³'), 0.5);
  assert.ok(Math.abs(concentrationIn('O3', 0.05, 'ppm') - 50 * 1.963) < 1e-9);
  assert.equal(concentrationFactor('SO2', 'μg/m³'), 1);
  assert.equal(concentrationFactor('PM10', 'mg/m3'), 1000);
  assert.equal(concentrationIn('PM2.5', 7, 'ug/m3'), 7);
  assert.equal(concentrationIn('PM2.5', 7, 'ppm'), null);
  assert.equal(concentrationIn('PM2.5', 7, null), null);
  assert.equal(concentrationIn('CO2', 420, 'ppm'), null);
  assert.equal(concentrationIn('PM10', -1, 'µg/m³'), null);
});

test('one unit conversion serves the EEA comparison: 10 ppb of NO2 is rated', () => {
  const rated = interpretHourly({
    parameter: 'NO2',
    value: 10,
    units: 'ppb',
    averagingMinutes: 60,
  });
  assert.equal(rated.assessment.concentration, 18.82);
  assert.equal(rated.assessment.units, 'µg/m³');
  assert.equal(rated.assessment.label, 'Fair');
  // Particles have no gas factor: a mixing ratio stays unrated.
  const particles = interpretHourly({
    parameter: 'PM2.5',
    value: 10,
    units: 'ppb',
    averagingMinutes: 60,
  });
  assert.match(particles.assessment.reason, /units cannot be compared/);
});

test('plausibility names why each value is left out', () => {
  assert.deepEqual(plausibility({ pm25: 308, pm10: 92, no2: 8100 }), {
    kept: { pm10: 92 },
    excluded: { pm25: 'above-pm10', no2: 'implausible' },
  });
});

test("a station's time is its leading value's, and discarded values do not count", () => {
  const t0 = Date.parse('2026-11-23T08:00:00Z');
  const row = (parameter, value, units, observedMs) => ({
    id: `x:1:${parameter}`,
    provider: 'x',
    stationId: '1',
    name: 'Probe',
    lat: 1,
    lon: 2,
    parameter,
    units,
    value,
    averagingMinutes: 60,
    observedMs,
  });
  // PM2.5 at t0, NO2 at +5e6 ms, O3 in units that do not convert at +9e6 ms.
  const [probe] = aqiStations(
    onAqiPeriods([
      row('PM2.5', 40, 'µg/m³', t0),
      row('NO2', 10, 'µg/m³', t0 + 5e6),
      row('O3', 30, 'furlongs', t0 + 9e6),
    ]),
  );
  assert.equal(probe.observedMs, t0 + 5e6, 'the newest value kept');
  assert.deepEqual(probe.excluded, { o3: 'units' });
  const result = stationIndex(probe);
  assert.deepEqual(result.aqi, { index: 112, leading: 'pm25' });
  assert.equal(result.observedMs, t0, 'the leading pollutant');
  assert.deepEqual(result.excluded, { o3: 'units' });
  // A stalled PM2.5 four hours behind NO2 is dropped; NO2 leads.
  const [stalled] = aqiStations(
    onAqiPeriods([
      row('PM2.5', 100, 'µg/m³', t0),
      row('NO2', 50, 'µg/m³', t0 + 4 * 3600_000),
    ]),
  );
  const fresh = stationIndex(stalled);
  assert.deepEqual(fresh.aqi, { index: 25, leading: 'no2' });
  assert.deepEqual(fresh.used, { no2: 50 });
  assert.deepEqual(fresh.excluded, { pm25: 'too-old' });
  assert.equal(fresh.observedMs, t0 + 4 * 3600_000);
});

test('per-pollutant readings become one station with every pollutant', () => {
  const row = (parameter, value, units, extra = {}) => ({
    id: `x:1:${parameter}`,
    provider: 'x',
    stationId: '1',
    name: 'One',
    lat: 1,
    lon: 2,
    parameter,
    scale: parameter,
    units,
    value,
    averagingMinutes: 60,
    observedMs: 1000,
    kind: 'observation',
    label: `${value} ${units}`,
    ...extra,
  });
  const [station, ...rest] = aqiStations([
    // Three hourly means of PM2.5: its NowCast is 12.
    row('PM2.5', 12, 'µg/m³', { observedMs: 1000 - 7_200_000 }),
    row('PM2.5', 12, 'µg/m³', { observedMs: 1000 - 3_600_000 }),
    row('PM2.5', 12, 'µg/m³'),
    row('NO2', 10, 'ppb', { observedMs: 2000 }),
    row('CO2', 420, 'ppm'),
    row('SO2', 3, 'µg/m³', { qualityFlagged: true }),
    { ...row('PM10', 20, 'µg/m³'), stationId: '2', id: 'x:2:PM10' },
    { ...row('CO2', 420, 'ppm'), stationId: '3', id: 'x:3:CO2' },
  ]);
  assert.equal(rest.length, 1, 'a station with no AQI pollutant is left out');
  assert.equal(station.id, 'x:1:aqi');
  assert.equal(station.name, 'One');
  assert.equal(station.scale, 'US AQI');
  assert.equal(station.kind, 'observation');
  assert.deepEqual(station.values, { pm25: 12, no2: 18.82 });
  assert.deepEqual(station.valueTimes, { pm25: 1000, no2: 2000 });
  assert.deepEqual(station.excluded, { so2: 'flagged' });
  assert.equal(station.observedMs, 2000);
  assert.deepEqual(station.valueMethods, { pm25: 'nowcast' });
  assert.deepEqual(station.valueAveraging, { pm25: null, no2: 60 });
  assert.deepEqual(station.hourValues, { pm25: 12, no2: 18.82 });
  assert.equal(station.averagingMinutes, null);
  assert.equal(station.aqi, null);
  assert.equal(station.units, undefined);
  assert.equal(rest[0].id, 'x:2:aqi');
  // Readings that already carry values pass through unchanged.
  const ready = { id: 'y:1:aqi', values: { pm25: 3 } };
  assert.equal(aqiStations([ready])[0], ready);
});

test('the newest reading decides a pollutant, in any order', () => {
  const row = (value, observedMs, extra = {}) => ({
    id: 'x:1:PM2.5',
    provider: 'x',
    stationId: '1',
    parameter: 'PM2.5',
    units: 'µg/m³',
    value,
    averagingMinutes: 1440,
    observedMs,
    ...extra,
  });
  const older = row(12, 1000);
  const flagged = row(80, 2000, { qualityFlagged: true });
  const unconvertible = row(80, 2000, { units: 'ppb' });
  for (const newest of [flagged, unconvertible])
    for (const rows of [
      [older, newest],
      [newest, older],
    ]) {
      // A newer flagged or unconvertible reading leaves the pollutant out:
      // the older value does not stand in while it is reported excluded.
      const [station] = aqiStations(rows);
      assert.deepEqual(station.values, {});
      assert.deepEqual(station.excluded, {
        pm25: newest === flagged ? 'flagged' : 'units',
      });
      assert.equal(station.observedMs, 2000);
    }
  // A newer usable value wins over an older flagged one, in any order.
  for (const rows of [
    [row(80, 1000, { qualityFlagged: true }), row(12, 2000)],
    [row(12, 2000), row(80, 1000, { qualityFlagged: true })],
  ]) {
    const [station] = aqiStations(rows);
    assert.deepEqual(station.values, { pm25: 12 });
    assert.deepEqual(station.excluded, {});
  }
  // At the same time a usable value wins, then the higher one.
  for (const rows of [
    [row(12, 2000), row(30, 2000), flagged],
    [flagged, row(30, 2000), row(12, 2000)],
  ])
    assert.deepEqual(aqiStations(rows)[0].values, { pm25: 30 });
});

test('a station whose only reading its source flagged keeps no values', () => {
  const [station] = aqiStations([
    {
      id: 'national:1:PM2.5',
      provider: 'national',
      stationId: '1',
      parameter: 'PM2.5',
      value: 123,
      units: 'µg/m³',
      qualityFlagged: true,
      averagingMinutes: 1440,
      aqi: null,
      observedMs: 1000,
    },
  ]);
  assert.deepEqual(station.values, {});
  assert.deepEqual(station.excluded, { pm25: 'flagged' });
  assert.equal(station.aqi, null);
  assert.equal(station.observedMs, 1000);
});

// ── The AQI and pollutant views in the layer ───────────────────────────────

const minutesAgo = (minutes) => Date.now() - minutes * 60_000;
const snapshotOf = (readings = []) => ({
  schemaVersion: 1,
  stations: [],
  readings,
});
const site = (provider, stationId, lat, extra = {}) => ({
  id: `${provider}:${stationId}:PM2.5`,
  provider,
  stationId,
  name: `${provider} ${stationId}`,
  zone: 'Zone',
  country: 'ZA',
  lat,
  lon: 28,
  parameter: 'PM2.5',
  scale: 'PM2.5',
  units: 'µg/m³',
  value: 10,
  averagingMinutes: 60,
  observedMs: minutesAgo(5),
  kind: 'observation',
  color: '#8cb4ce',
  label: '10.00 µg/m³',
  ...extra,
});

/**
 * A network publishing its own monitors, read as one national snapshot from
 * `/api/air-quality/<id>`: a fixture beside the default providers.
 */
const nationalProvider = (fetchImpl, id = 'national') => ({
  id,
  title: id,
  label: `Air quality · ${id}`,
  network: id.toUpperCase(),
  direct: true,
  parameters: ['PM2.5', 'PM10', 'NO2', 'O3', 'SO2', 'CO'],
  source: createAirQualitySnapshotSource({
    endpoint: `/api/air-quality/${id}`,
    keyed: false,
    hourly: true,
    reuseMs: 60_000,
    fetchImpl,
  }),
});

function stationLayer(routes) {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(String(url));
    const answer = routes[String(url).split('?')[0]];
    if (!answer) throw new Error(`unexpected request ${url}`);
    return Response.json(
      typeof answer === 'function' ? answer(String(url)) : answer,
    );
  };
  const source = createAirQualitySource({
    providers: [
      nationalProvider(fetchImpl),
      nationalProvider(fetchImpl, 'regional'),
      ...createDefaultAirQualityProviders({ fetchImpl }),
    ],
  });
  const viewer = {};
  const { draw } = bindFakeDraw(viewer, {
    camera: {
      on: () => () => {},
      viewRectangle: () => ({ west: 27, south: -27, east: 29, north: -25 }),
    },
  });
  const layer = createAirQualityLayer({
    source,
    overlayHost: { setEntries() {}, clearSource() {}, setVisible() {} },
  });
  layer.init(viewer);
  layer.enable();
  const drawn = () => {
    const points = [...draw.sets.values()].find(
      (set) => set.kind === 'points' && !set.disposed,
    );
    return new Map(
      [...points.items.values()].map((point) => [point.meta.provider, point]),
    );
  };
  return { layer, drawn, requests };
}

const modeOf = (url) => new URL(url, 'http://local').searchParams;

test('the AQI view colours, ranks and lists stations on the US AQI', async () => {
  const { layer, drawn, requests } = stationLayer({
    // One OpenAQ station with every pollutant: PM2.5 60 µg/m³ gives 154.
    '/api/air-quality/openaq': (url) =>
      snapshotOf(
        modeOf(url).get('mode') === 'aqi'
          ? [
              {
                ...site('openaq', '1', -26),
                id: 'openaq:1:aqi',
                parameter: 'aqi',
                scale: 'US AQI',
                values: { pm25: 60, no2: 20 },
              },
            ]
          : [],
      ),
    // The national network keeps one row per pollutant: PM2.5 5 µg/m³ and NO2 10 ppb. A
    // network's own index, if a row carried one, is not used or shown.
    '/api/air-quality/national': snapshotOf(
      onAqiPeriods([
        site('national', '2', -25.5, {
          value: 5,
          rating: { score: 4, label: 'Moderate', method: 'NATIONAL index' },
        }),
        site('national', '2', -25.5, {
          id: 'national:2:NO2',
          parameter: 'NO2',
          units: 'ppb',
          value: 10,
        }),
      ]),
    ),
    // A station whose only value its source flagged: no index.
    '/api/air-quality/regional': snapshotOf([
      site('regional', '3', -26.5, {
        value: 300,
        qualityFlagged: true,
        observedMs: minutesAgo(10),
      }),
    ]),
  });
  assert.equal(layer.getParams().view, 'aqi');
  assert.equal(await layer.update(), true);
  const openAq = requests.find((url) => url.includes('/openaq?'));
  assert.equal(modeOf(openAq).get('mode'), 'aqi');
  assert.equal(modeOf(openAq).get('parameter'), null);
  const points = drawn();
  assert.equal(points.get('openaq').meta.aqi.index, 154);
  assert.equal(points.get('openaq').meta.aqi.leading, 'pm25');
  assert.equal(points.get('openaq').color, '#ff0000');
  // The national network: PM2.5 5 gives 28, NO2 10 ppb gives 9; one station from two rows.
  assert.equal(points.get('national').meta.aqi.index, 28);
  assert.equal(points.get('national').color, '#00e400');
  // The flagged station stays unrated.
  assert.equal(points.get('regional').meta.aqi, null);
  assert.equal(points.get('regional').color, '#8cb4ce');
  assert.equal(layer.getStats().count, 3);

  const card = layer.getRowControls();
  assert.deepEqual(
    card.legend.map((band) => band.color),
    ['#00e400', '#ffff00', '#ff7e00', '#ff0000', '#8f3f97', '#7e0023'],
  );
  // One ramp, 0 to the open top band.
  assert.equal(card.legend[0].label, '0');
  assert.equal(card.legend[5].label, '300+');
  // Ranked on the index, each row in its category's colour; unrated last.
  assert.deepEqual(
    card.list.items.map((item) => item.swatch),
    ['#ff0000', '#00e400', '#8cb4ce'],
  );
  // Value and name; the details are the row's tooltip.
  assert.equal(card.list.items[0].lead, '154');
  assert.equal(card.list.items[0].text, 'openaq 1');
  assert.match(card.list.items[0].title, /PM2\.5/);
  assert.equal(card.summary.status, '3 stations');
  // The computed US AQI is the one index: no network's own index.
  assert.doesNotMatch(card.list.items[1].title, /NATIONAL index|4\/10/);
  const record = layer
    .getAnalystRecords()
    .find((row) => row.provider === 'openaq');
  assert.equal(record.scale, 'US AQI');
  assert.deepEqual(record.aqi, {
    index: 154,
    category: 'Unhealthy',
    leading: 'pm25',
    values: { pm25: 60, no2: 20 },
  });
  layer.destroy();
});

/** A layer on one injected observation provider answering `rows`. */
function injectedLayer(rows) {
  const definition = nationalProvider();
  const viewer = {};
  const { draw } = bindFakeDraw(viewer, {
    camera: {
      on: () => () => {},
      viewRectangle: () => ({ west: 27, south: -27, east: 29, north: -25 }),
    },
  });
  const layer = createAirQualityLayer({
    source: {
      definitions: [definition],
      getSnapshot: async (request) =>
        request.mode === 'aqi' ? onAqiPeriods(rows) : rows,
    },
    overlayHost: { setEntries() {}, clearSource() {}, setVisible() {} },
  });
  layer.init(viewer);
  layer.enable();
  const point = () =>
    [
      ...[...draw.sets.values()]
        .find((set) => set.kind === 'points' && !set.disposed)
        .items.values(),
    ][0];
  return { layer, point };
}
const row = (parameter, value, extra = {}) =>
  site('national', '2', -25.5, {
    id: `national:2:${parameter}`,
    parameter,
    value,
    ...extra,
  });

test('the AQI view runs its values through plausibility()', async () => {
  // PM2.5 above the same station's PM10: PM10 alone sets the index (69).
  let { layer, point } = injectedLayer([row('PM2.5', 300), row('PM10', 92)]);
  await layer.update();
  assert.deepEqual(point().meta.aqi.index, 69);
  assert.equal(point().meta.aqi.leading, 'pm10');
  assert.match(
    layer.getRowControls().list.items[0].title,
    /Not used: PM2\.5 \(above PM10\)/,
  );
  layer.destroy();
  // A value above its ceiling is left out: PM2.5 10 µg/m³ gives 53.
  ({ layer, point } = injectedLayer([row('PM2.5', 10), row('NO2', 8100)]));
  await layer.update();
  assert.equal(point().meta.aqi.index, 53);
  assert.deepEqual(point().meta.aqiExcluded, { no2: 'implausible' });
  assert.match(
    layer.getRowControls().list.items[0].title,
    /PM2\.5 10 µg\/m³ · Not used: NO2 \(implausible\)/,
  );
  layer.destroy();
});

test('an old leading value dates the station and reads as older', async () => {
  const { layer, point } = injectedLayer([
    row('PM2.5', 100, { observedMs: minutesAgo(150) }),
    row('NO2', 5, { observedMs: minutesAgo(10) }),
    row('O3', 30, { units: 'furlongs', observedMs: minutesAgo(1) }),
  ]);
  await layer.update();
  assert.equal(point().meta.aqi.leading, 'pm25');
  assert.ok(Math.abs(point().meta.observedMs - minutesAgo(150)) < 60_000);
  const [item] = layer.getRowControls().list.items;
  assert.match(item.title, /Older observation/);
  assert.match(item.title, /Not used: O3 \(unrated units\)/);
  layer.destroy();
});

test('a pollutant view rates every network on the EEA hourly bands', async () => {
  const { layer, drawn, requests } = stationLayer({
    '/api/air-quality/openaq': (url) =>
      snapshotOf(
        modeOf(url).get('parameter') === 'PM2.5'
          ? [
              site('openaq', '1', -26, {
                value: 400,
                label: '400.00 µg/m³',
                coveragePercent: 100,
                qualityFlagged: false,
              }),
            ]
          : [],
      ),
    // A row carrying the network's own index ("Moderate", 4/10), which is not
    // shown; NO2 as a mixing ratio.
    '/api/air-quality/national': snapshotOf([
      site('national', '2', -25.5, {
        value: 10,
        rating: { score: 4, label: 'Moderate', method: 'NATIONAL index' },
        color: '#F7FF00',
      }),
      site('national', '2', -25.5, {
        id: 'national:2:NO2',
        parameter: 'NO2',
        units: 'ppb',
        value: 10,
      }),
    ]),
    '/api/air-quality/regional': snapshotOf(),
  });
  layer.setParams({ view: 'PM2.5' });
  await layer.update();
  const points = drawn();
  assert.equal(points.get('national').meta.assessment.label, 'Fair');
  assert.equal(points.get('national').color, '#a3cf62');
  assert.equal(points.get('openaq').meta.assessment.label, 'Extremely poor');
  const card = layer.getRowControls();
  // One scale: the EEA PM2.5 bands as a ramp, nothing from the national network.
  assert.deepEqual(
    card.legend.map((band) => band.color),
    ['#50c9b5', '#a3cf62', '#f2d45c', '#f29457', '#e96070', '#bb6bbd'],
  );
  // The 400 µg/m³ station ranks first; no network's own index is shown.
  assert.deepEqual(
    card.list.items.map((item) => item.swatch),
    ['#bb6bbd', '#a3cf62'],
  );
  assert.doesNotMatch(card.list.items[1].title, /NATIONAL index|4\/10/);
  // 10 ppb of NO2 is 18.82 µg/m³ at 25 °C: "Fair" on the EEA NO2 bands.
  const national = () =>
    requests.filter((url) => url.startsWith('/api/air-quality/national'))
      .length;
  const asked = national();
  layer.setParams({ view: 'NO2' });
  await layer.update();
  const no2 = drawn().get('national').meta;
  assert.equal(no2.assessment.label, 'Fair');
  assert.equal(no2.assessment.concentration, 18.82);
  // The national snapshot serves the next view without asking again.
  assert.equal(national(), asked);
  layer.destroy();
});

test('PM2.5 is dropped only when it exceeds PM10 by a real margin: 1.5 × PM10 + 10', () => {
  // Smoke: PM2.5 close to PM10 stays and sets the index.
  assert.deepEqual(plausibility({ pm25: 150, pm10: 145 }).kept, {
    pm25: 150,
    pm10: 145,
  });
  assert.deepEqual(usAqi(plausibility({ pm25: 150, pm10: 145 }).kept), {
    index: 225,
    leading: 'pm25',
  });
  assert.deepEqual(plausibility({ pm25: 12.3, pm10: 12.0 }).kept, {
    pm25: 12.3,
    pm10: 12.0,
  });
  // A Sirsa-type pair stays excluded.
  assert.deepEqual(plausibility({ pm25: 308, pm10: 92 }), {
    kept: { pm10: 92 },
    excluded: { pm25: 'above-pm10' },
  });
  // The margin itself.
  assert.deepEqual(plausibility({ pm25: 160, pm10: 100 }).kept, {
    pm25: 160,
    pm10: 100,
  });
  assert.deepEqual(plausibility({ pm25: 160.1, pm10: 100 }).kept, {
    pm10: 100,
  });
});

const hourly = (parameter, value, observedMs, extra = {}) => ({
  id: `x:1:${parameter}`,
  provider: 'x',
  stationId: '1',
  parameter,
  units: 'µg/m³',
  value,
  averagingMinutes: 60,
  observedMs,
  ...extra,
});
const H = 3600_000;

test('an hour above its fault ceiling counts as missing in the NowCast', () => {
  const T = 100 * H;
  // 4,000 µg/m³ is no outdoor air: it is a missing hour, not an average's
  // weight. Two of the last three hours remain, so the NowCast is 10.
  const [station] = aqiStations([
    hourly('PM2.5', 10, T - 2 * H),
    hourly('PM2.5', 4000, T - H),
    hourly('PM2.5', 10, T),
  ]);
  assert.equal(station.values.pm25, 10);
  assert.equal(stationIndex(station).aqi.index, 53);
  // A newest hour at fault with too few hours left says why.
  const [alone] = aqiStations([
    hourly('PM2.5', 10, T - H),
    hourly('PM2.5', 4000, T),
  ]);
  assert.deepEqual(alone.values, {});
  assert.equal(alone.excluded.pm25, 'implausible');
});

test('an old 1-hour ozone or 24-hour SO2 does not rate beside a current value', () => {
  const T = 1000 * H;
  const ppb = (parameter, value, observedMs, averagingMinutes) =>
    hourly(parameter, value, observedMs, { units: 'ppb', averagingMinutes });
  // A 500 ppb ozone hour three days old beside a current 40 ppb 8-hour value.
  const [ozone] = aqiStations([
    ppb('O3', 500, T - 72 * H, 60),
    ppb('O3', 40, T, 480),
  ]);
  assert.equal(ozone.hourValues.o3, undefined);
  assert.equal(stationIndex(ozone).aqi.index, 37);
  // Within the spread the 1-hour rows still apply.
  const [recent] = aqiStations([
    ppb('O3', 500, T - H, 60),
    ppb('O3', 40, T, 480),
  ]);
  assert.equal(stationIndex(recent).aqi.index, 396);
  // A 605 ppb daily SO2 three days old beside a current 10 ppb hour.
  const [so2] = aqiStations([
    ppb('SO2', 605, T - 72 * H, 1440),
    ppb('SO2', 10, T, 60),
  ]);
  assert.equal(so2.dayValues.so2, undefined);
  assert.equal(stationIndex(so2).aqi.index, 14);
  const [current] = aqiStations([
    ppb('SO2', 605, T, 1440),
    ppb('SO2', 400, T, 60),
  ]);
  assert.equal(stationIndex(current).aqi.index, 301);
});

test('a 24-hour SO2 average rates on its own, and survives a flagged hour of its time (EPA)', () => {
  const T = 1000 * H;
  const ppb = (value, observedMs, averagingMinutes, extra = {}) =>
    hourly('SO2', value, observedMs, {
      units: 'ppb',
      averagingMinutes,
      ...extra,
    });
  const index = (rows) => stationIndex(aqiStations(rows)[0]).aqi?.index;
  // A daily 605 ppb alone is 301 on the 24-hour rows; below 305 ppb a daily
  // mean alone does not rate: the EPA's lower rows read the day's highest
  // 1-hour value, which a mean cannot stand in for.
  assert.equal(index([ppb(605, T, 1440)]), 301);
  assert.equal(index([ppb(75, T, 1440)]), undefined);
  // A flagged hour of its time does not discard it.
  assert.equal(
    index([ppb(605, T - H, 1440), ppb(10, T, 60, { qualityFlagged: true })]),
    301,
  );
  // A usable hour of its time rates, with the daily on the 24-hour rows.
  assert.equal(index([ppb(200, T, 1440), ppb(10, T, 60)]), 14);
  assert.equal(index([ppb(605, T, 1440), ppb(400, T, 60)]), 301);
  // A flagged hour well after the daily is the newest reading: unrated.
  const [late] = aqiStations([
    ppb(605, T - 10 * H, 1440),
    ppb(10, T, 60, { qualityFlagged: true }),
  ]);
  assert.equal(stationIndex(late).aqi, null);
  assert.equal(late.excluded.so2, 'flagged');
});
