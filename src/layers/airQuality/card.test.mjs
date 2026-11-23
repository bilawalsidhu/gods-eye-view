import assert from 'node:assert/strict';
import test from 'node:test';
import { createAirQualityLayer } from './index.js';
import { interpretHourly } from './interpretation.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';

const ALL = ['PM2.5', 'PM10', 'O3', 'NO2', 'SO2', 'CO'];

const definition = (id, extra = {}) => ({
  id,
  title: id,
  label: `Air quality · ${id}`,
  network: id.toUpperCase(),
  coverage: `${id} coverage`,
  coverageNote: `${id} note`,
  observation: true,
  direct: true,
  parameters: ALL,
  ...extra,
});
const OPENAQ = definition('openaq', {
  viewDriven: true,
  direct: false,
  requiresKeyId: 'openaq',
});
const ECCC = {
  ...definition('eccc'),
  observation: false,
  parameters: [],
  legend: [{ color: '#00ccff', label: 'Low', range: '1–3' }],
  bandContext: 'air quality risk',
};

const CAPE_TOWN = { lat: -33.92, lon: 18.42, name: 'Cape Town' };
const DURBAN = { lat: -29.86, lon: 31.03, name: 'Durban' };

/** One pollutant reading at a station, as a provider answers it. */
const pollutant = (provider, place, parameter, value, extra = {}) => ({
  id: `${provider}:${place.name.toLowerCase().replace(' ', '-')}:${parameter}`,
  provider,
  stationId: place.name.toLowerCase().replace(' ', '-'),
  name: place.name,
  zone: 'Western Cape',
  lat: place.lat,
  lon: place.lon,
  parameter,
  scale: parameter,
  units: parameter === 'CO' ? 'mg/m³' : 'µg/m³',
  value,
  label: `${value}`,
  kind: 'observation',
  averagingMinutes: 60,
  observedMs: Date.now() - 10 * 60_000,
  color: '#8cb4ce',
  licenses: [{ name: 'CC BY 4.0', attribution: 'Licence holder' }],
  ...extra,
});

/** Every pollutant a station reports, for the AQI view. */
const station = (provider, place, values) =>
  Object.entries(values).map(([parameter, value]) =>
    pollutant(provider, place, parameter, value),
  );

const CAPE_TOWN_VALUES = {
  'PM2.5': 12,
  PM10: 30,
  O3: 80,
  NO2: 20,
  SO2: 5,
  CO: 0.4,
};

/**
 * A layer whose camera looks at `center` (the view centre is the middle of
 * an 800 × 600 canvas). `answers` by provider: readings, an Error, or a
 * function of the request returning either (or a promise).
 */
function cardHarness(
  answers,
  {
    definitions = [OPENAQ, definition('saaqis'), ECCC],
    coverage = {},
    view = null,
  } = {},
) {
  const calls = [];
  const camera = {
    center: { lon: CAPE_TOWN.lon, lat: CAPE_TOWN.lat },
    rect: { west: 10, south: -40, east: 35, north: -20 },
  };
  const moveEnd = [];
  const viewer = { canvas: { clientWidth: 800, clientHeight: 600 } };
  bindFakeDraw(viewer, {
    camera: {
      on(event, listener) {
        if (event === 'moveEnd') moveEnd.push(listener);
        return () => {};
      },
      viewRectangle: () => camera.rect,
    },
    query: {
      pickEllipsoid: (x, y) =>
        fromDegrees(
          camera.center.lon + (x - 400) * 0.001,
          camera.center.lat + (300 - y) * 0.001,
        ),
      isOccluded: () => false,
    },
  });
  const layer = createAirQualityLayer({
    source: {
      definitions,
      getCoverage: (id) => coverage[id] ?? null,
      async getSnapshot(request) {
        calls.push(request);
        const entry = answers[request.provider];
        const answer =
          typeof entry === 'function' ? await entry(request) : entry;
        if (answer instanceof Error) throw answer;
        return answer ?? [];
      },
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  layer.init(viewer);
  if (view) layer.setParams({ view });
  layer.enable();
  const moveTo = (place) => {
    camera.center = { lon: place.lon, lat: place.lat };
    for (const listener of moveEnd) listener();
  };
  return { layer, calls, camera, moveTo };
}

const noKey = () =>
  Object.assign(new Error('Provider API key required'), { code: 'no_key' });
const group = (controls, id) => controls.sublists.find((g) => g.id === id);
const tile = (controls, groupId, id) =>
  group(controls, groupId).tiles.find((item) => item.id === id);
const lineText = (controls, id) =>
  controls.summary.lines?.find((line) => line.id === id)?.text;
/** Let every settled provider answer land. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

// ── the tile card ──────────────────────────────────────────────────────────

test('the card has an index group and a six-tile pollutant group', async () => {
  const { layer } = cardHarness({
    saaqis: station('saaqis', CAPE_TOWN, CAPE_TOWN_VALUES),
  });
  await layer.update();
  await flush();
  const controls = layer.getRowControls();
  assert.deepEqual(
    controls.sublists.map((g) => [g.id, g.title, g.tiles.map((t) => t.id)]),
    [
      ['index', 'Index', ['aqi', 'aqhi']],
      ['pollutants', 'Pollutants', ALL],
    ],
  );
  // The units are said once, in the pollutants heading.
  assert.equal(group(controls, 'pollutants').subtitle, 'µg/m³ · CO mg/m³');
  // PM2.5 12 µg/m³ leads: US AQI 56, Moderate.
  assert.deepEqual(tile(controls, 'index', 'aqi'), {
    id: 'aqi',
    value: '56',
    note: 'Moderate',
    label: 'US AQI',
    title: 'US AQI · Moderate',
    accent: '#ffff00',
    active: true,
    params: { view: 'aqi' },
  });
  assert.deepEqual(tile(controls, 'index', 'aqhi'), {
    id: 'aqhi',
    value: 'Canada',
    note: '',
    label: 'AQHI',
    title: 'Air Quality Health Index, Canada only',
    accent: '#6b7785',
    active: false,
    params: { view: 'aqhi' },
  });
  // Each pollutant on the EEA hourly bands; CO has none.
  assert.deepEqual(tile(controls, 'pollutants', 'PM2.5'), {
    id: 'PM2.5',
    value: '12',
    note: 'Fair',
    label: 'PM2.5',
    title: 'PM2.5 · Fair',
    accent: '#a3cf62',
    active: false,
    params: { view: 'PM2.5' },
  });
  assert.equal(tile(controls, 'pollutants', 'O3').label, 'O₃');
  assert.equal(tile(controls, 'pollutants', 'SO2').value, '5.0');
  assert.deepEqual(
    (({ value, note, accent }) => ({ value, note, accent }))(
      tile(controls, 'pollutants', 'CO'),
    ),
    { value: '0.40', note: '', accent: '#8cb4ce' },
  );
  // #1291's view chips are gone: the tiles are the picker.
  assert.equal(controls.summary.settings, undefined);
  assert.deepEqual(controls.summary.toggles, [
    {
      id: 'stations',
      label: 'STATIONS',
      on: true,
      params: { stations: false },
    },
  ]);
  layer.setParams({ stations: false });
  assert.deepEqual(layer.getRowControls().summary.toggles[0].params, {
    stations: true,
  });
});

test('tiles shorten the long band names; the title keeps them', async () => {
  const sensitive = cardHarness({
    saaqis: station('saaqis', CAPE_TOWN, { 'PM2.5': 40 }),
  });
  await sensitive.layer.update();
  await flush();
  const aqi = tile(sensitive.layer.getRowControls(), 'index', 'aqi');
  assert.equal(aqi.value, '112');
  assert.equal(aqi.note, 'Sensitive groups');
  assert.equal(aqi.title, 'US AQI · Unhealthy for Sensitive Groups');
  const extreme = cardHarness({
    saaqis: station('saaqis', CAPE_TOWN, { PM10: 280 }),
  });
  await extreme.layer.update();
  await flush();
  const pm10 = tile(extreme.layer.getRowControls(), 'pollutants', 'PM10');
  assert.equal(pm10.note, 'Extreme');
  assert.equal(pm10.title, 'PM10 · Extremely poor');
});

test('without a field the index subtitle names the nearest station', async () => {
  const { layer, moveTo } = cardHarness({
    saaqis: [
      ...station('saaqis', CAPE_TOWN, CAPE_TOWN_VALUES),
      ...station('saaqis', DURBAN, { 'PM2.5': 40 }),
    ],
  });
  await layer.update();
  await flush();
  let controls = layer.getRowControls();
  assert.equal(
    group(controls, 'index').subtitle,
    'nearest station · Cape Town',
  );
  assert.equal(tile(controls, 'index', 'aqi').value, '56');
  moveTo(DURBAN);
  controls = layer.getRowControls();
  assert.equal(group(controls, 'index').subtitle, 'nearest station · Durban');
  assert.equal(tile(controls, 'index', 'aqi').value, '112');
  assert.equal(tile(controls, 'pollutants', 'NO2').value, '—');
  assert.equal(tile(controls, 'pollutants', 'NO2').note, '');
});

test('in a pollutant view the tiles read what the station measured for it', async () => {
  const { layer } = cardHarness(
    {
      saaqis: (request) =>
        station('saaqis', CAPE_TOWN, CAPE_TOWN_VALUES)
          .filter((row) => row.parameter === request.parameter)
          .map(interpretHourly),
    },
    { view: 'NO2' },
  );
  await layer.update();
  await flush();
  const controls = layer.getRowControls();
  assert.equal(
    group(controls, 'index').subtitle,
    'nearest station · Cape Town',
  );
  assert.deepEqual(
    (({ value, note, active }) => ({ value, note, active }))(
      tile(controls, 'pollutants', 'NO2'),
    ),
    { value: '20', note: 'Fair', active: true },
  );
  // One pollutant is no index: the AQI waits for the AQI view.
  assert.equal(tile(controls, 'index', 'aqi').value, '—');
  assert.equal(tile(controls, 'pollutants', 'PM2.5').value, '—');
});

test('a selected station heads the card and the tiles read it', async () => {
  const { layer } = cardHarness({
    saaqis: (request) => {
      const rows = [
        ...station('saaqis', CAPE_TOWN, CAPE_TOWN_VALUES),
        ...station('saaqis', DURBAN, { 'PM2.5': 40, NO2: 30 }),
      ];
      return request.mode === 'aqi'
        ? rows
        : rows
            .filter((row) => row.parameter === request.parameter)
            .map(interpretHourly);
    },
  });
  await layer.update();
  await flush();
  layer.setParams({ station: 'saaqis:durban:aqi' });
  let controls = layer.getRowControls();
  assert.deepEqual(controls.summary.result, {
    id: 'station',
    lead: true,
    label: 'Durban',
    clear: { params: { station: null } },
    lines: [
      {
        id: 'station-source',
        muted: true,
        text: 'Measured · SAAQIS · 10m ago',
      },
    ],
  });
  assert.equal(group(controls, 'index').subtitle, 'measured at the station');
  assert.equal(tile(controls, 'index', 'aqi').value, '112');
  // A tile changes what the map shows, not the station.
  layer.setParams({ view: 'NO2' });
  await flush();
  controls = layer.getRowControls();
  assert.equal(controls.summary.result?.label, 'Durban');
  assert.equal(layer.getParams().station, 'saaqis:durban:NO2');
  assert.equal(tile(controls, 'pollutants', 'NO2').value, '30');
  layer.setParams({ station: null });
  controls = layer.getRowControls();
  assert.equal(controls.summary.result, null);
  assert.equal(
    group(controls, 'index').subtitle,
    'nearest station · Cape Town',
  );
});

test('highest in view stays a ranked list of value and name, with no licence text', async () => {
  const { layer } = cardHarness({
    saaqis: [
      ...station('saaqis', CAPE_TOWN, CAPE_TOWN_VALUES),
      ...station('saaqis', DURBAN, { 'PM2.5': 40 }),
    ],
  });
  await layer.update();
  await flush();
  const { list } = layer.getRowControls();
  assert.equal(list.title, 'HIGHEST IN VIEW');
  assert.deepEqual(
    list.items.map(({ ordinal, lead, text, badge, params }) => ({
      ordinal,
      lead,
      text,
      badge,
      params,
    })),
    [
      {
        ordinal: 1,
        lead: '112',
        text: 'Durban',
        badge: 'Unhealthy for Sensitive Groups',
        params: { station: 'saaqis:durban:aqi' },
      },
      {
        ordinal: 2,
        lead: '56',
        text: 'Cape Town',
        badge: 'Moderate',
        params: { station: 'saaqis:cape-town:aqi' },
      },
    ],
  );
  // The station's details stay a row's tooltip.
  assert.match(
    list.items[1].title,
    /Calculated US AQI · main pollutant PM2\.5/,
  );
  layer.setParams({ station: 'saaqis:durban:aqi' });
  assert.equal(layer.getRowControls().list.items[0].active, true);
  assert.doesNotMatch(
    JSON.stringify(layer.getRowControls()),
    /Licence holder|CC BY/,
  );
});

// ── per-provider status ────────────────────────────────────────────────────

test('a missing OpenAQ key adds one line naming Provider Settings', async () => {
  const { layer } = cardHarness({
    openaq: noKey(),
    saaqis: station('saaqis', CAPE_TOWN, CAPE_TOWN_VALUES),
  });
  await layer.update();
  await flush();
  const controls = layer.getRowControls();
  const lines = controls.summary.lines.filter((line) =>
    /Provider Settings/.test(line.text),
  );
  assert.deepEqual(lines, [
    { id: 'provider-openaq', text: 'OPENAQ: add a key in Provider Settings' },
  ]);
  // Coverage comes from the networks that answered: an empty Europe is not
  // "unmonitored" when the worldwide network was never asked.
  assert.equal(controls.summary.coverage, 'saaqis coverage');
  assert.equal(lineText(controls, 'coverage'), 'saaqis note');
  assert.equal(controls.summary.status, 'US AQI · Moderate');
});

test('coverage and legend come only from providers that answered; a failed one reads unavailable', async () => {
  const regional = definition('regional');
  const { layer } = cardHarness(
    {
      openaq: [],
      saaqis: station('saaqis', CAPE_TOWN, CAPE_TOWN_VALUES),
      regional: new Error('Air quality provider unavailable'),
    },
    { definitions: [OPENAQ, definition('saaqis'), regional, ECCC] },
  );
  await layer.update();
  await flush();
  let controls = layer.getRowControls();
  assert.equal(lineText(controls, 'provider-regional'), 'REGIONAL unavailable');
  // OpenAQ answered with nothing here: it still covers the view.
  assert.equal(controls.summary.coverage, 'openaq coverage · saaqis coverage');
  assert.equal(lineText(controls, 'coverage'), 'openaq note saaqis note');
  // The AQHI legend is Canada's only once Canada answered.
  const canada = cardHarness(
    { eccc: new Error('ECCC HTTP 503') },
    { view: 'aqhi' },
  );
  await canada.layer.update();
  await flush();
  controls = canada.layer.getRowControls();
  assert.deepEqual(controls.legend, []);
  assert.equal(controls.summary.coverage, '');
});

test("one provider's request budget is its own line, not the card status", async () => {
  const { layer } = cardHarness(
    {
      openaq: [],
      saaqis: station('saaqis', CAPE_TOWN, CAPE_TOWN_VALUES),
    },
    { coverage: { openaq: { failureStatus: 429, stations: [] } } },
  );
  await layer.update();
  await flush();
  const controls = layer.getRowControls();
  assert.equal(controls.summary.status, 'US AQI · Moderate');
  assert.equal(
    lineText(controls, 'provider-openaq'),
    'OPENAQ: request budget reached; cached data will refresh later',
  );
});
