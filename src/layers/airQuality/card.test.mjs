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
  observation: true,
  direct: true,
  parameters: ALL,
  ...extra,
});
const OPENAQ = definition('openaq', {
  viewDriven: true,
  worldwide: true,
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
const PARIS = { lat: 48.85, lon: 2.35, name: 'Paris' };
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
  /** Look at `place`; `rect`, when given, is the new view rectangle. */
  const moveTo = (place, rect = camera.rect) => {
    camera.center = { lon: place.lon, lat: place.lat };
    camera.rect = rect;
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
    // CO in mg/m³ on its own steps (WHO), the same six bands.
    { value: '0.40', note: 'Good', accent: '#50c9b5' },
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
    clear: { label: 'Deselect station', params: { station: null } },
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

test('highest in view rows are one line: rank, band colour, value and name', async () => {
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
    list.items.map(({ ordinal, swatch, lead, text, badge, params }) => ({
      ordinal,
      swatch,
      lead,
      text,
      badge,
      params,
    })),
    [
      {
        ordinal: 1,
        swatch: '#ff7e00',
        lead: '112',
        text: 'Durban',
        badge: undefined,
        params: { station: 'saaqis:durban:aqi' },
      },
      {
        ordinal: 2,
        swatch: '#ffff00',
        lead: '56',
        text: 'Cape Town',
        badge: undefined,
        params: { station: 'saaqis:cape-town:aqi' },
      },
    ],
  );
  // The station's details stay a row's tooltip, never a second line.
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

test('the card is slim: one time line, a station count, the key lines and nothing else', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const { layer } = cardHarness({
    openaq: noKey(),
    saaqis: station('saaqis', CAPE_TOWN, CAPE_TOWN_VALUES),
  });
  const before = layer.getRowControls();
  assert.equal(before.summary.status, '');
  assert.equal(before.summary.detail, '');
  await layer.update();
  await flush();
  const { summary } = layer.getRowControls();
  // The badge names where the drawn stations are: here South Africa's
  // network only (its title), not the world.
  assert.equal(summary.coverage, 'saaqis');
  // The networks drawn, and how fresh the newest reading is.
  assert.equal(summary.detail, 'SAAQIS · updated 10m ago');
  assert.equal(summary.status, '1 station');
  // Above the switch only what needs doing: no coverage notes, counts,
  // interpretation, headline or guidance.
  assert.deepEqual(summary.lines, [
    {
      id: 'provider-openaq',
      muted: true,
      text: 'OPENAQ: add a key in Provider Settings',
    },
  ]);
  assert.equal(summary.overview, undefined);
  assert.equal(summary.settings, undefined);
  assert.doesNotMatch(
    JSON.stringify(summary),
    /catalog stations|GEV computes|Most people|Highest US AQI|unmonitored/i,
  );
});

test('the AQI and pollutant views show a ramp with its range; the AQHI view keeps its bands', async () => {
  const { layer } = cardHarness({
    saaqis: (request) =>
      request.mode === 'aqi'
        ? station('saaqis', CAPE_TOWN, CAPE_TOWN_VALUES)
        : [],
    eccc: [
      {
        id: 'eccc:a',
        provider: 'eccc',
        stationId: 'a',
        name: 'Toronto',
        zone: 'ON',
        lat: 43.65,
        lon: -79.38,
        value: 2,
        label: '2',
        scale: 'AQHI',
        color: '#00ccff',
        risk: 'Low health risk',
        observedMs: Date.now(),
      },
    ],
  });
  await layer.update();
  await flush();
  let controls = layer.getRowControls();
  assert.equal(controls.legendCategorical, false);
  assert.deepEqual(
    controls.legend.map((band) => band.label),
    ['0', '50', '100', '150', '200', '300+'],
  );
  assert.deepEqual(
    controls.legend.map((band) => band.color),
    ['#00e400', '#ffff00', '#ff7e00', '#ff0000', '#8f3f97', '#7e0023'],
  );
  assert.equal(controls.summary.units, '');
  layer.setParams({ view: 'PM2.5' });
  await flush();
  controls = layer.getRowControls();
  assert.deepEqual(
    controls.legend.map((band) => band.label),
    ['0', '5', '15', '50', '90', '140+'],
  );
  assert.equal(controls.summary.units, 'µg/m³');
  assert.equal(controls.summary.unitsVerbatim, true);
  // CO in mg/m³ on its own steps.
  layer.setParams({ view: 'CO' });
  await flush();
  controls = layer.getRowControls();
  assert.deepEqual(
    controls.legend.map((band) => band.label),
    ['0', '4', '7', '10', '35', '100+'],
  );
  assert.equal(controls.summary.units, 'mg/m³');
  layer.setParams({ view: 'aqhi' });
  await flush();
  controls = layer.getRowControls();
  assert.equal(controls.legendCategorical, true);
  assert.deepEqual(
    controls.legend.map((band) => band.label),
    ['Low 1–3'],
  );
  assert.equal(controls.summary.coverage, 'Canada');
});

test('in a pollutant view the other tiles read the latest AQI-view values', async () => {
  const { layer, calls } = cardHarness({
    saaqis: (request) => {
      const rows = station('saaqis', CAPE_TOWN, CAPE_TOWN_VALUES);
      return request.mode === 'aqi'
        ? rows
        : rows
            .filter((row) => row.parameter === request.parameter)
            .map(interpretHourly);
    },
  });
  await layer.update();
  await flush();
  layer.setParams({ view: 'NO2' });
  await flush();
  const asked = calls.length;
  const controls = layer.getRowControls();
  // NO2 from the NO2 view's own reading; the rest remembered, no request.
  assert.equal(tile(controls, 'pollutants', 'NO2').value, '20');
  assert.equal(tile(controls, 'index', 'aqi').value, '56');
  assert.equal(tile(controls, 'index', 'aqi').note, 'Moderate');
  assert.equal(tile(controls, 'pollutants', 'PM2.5').value, '12');
  assert.equal(tile(controls, 'pollutants', 'CO').value, '0.40');
  assert.equal(calls.length, asked);
  // Without an AQI view first there is nothing to remember.
  const fresh = cardHarness(
    {
      saaqis: (request) =>
        station('saaqis', CAPE_TOWN, CAPE_TOWN_VALUES)
          .filter((row) => row.parameter === request.parameter)
          .map(interpretHourly),
    },
    { view: 'NO2' },
  );
  await fresh.layer.update();
  await flush();
  assert.equal(tile(fresh.layer.getRowControls(), 'index', 'aqi').value, '—');
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
    {
      id: 'provider-openaq',
      muted: true,
      text: 'OPENAQ: add a key in Provider Settings',
    },
  ]);
  // The source line names the networks drawn: an empty Europe is not
  // pinned on a network that was never asked.
  assert.match(controls.summary.detail, /^SAAQIS · updated /);
  assert.equal(controls.summary.status, '1 station');
});

test('the time line and the AQHI legend come only from providers that answered; a failed one reads unavailable', async () => {
  const regional = definition('regional');
  const { layer } = cardHarness(
    {
      openaq: station('openaq', DURBAN, { 'PM2.5': 40 }),
      saaqis: station('saaqis', CAPE_TOWN, CAPE_TOWN_VALUES),
      regional: new Error('Air quality provider unavailable'),
    },
    { definitions: [OPENAQ, definition('saaqis'), regional, ECCC] },
  );
  await layer.update();
  await flush();
  let controls = layer.getRowControls();
  assert.equal(lineText(controls, 'provider-regional'), 'REGIONAL unavailable');
  assert.match(controls.summary.detail, /^OPENAQ, SAAQIS · updated /);
  assert.equal(controls.summary.status, '2 stations');
  // The AQHI legend is Canada's only once Canada answered.
  const canada = cardHarness(
    { eccc: new Error('ECCC HTTP 503') },
    { view: 'aqhi' },
  );
  await canada.layer.update();
  await flush();
  controls = canada.layer.getRowControls();
  assert.deepEqual(controls.legend, []);
  assert.equal(controls.summary.status, '');
  assert.equal(lineText(controls, 'provider-eccc'), 'ECCC unavailable');
});

test('a view-driven provider waiting for a camera view neither says Loading nor hides a failure', async () => {
  const { layer, camera } = cardHarness({
    saaqis: new Error('Air quality provider unavailable'),
  });
  camera.rect = null;
  await layer.update();
  await flush();
  const openaq = layer
    .getProviderStates()
    .find((state) => state.id === 'openaq');
  assert.notEqual(openaq.status, 'loading');
  assert.equal(layer.getStats().error, 'Air quality provider unavailable');
  assert.doesNotMatch(layer.getRowControls().summary.status, /Loading/);
  assert.equal(
    lineText(layer.getRowControls(), 'provider-saaqis'),
    'SAAQIS unavailable',
  );

  const answered = cardHarness({
    saaqis: station('saaqis', CAPE_TOWN, CAPE_TOWN_VALUES),
  });
  answered.camera.rect = null;
  await answered.layer.update();
  await flush();
  assert.equal(answered.layer.getRowControls().summary.status, '1 station');
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
  assert.equal(controls.summary.status, '1 station');
  assert.equal(
    lineText(controls, 'provider-openaq'),
    'OPENAQ: request budget reached; cached data will refresh later',
  );
});

test('the retry timer asks again only providers whose cooldown has ended', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const budget = (ms) =>
    Object.assign(new Error('budget'), { retryAt: Date.now() + ms });
  const { layer, calls } = cardHarness(
    { soon: budget(1_000), later: budget(60_000) },
    {
      definitions: [
        definition('soon', { viewDriven: true }),
        definition('later', { viewDriven: true }),
      ],
    },
  );
  await layer.update();
  await flush();
  calls.length = 0;
  t.mock.timers.tick(1_200);
  await flush();
  assert.deepEqual(
    calls.map((call) => call.provider),
    ['soon'],
  );
  layer.disable();
});

test('the first update resolves on the first answer, or after five seconds', async (t) => {
  let release;
  const slow = new Promise((resolve) => {
    release = resolve;
  });
  const { layer } = cardHarness({
    openaq: () => slow,
    saaqis: station('saaqis', CAPE_TOWN, CAPE_TOWN_VALUES),
  });
  const pending = layer.update();
  const first = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve('waiting'), 50)),
  ]);
  assert.equal(first, true);
  assert.equal(
    layer.getProviderStates().find((s) => s.id === 'openaq').status,
    'loading',
  );
  assert.equal(layer.getStats().count, 1);
  release(station('openaq', DURBAN, { 'PM2.5': 40 }));
  await flush();
  assert.equal(layer.getStats().count, 2);

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const silent = cardHarness({
    openaq: () => new Promise(() => {}),
    saaqis: () => new Promise(() => {}),
  });
  const capped = silent.layer.update();
  await flush();
  t.mock.timers.tick(5_000);
  const after = await Promise.race([
    capped,
    new Promise((resolve) => setImmediate(() => resolve('waiting'))),
  ]);
  assert.equal(after, true);
  assert.equal(silent.layer.getRowControls().summary.status, 'Loading');
  silent.layer.disable();
});

test('a source with only the AQHI accepts the default aqi view on restore', () => {
  const layer = createAirQualityLayer({
    source: { getSnapshot: async () => [] },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  assert.notEqual(layer.setParams({ view: 'aqi' }), false);
  assert.equal(layer.getParams().view, 'aqhi');
  assert.equal(layer.setParams({ view: 'NO2' }), false);
});

test('a provider without its key is not asked again on scheduled updates for ten minutes', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const { layer, calls } = cardHarness({
    openaq: noKey(),
    saaqis: station('saaqis', CAPE_TOWN, CAPE_TOWN_VALUES),
  });
  await layer.update();
  await flush();
  calls.length = 0;
  t.mock.timers.tick(9 * 60_000);
  await layer.update();
  await flush();
  assert.deepEqual(
    calls.map((call) => call.provider),
    ['saaqis'],
  );
  // The card keeps saying what is missing.
  assert.equal(
    lineText(layer.getRowControls(), 'provider-openaq'),
    'OPENAQ: add a key in Provider Settings',
  );
  // A view switch does not ask it either.
  calls.length = 0;
  layer.setParams({ view: 'NO2' });
  await flush();
  assert.deepEqual(
    calls.map((call) => call.provider),
    ['saaqis'],
  );
  assert.equal(
    lineText(layer.getRowControls(), 'provider-openaq'),
    'OPENAQ: add a key in Provider Settings',
  );
  calls.length = 0;
  t.mock.timers.tick(2 * 60_000);
  await layer.update();
  await flush();
  assert.deepEqual(calls.map((call) => call.provider).sort(), [
    'openaq',
    'saaqis',
  ]);
});

// ── fix round 1 ────────────────────────────────────────────────────────────

test('the tiles read only stations in view: with none in view they read nothing', async () => {
  const { layer, moveTo } = cardHarness({
    saaqis: station('saaqis', CAPE_TOWN, CAPE_TOWN_VALUES),
  });
  await layer.update();
  await flush();
  moveTo(PARIS, { west: 1, south: 47, east: 4, north: 50 });
  await flush();
  const controls = layer.getRowControls();
  assert.equal(group(controls, 'index').subtitle, '');
  assert.equal(tile(controls, 'index', 'aqi').value, '—');
  assert.equal(tile(controls, 'pollutants', 'PM2.5').value, '—');
});

test('an unrated station at the view centre beats a rated one out of view', async () => {
  const { layer, camera } = cardHarness({
    saaqis: [
      ...station('saaqis', CAPE_TOWN, { 'PM2.5': 12 }).map((row) => ({
        ...row,
        rated: false,
      })),
      ...station('saaqis', DURBAN, { 'PM2.5': 40 }),
    ],
  });
  camera.rect = { west: 17, south: -35, east: 20, north: -33 };
  await layer.update();
  await flush();
  const controls = layer.getRowControls();
  assert.equal(
    group(controls, 'index').subtitle,
    'nearest station · Cape Town',
  );
  assert.equal(tile(controls, 'index', 'aqi').value, '—');
});

test('a tile bands a value only as the map would: a one-hour average, unflagged', async () => {
  const { layer } = cardHarness({
    saaqis: [
      // A 24-hour mean, and a latest value with no stated period (as
      // OpenAQ's latest values come): shown, not banded.
      pollutant('saaqis', CAPE_TOWN, 'PM2.5', 12, { averagingMinutes: 1440 }),
      pollutant('saaqis', CAPE_TOWN, 'NO2', 20, { averagingMinutes: null }),
      pollutant('saaqis', CAPE_TOWN, 'O3', 80),
    ],
  });
  await layer.update();
  await flush();
  const controls = layer.getRowControls();
  const shown = (id) =>
    (({ value, note, accent }) => ({ value, note, accent }))(
      tile(controls, 'pollutants', id),
    );
  assert.deepEqual(shown('PM2.5'), {
    value: '12',
    note: '',
    accent: '#8cb4ce',
  });
  assert.deepEqual(shown('NO2'), { value: '20', note: '', accent: '#8cb4ce' });
  assert.deepEqual(shown('O3'), {
    value: '80',
    note: 'Fair',
    accent: '#a3cf62',
  });
  // The US AQI itself keeps the latest-value method.
  assert.equal(tile(controls, 'index', 'aqi').value, '56');
  assert.equal(tile(controls, 'index', 'aqi').note, 'Moderate');
});

test('a network serving cached data says so in its line; partial coverage alone does not', async () => {
  const stale = cardHarness(
    { saaqis: station('saaqis', CAPE_TOWN, CAPE_TOWN_VALUES) },
    { coverage: { saaqis: { stale: true } } },
  );
  await stale.layer.update();
  await flush();
  assert.deepEqual(
    stale.layer
      .getRowControls()
      .summary.lines.filter((line) => line.id === 'provider-saaqis'),
    [
      {
        id: 'provider-saaqis',
        muted: true,
        text: 'SAAQIS: showing cached data',
      },
    ],
  );
  const partial = cardHarness(
    { saaqis: station('saaqis', CAPE_TOWN, CAPE_TOWN_VALUES) },
    { coverage: { saaqis: { partial: true } } },
  );
  await partial.layer.update();
  await flush();
  assert.equal(
    lineText(partial.layer.getRowControls(), 'provider-saaqis'),
    undefined,
  );
});

/** Cape Town and Durban for the AQI view; one pollutant otherwise. */
const twoStations = (request) => {
  const rows = [
    ...station('saaqis', CAPE_TOWN, CAPE_TOWN_VALUES),
    ...station('saaqis', DURBAN, { 'PM2.5': 40, NO2: 30 }),
  ];
  return request.mode === 'aqi'
    ? rows
    : rows
        .filter((row) => row.parameter === request.parameter)
        .map(interpretHourly);
};

test('a selected station stays across tile clicks, from its remembered values where the view has none', async () => {
  let release;
  const { layer } = cardHarness({
    saaqis: (request) =>
      request.parameter === 'SO2'
        ? new Promise((resolve) => {
            release = () => resolve(twoStations(request));
          })
        : twoStations(request),
  });
  await layer.update();
  await flush();
  layer.setParams({ station: 'saaqis:durban:aqi' });
  // Durban has no SO2: while the view loads and after, the header and the
  // subtitle stay, and the tiles read its AQI-view values.
  layer.setParams({ view: 'SO2' });
  for (const moment of ['loading', 'loaded']) {
    if (moment === 'loaded') {
      release();
      await flush();
    }
    const controls = layer.getRowControls();
    assert.equal(controls.summary.result?.label, 'Durban', moment);
    assert.equal(
      group(controls, 'index').subtitle,
      'measured at the station',
      moment,
    );
    assert.equal(tile(controls, 'index', 'aqi').value, '112', moment);
    assert.equal(tile(controls, 'pollutants', 'PM2.5').value, '40', moment);
    assert.equal(tile(controls, 'pollutants', 'SO2').value, '—', moment);
  }
  // The AQHI view keeps the station and its values too.
  layer.setParams({ view: 'aqhi' });
  await flush();
  const controls = layer.getRowControls();
  assert.equal(controls.summary.result?.label, 'Durban');
  assert.equal(tile(controls, 'index', 'aqi').value, '112');
});

test('the AQHI view tiles read the nearest remembered station in view', async () => {
  const { layer } = cardHarness({ saaqis: twoStations });
  await layer.update();
  await flush();
  layer.setParams({ view: 'aqhi' });
  await flush();
  const controls = layer.getRowControls();
  assert.equal(
    group(controls, 'index').subtitle,
    'nearest station · Cape Town',
  );
  assert.equal(tile(controls, 'index', 'aqi').value, '56');
  assert.equal(tile(controls, 'pollutants', 'NO2').value, '20');
});

test('remembered AQI-view values older than an hour are not shown', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const { layer } = cardHarness({ saaqis: twoStations });
  await layer.update();
  await flush();
  layer.setParams({ view: 'NO2' });
  await flush();
  assert.equal(tile(layer.getRowControls(), 'index', 'aqi').value, '56');
  t.mock.timers.tick(61 * 60_000);
  const controls = layer.getRowControls();
  assert.equal(tile(controls, 'index', 'aqi').value, '—');
  assert.equal(tile(controls, 'pollutants', 'PM2.5').value, '—');
  // The view's own reading still reads.
  assert.equal(tile(controls, 'pollutants', 'NO2').value, '20');
});

test('with the stations off the count and the list are hidden', async () => {
  const { layer } = cardHarness({ saaqis: twoStations });
  await layer.update();
  await flush();
  layer.setParams({ stations: false });
  const controls = layer.getRowControls();
  assert.equal(controls.summary.status, '');
  assert.deepEqual(controls.list.items, []);
});

test('the badge reads Global when a worldwide network drew, else the networks drawn', async () => {
  const world = cardHarness({
    openaq: station('openaq', DURBAN, { 'PM2.5': 40 }),
    saaqis: station('saaqis', CAPE_TOWN, CAPE_TOWN_VALUES),
  });
  await world.layer.update();
  await flush();
  assert.equal(world.layer.getRowControls().summary.coverage, 'Global');
  const local = cardHarness({
    openaq: [],
    saaqis: station('saaqis', CAPE_TOWN, CAPE_TOWN_VALUES),
  });
  await local.layer.update();
  await flush();
  assert.equal(local.layer.getRowControls().summary.coverage, 'saaqis');
});

test('an unrated row shows its value in the view unit when it converts, else a dash', async () => {
  const { layer } = cardHarness(
    {
      saaqis: [
        // 10 ppb NO2, no stated period: unrated, 18.82 µg/m³ at 25 °C.
        pollutant('saaqis', CAPE_TOWN, 'NO2', 10, {
          units: 'ppb',
          averagingMinutes: null,
        }),
        pollutant('saaqis', DURBAN, 'NO2', 7, {
          units: 'index',
          averagingMinutes: null,
        }),
      ].map(interpretHourly),
    },
    { view: 'NO2' },
  );
  await layer.update();
  await flush();
  const leads = Object.fromEntries(
    layer.getRowControls().list.items.map((item) => [item.text, item.lead]),
  );
  assert.deepEqual(leads, { 'Cape Town': '19', Durban: '—' });
});

test('a camera move folded into a scheduled update leaves a provider without its key alone', async () => {
  const regional = definition('regional', { viewDriven: true });
  const { layer, calls, moveTo } = cardHarness(
    {
      openaq: noKey(),
      regional: station('regional', CAPE_TOWN, CAPE_TOWN_VALUES),
    },
    { definitions: [OPENAQ, regional] },
  );
  await layer.update();
  await flush();
  calls.length = 0;
  // The move waits 400 ms; the scheduled update takes it in at once.
  moveTo(DURBAN, { west: 25, south: -35, east: 35, north: -25 });
  await layer.update();
  await flush();
  assert.deepEqual(
    calls.map((call) => call.provider),
    ['regional'],
  );
  layer.disable();
});

test('the stats say loading while a slower provider is still asking', async () => {
  const { layerFeedState } = await import('../../data/feedState.js');
  let release;
  const { layer } = cardHarness({
    openaq: () =>
      new Promise((resolve) => {
        release = () => resolve([]);
      }),
    saaqis: station('saaqis', CAPE_TOWN, CAPE_TOWN_VALUES),
  });
  await layer.update();
  assert.equal(layer.getStats().loading, true);
  assert.equal(layerFeedState(layer.getStats()), 'loading');
  release();
  await flush();
  assert.equal(layer.getStats().loading, false);
  assert.equal(layerFeedState(layer.getStats()), 'nominal');
});

test('a collapsed card with no status shows the first network line', async () => {
  const { layer } = cardHarness({ openaq: noKey() }, { definitions: [OPENAQ] });
  await layer.update();
  await flush();
  const { summary } = layer.getRowControls();
  assert.equal(summary.status, '');
  assert.equal(summary.compact, 'OPENAQ: add a key in Provider Settings');
});

test('the AQHI legend lists each band once across index providers', async () => {
  const second = { ...ECCC, id: 'eccc-2', network: 'ECCC 2' };
  const answer = (provider) => [
    {
      id: `${provider}:a`,
      provider,
      stationId: 'a',
      name: 'Toronto',
      zone: 'ON',
      lat: 43.65,
      lon: -79.38,
      value: 2,
      label: '2',
      scale: 'AQHI',
      color: '#00ccff',
      risk: 'Low health risk',
      observedMs: Date.now(),
    },
  ];
  const { layer } = cardHarness(
    { eccc: answer('eccc'), 'eccc-2': answer('eccc-2') },
    { definitions: [ECCC, second] },
  );
  await layer.update();
  await flush();
  assert.deepEqual(
    layer.getRowControls().legend.map((band) => band.label),
    ['Low 1–3'],
  );
});
