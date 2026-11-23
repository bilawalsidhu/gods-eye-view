import test from 'node:test';
import assert from 'node:assert/strict';
import {
  US_AQI_BANDS,
  US_AQI_LIMITS,
  aqiStations,
  concentrationIn,
  plausible,
  usAqi,
  usAqiBand,
} from './usAqi.js';
import { createAirQualitySource } from './providers.js';
import { createAirQualityLayer } from './index.js';
import { normalizeCpcbRecords } from './cpcb.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';

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

test('ozone above 0.200 ppm is hazardous, numbered on the 1-hour row', () => {
  assert.equal(usAqi({ o3: 200 * 1.963 }).index, 300);
  assert.equal(usAqi({ o3: 201 * 1.963 }).index, 301);
  assert.equal(usAqi({ o3: 404 * 1.963 }).index, 301);
  assert.equal(usAqi({ o3: 604 * 1.963 }).index, 500);
});

test('a 1-hour SO2 value at or above 305 ppb is fixed at 200 (EPA)', () => {
  assert.equal(usAqi({ so2: 304 * 2.62 }).index, 200);
  assert.equal(usAqi({ so2: 305 * 2.62 }).index, 200);
  assert.equal(usAqi({ so2: 900 * 2.62 }).index, 200);
});

test('no rated value gives null', () => {
  assert.equal(usAqi({}), null);
  assert.equal(usAqi({ pm25: NaN, pm10: -1, co2: 420 }), null);
  assert.equal(usAqi(null), null);
});

test('plausible drops PM2.5 above PM10', () => {
  assert.deepEqual(plausible({ pm25: 308, pm10: 92 }), { pm10: 92 });
  assert.deepEqual(plausible({ pm25: 40, pm10: 92 }), { pm25: 40, pm10: 92 });
});

test('a lone outlier does not reach 500', () => {
  assert.deepEqual(plausible({ pm10: 7000 }), {});
  assert.equal(usAqi(plausible({ pm10: 7000 })), null);
  assert.deepEqual(
    plausible({
      pm25: 3001,
      o3: 1001,
      no2: 1501,
      so2: 3001,
      co: 101,
    }),
    {},
  );
  assert.deepEqual(plausible({ pm25: 3000, co: 100 }), { pm25: 3000, co: 100 });
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
  assert.equal(concentrationIn('O3', 0.05, 'ppm'), 50 * 1.963);
  assert.equal(concentrationIn('PM2.5', 7, 'ug/m3'), 7);
  assert.equal(concentrationIn('PM2.5', 7, 'ppm'), null);
  assert.equal(concentrationIn('PM2.5', 7, null), null);
  assert.equal(concentrationIn('CO2', 420, 'ppm'), null);
  assert.equal(concentrationIn('PM10', -1, 'µg/m³'), null);
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
  assert.equal(station.observedMs, 2000);
  assert.equal(station.averagingMinutes, 60);
  assert.equal(station.aqi, null);
  assert.equal(station.units, undefined);
  assert.equal(rest[0].id, 'x:2:aqi');
  // Readings that already carry values pass through unchanged.
  const ready = { id: 'y:1:aqi', values: { pm25: 3 } };
  assert.equal(aqiStations([ready])[0], ready);
});

test('a station its provider leaves unrated keeps no values and stays unrated', () => {
  const [station] = aqiStations([
    {
      id: 'cpcb:1:PM2.5',
      provider: 'cpcb',
      stationId: '1',
      parameter: 'PM2.5',
      value: 123,
      units: null,
      rated: false,
      aqi: null,
      observedMs: 1000,
    },
  ]);
  assert.equal(station.rated, false);
  assert.deepEqual(station.values, {});
  assert.equal(station.aqi, null);
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
const ogdStamp = (ms) => {
  const ist = new Date(ms + 330 * 60_000).toISOString();
  return `${ist.slice(8, 10)}-${ist.slice(5, 7)}-${ist.slice(0, 4)} ${ist.slice(11, 19)}`;
};

function stationLayer(routes) {
  const requests = [];
  const source = createAirQualitySource({
    fetchImpl: async (url) => {
      requests.push(String(url));
      const answer = routes[String(url).split('?')[0]];
      if (!answer) throw new Error(`unexpected request ${url}`);
      return Response.json(
        typeof answer === 'function' ? answer(String(url)) : answer,
      );
    },
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
    // SAAQIS keeps one row per pollutant: PM2.5 5 µg/m³ and NO2 10 ppb.
    '/api/air-quality/south-africa': snapshotOf([
      site('saaqis', '2', -25.5, {
        value: 5,
        rating: { score: 4, label: 'Moderate', method: 'SAAQIS index' },
      }),
      site('saaqis', '2', -25.5, {
        id: 'saaqis:2:NO2',
        parameter: 'NO2',
        units: 'ppb',
        value: 10,
      }),
    ]),
    '/api/air-quality/india': snapshotOf(
      normalizeCpcbRecords(
        {
          records: [
            {
              country: 'India',
              state: 'S',
              city: 'C',
              station: 'India',
              latitude: '-26.5',
              longitude: '28',
              pollutant_id: 'PM2.5',
              avg_value: '300',
              last_update: ogdStamp(minutesAgo(10)),
            },
          ],
        },
        { now: Date.now() },
      ).readings,
    ),
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
  // SAAQIS: PM2.5 5 gives 28, NO2 10 ppb gives 9; one station from two rows.
  assert.equal(points.get('saaqis').meta.aqi.index, 28);
  assert.equal(points.get('saaqis').color, '#00e400');
  // India stays unrated: no index from a reading marked rated: false.
  assert.equal(points.get('cpcb').meta.aqi, null);
  assert.equal(points.get('cpcb').color, '#8cb4ce');
  assert.equal(layer.getStats().count, 3);

  const card = layer.getRowControls();
  assert.deepEqual(
    card.legend.map((band) => band.color),
    [
      '#00e400',
      '#ffff00',
      '#ff7e00',
      '#ff0000',
      '#8f3f97',
      '#7e0023',
      '#8cb4ce',
    ],
  );
  assert.equal(card.legend[0].label, 'Good 0–50');
  assert.equal(card.legend[5].label, 'Hazardous 301+');
  assert.deepEqual(
    card.list.items.map((item) => item.badge),
    ['Unhealthy', 'Good', 'Not rated'],
  );
  assert.equal(card.list.items[0].lead, 'US AQI 154');
  assert.match(card.list.items[0].text, /PM2\.5/);
  assert.match(card.summary.status, /US AQI · Unhealthy/);
  assert.match(
    card.summary.overview[0].text,
    /Highest US AQI category in view: Unhealthy · openaq 1/,
  );
  assert.equal(layer.getAnalystRecords()[0].scale, 'US AQI');
  layer.destroy();
});

test('a pollutant view rates every network on the EEA hourly bands', async () => {
  const { layer, drawn } = stationLayer({
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
    // SAAQIS rates this station "Moderate" (4/10) on its own index.
    '/api/air-quality/south-africa': snapshotOf([
      site('saaqis', '2', -25.5, {
        value: 10,
        rating: { score: 4, label: 'Moderate', method: 'SAAQIS index' },
        color: '#F7FF00',
      }),
    ]),
    '/api/air-quality/india': snapshotOf(),
  });
  layer.setParams({ view: 'PM2.5' });
  await layer.update();
  const points = drawn();
  assert.equal(points.get('saaqis').meta.assessment.label, 'Fair');
  assert.equal(points.get('saaqis').color, '#a3cf62');
  assert.equal(points.get('openaq').meta.assessment.label, 'Extremely poor');
  const card = layer.getRowControls();
  // One scale: the EEA PM2.5 bands and "Not rated", nothing from SAAQIS.
  assert.deepEqual(
    card.legend.map((band) => band.color),
    [
      '#50c9b5',
      '#a3cf62',
      '#f2d45c',
      '#f29457',
      '#e96070',
      '#bb6bbd',
      '#8cb4ce',
    ],
  );
  // The 400 µg/m³ station ranks first; SAAQIS's own index stays in details.
  assert.deepEqual(
    card.list.items.map((item) => item.badge),
    ['Extremely poor', 'Fair'],
  );
  assert.match(card.list.items[1].text, /SAAQIS index 4\/10/);
  assert.match(card.summary.status, /Extremely poor/);
  layer.destroy();
});
