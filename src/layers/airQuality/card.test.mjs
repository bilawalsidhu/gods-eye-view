import assert from 'node:assert/strict';
import test from 'node:test';
import { createAirQualityLayer } from './index.js';
import { createAirQualitySource } from './providers.js';
import { interpretHourly } from './interpretation.js';
import { fromDegrees, toLonLatH } from '../../geo/ellipsoid.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { onAqiPeriods } from '../../testSupport/airQualityViewer.mjs';
import {
  LayerPanel,
  layerKeyRequirementTooltip,
  presentLayerToggle,
} from '../../ui/layerPanel.js';

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
    definitions = [OPENAQ, definition('national')],
    coverage = {},
    view = null,
    project,
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
      ...(project ? { project } : {}),
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
        return request.mode === 'aqi'
          ? onAqiPeriods(answer ?? [])
          : (answer ?? []);
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

test('the card has an index group of one tile and a six-tile pollutant group', async () => {
  const { layer } = cardHarness({
    national: station('national', CAPE_TOWN, CAPE_TOWN_VALUES),
  });
  await layer.update();
  await flush();
  const controls = layer.getRowControls();
  assert.deepEqual(
    controls.sublists.map((g) => [g.id, g.title, g.tiles.map((t) => t.id)]),
    [
      ['index', 'Index', ['aqi']],
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
  // The tiles are the view picker.
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
    national: station('national', CAPE_TOWN, { 'PM2.5': 40 }),
  });
  await sensitive.layer.update();
  await flush();
  const aqi = tile(sensitive.layer.getRowControls(), 'index', 'aqi');
  assert.equal(aqi.value, '112');
  assert.equal(aqi.note, 'Sensitive groups');
  assert.equal(aqi.title, 'US AQI · Unhealthy for Sensitive Groups');
  const extreme = cardHarness({
    national: station('national', CAPE_TOWN, { PM10: 280 }),
  });
  await extreme.layer.update();
  await flush();
  const pm10 = tile(extreme.layer.getRowControls(), 'pollutants', 'PM10');
  assert.equal(pm10.note, 'Extreme');
  assert.equal(pm10.title, 'PM10 · Extremely poor');
});

test('without a field the index subtitle names the nearest station', async () => {
  const { layer, moveTo } = cardHarness({
    national: [
      ...station('national', CAPE_TOWN, CAPE_TOWN_VALUES),
      ...station('national', DURBAN, { 'PM2.5': 40 }),
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
      national: (request) =>
        station('national', CAPE_TOWN, CAPE_TOWN_VALUES)
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
    national: (request) => {
      const rows = [
        ...station('national', CAPE_TOWN, CAPE_TOWN_VALUES),
        ...station('national', DURBAN, { 'PM2.5': 40, NO2: 30 }),
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
  layer.setParams({ station: 'national:durban:aqi' });
  let controls = layer.getRowControls();
  assert.deepEqual(controls.summary.result, {
    id: 'station',
    key: 'national:durban:aqi',
    lead: true,
    label: 'Durban',
    title:
      'Calculated US AQI (NowCast) · main pollutant PM2.5 · PM2.5 40 µg/m³, NO2 30 µg/m³ · NATIONAL · Licence: CC BY 4.0 (Licence holder)',
    clear: { label: 'Deselect station', params: { station: null } },
    lines: [
      {
        id: 'station-source',
        muted: true,
        text: 'Measured · NATIONAL · 10m ago',
      },
      {
        id: 'station-licence',
        muted: true,
        text: 'Licence: CC BY 4.0 (Licence holder)',
      },
    ],
  });
  assert.equal(
    group(controls, 'index').subtitle,
    'calculated from the station',
  );
  assert.equal(tile(controls, 'index', 'aqi').value, '112');
  // A tile changes what the map shows, not the station.
  layer.setParams({ view: 'NO2' });
  await flush();
  controls = layer.getRowControls();
  assert.equal(controls.summary.result?.label, 'Durban');
  assert.equal(
    controls.list.items.find((item) => item.active)?.params.station,
    'national:durban:NO2',
  );
  assert.deepEqual(layer.getParams(), { view: 'NO2' });
  assert.equal(tile(controls, 'pollutants', 'NO2').value, '30');
  layer.setParams({ station: null });
  controls = layer.getRowControls();
  assert.equal(controls.summary.result, null);
  assert.equal(
    group(controls, 'index').subtitle,
    'nearest station · Cape Town',
  );
});

test('a low-cost sensor has no US AQI and is marked a sensor in a pollutant view', async () => {
  const sensorAt = (place, values) =>
    station('national', place, values).map((row) => ({
      ...row,
      monitor: false,
    }));
  const { layer } = cardHarness({
    national: (request) => {
      const rows = [
        ...station('national', CAPE_TOWN, { 'PM2.5': 12 }),
        ...sensorAt(DURBAN, { 'PM2.5': 40 }),
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
  let { list } = layer.getRowControls();
  // The AQI view: the sensor is unrated, and its details say why.
  assert.deepEqual(
    list.items.map((item) => [item.lead, item.text, item.unranked]),
    [
      ['56', 'Cape Town', false],
      ['—', 'Durban · sensor', true],
    ],
  );
  assert.match(
    list.items[1].title,
    /Low-cost sensor · .*Index unavailable · Not used: PM2\.5 \(low-cost sensor\)/,
  );
  layer.setParams({ view: 'PM2.5' });
  await layer.update();
  await flush();
  ({ list } = layer.getRowControls());
  // A pollutant view keeps it, rated on its bands, marked a sensor.
  assert.deepEqual(
    list.items.map((item) => [item.text, item.note]),
    [
      ['Durban · sensor', 'Moderate'],
      ['Cape Town', 'Fair'],
    ],
  );
  layer.setParams({ station: 'national:durban:PM2.5' });
  assert.match(
    layer.getRowControls().summary.result.lines[0].text,
    /^Low-cost sensor · NATIONAL · /,
  );
  layer.destroy();
});

test('in the AQI view two networks at one site pool their pollutants into one index', async () => {
  // The national monitor reports PM2.5 (56); OpenAQ's copy of the site,
  // 10 m away, also reports NO2 at 400 µg/m³ (212 ppb, an index of 122).
  const nearby = { ...CAPE_TOWN, lat: CAPE_TOWN.lat + 0.0001 };
  const { layer } = cardHarness({
    national: station('national', CAPE_TOWN, { 'PM2.5': 12 }),
    openaq: station('openaq', nearby, { 'PM2.5': 12, NO2: 400 }),
  });
  await layer.update();
  await flush();
  const { list } = layer.getRowControls();
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].text, 'Cape Town');
  assert.equal(list.items[0].lead, '122');
  assert.equal(list.items[0].params.station, 'national:cape-town:aqi');
  assert.match(
    list.items[0].title,
    /main pollutant NO2 · PM2\.5 12 µg\/m³, NO2 400 µg\/m³ \(OPENAQ\)/,
  );
  layer.destroy();
});

test('highest in view rows are one line: rank, band colour, value and name', async () => {
  const { layer } = cardHarness({
    national: [
      ...station('national', CAPE_TOWN, CAPE_TOWN_VALUES),
      ...station('national', DURBAN, { 'PM2.5': 40 }),
    ],
  });
  await layer.update();
  await flush();
  const { list } = layer.getRowControls();
  assert.equal(list.title, 'HIGHEST IN VIEW');
  assert.deepEqual(
    list.items.map(({ ordinal, swatch, lead, text, params }) => ({
      ordinal,
      swatch,
      lead,
      text,
      params,
    })),
    [
      {
        ordinal: 1,
        swatch: '#ff7e00',
        lead: '112',
        text: 'Durban',
        params: { station: 'national:durban:aqi' },
      },
      {
        ordinal: 2,
        swatch: '#ffff00',
        lead: '56',
        text: 'Cape Town',
        params: { station: 'national:cape-town:aqi' },
      },
    ],
  );
  // The station's details stay a row's tooltip, never a second line.
  assert.match(
    list.items[1].title,
    /NowCast of recent hourly means · .* · Calculated US AQI \(NowCast\) · main pollutant PM2\.5/,
  );
  layer.setParams({ station: 'national:durban:aqi' });
  assert.equal(layer.getRowControls().list.items[0].active, true);
  // The selected station also displays its licence.
  const { list: rows, summary } = layer.getRowControls();
  assert.deepEqual(
    rows.items.map((item) => item.note),
    ['Sensitive groups', 'Moderate'],
  );
  assert.match(rows.items[0].title, /Licence: CC BY 4\.0 \(Licence holder\)$/);
  assert.match(
    summary.result.lines.find((line) => line.id === 'station-licence').text,
    /CC BY 4\.0/,
  );
});

test('the card is slim: one time line, a station count, the key lines and nothing else', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const { layer } = cardHarness({
    openaq: noKey(),
    national: station('national', CAPE_TOWN, CAPE_TOWN_VALUES),
  });
  const before = layer.getRowControls();
  assert.equal(before.summary.status, '');
  assert.equal(before.summary.detail, '');
  await layer.update();
  await flush();
  const { summary } = layer.getRowControls();
  // The badge names where the drawn stations are: here the national
  // network only (its title), not the world.
  assert.equal(summary.coverage, 'national');
  // The networks drawn, and how fresh the newest reading is.
  assert.equal(summary.detail, 'NATIONAL · updated 10m ago');
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
  assert.equal(summary.settings, undefined);
});

test('the AQI and pollutant views show a ramp with its range', async () => {
  const { layer } = cardHarness({
    national: (request) =>
      request.mode === 'aqi'
        ? station('national', CAPE_TOWN, CAPE_TOWN_VALUES)
        : [],
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
  assert.equal(controls.legendCategorical, false);
});

test('in a pollutant view the other tiles read the latest AQI-view values', async () => {
  const { layer, calls } = cardHarness({
    national: (request) => {
      const rows = station('national', CAPE_TOWN, CAPE_TOWN_VALUES);
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
      national: (request) =>
        station('national', CAPE_TOWN, CAPE_TOWN_VALUES)
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
    national: station('national', CAPE_TOWN, CAPE_TOWN_VALUES),
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
  assert.match(controls.summary.detail, /^NATIONAL · updated /);
  assert.equal(controls.summary.status, '1 station');
  // A network drew: the layer is not waiting for a key.
  assert.equal(layer.getStats().keyRequired, false);
  assert.equal(layer.getStats().error, null);
});

test('the time line comes only from providers that answered; a failed one reads unavailable', async () => {
  const regional = definition('regional');
  const { layer } = cardHarness(
    {
      openaq: station('openaq', DURBAN, { 'PM2.5': 40 }),
      national: station('national', CAPE_TOWN, CAPE_TOWN_VALUES),
      regional: new Error('Air quality provider unavailable'),
    },
    { definitions: [OPENAQ, definition('national'), regional] },
  );
  await layer.update();
  await flush();
  let controls = layer.getRowControls();
  assert.equal(lineText(controls, 'provider-regional'), 'REGIONAL unavailable');
  assert.match(controls.summary.detail, /^OPENAQ, NATIONAL · updated /);
  assert.equal(controls.summary.status, '2 stations');
  // Every network failing: no station and no time line, each one unavailable.
  const down = cardHarness(
    {
      openaq: new Error('Air quality provider unavailable'),
      national: new Error('Air quality provider unavailable'),
    },
    { definitions: [definition('openaq'), definition('national')] },
  );
  await down.layer.update();
  await flush();
  controls = down.layer.getRowControls();
  assert.equal(controls.summary.status, '');
  assert.equal(controls.summary.detail, '');
  assert.equal(lineText(controls, 'provider-national'), 'NATIONAL unavailable');
});

test('a view-driven provider waiting for a camera view neither says Loading nor hides a failure', async () => {
  const { layer, camera } = cardHarness({
    national: new Error('Air quality provider unavailable'),
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
    lineText(layer.getRowControls(), 'provider-national'),
    'NATIONAL unavailable',
  );

  const answered = cardHarness({
    national: station('national', CAPE_TOWN, CAPE_TOWN_VALUES),
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
      national: station('national', CAPE_TOWN, CAPE_TOWN_VALUES),
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
    national: station('national', CAPE_TOWN, CAPE_TOWN_VALUES),
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
    national: () => new Promise(() => {}),
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

test('a source offers the US AQI and the pollutants its networks measure', () => {
  const layer = createAirQualityLayer({
    source: {
      definitions: [definition('regional', { parameters: ['PM2.5'] })],
      getSnapshot: async () => [],
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  assert.equal(layer.getParams().view, 'aqi');
  assert.notEqual(layer.setParams({ view: 'PM2.5' }), false);
  assert.equal(layer.getParams().view, 'PM2.5');
  for (const view of ['NO2']) assert.equal(layer.setParams({ view }), false);
  assert.notEqual(layer.setParams({ view: 'aqi' }), false);
  assert.equal(layer.getParams().view, 'aqi');
});

test('a provider without its key is not asked again on scheduled updates for ten minutes', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const { layer, calls } = cardHarness({
    openaq: noKey(),
    national: station('national', CAPE_TOWN, CAPE_TOWN_VALUES),
  });
  await layer.update();
  await flush();
  calls.length = 0;
  t.mock.timers.tick(9 * 60_000);
  await layer.update();
  await flush();
  assert.deepEqual(
    calls.map((call) => call.provider),
    ['national'],
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
    ['national'],
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
    'national',
    'openaq',
  ]);
});

// ── what the tiles read ────────────────────────────────────────────────────

test('the tiles read only stations in view: with none in view they read nothing', async () => {
  const { layer, moveTo } = cardHarness({
    national: station('national', CAPE_TOWN, CAPE_TOWN_VALUES),
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
    national: [
      ...station('national', CAPE_TOWN, { 'PM2.5': 12 }).map((row) => ({
        ...row,
        qualityFlagged: true,
      })),
      ...station('national', DURBAN, { 'PM2.5': 40 }),
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
    national: [
      // A 24-hour mean, and a latest value with no stated period (as
      // OpenAQ's latest values come): shown, not banded.
      pollutant('national', CAPE_TOWN, 'PM2.5', 12, { averagingMinutes: 1440 }),
      pollutant('national', CAPE_TOWN, 'NO2', 20, { averagingMinutes: null }),
      pollutant('national', CAPE_TOWN, 'O3', 80),
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
    { national: station('national', CAPE_TOWN, CAPE_TOWN_VALUES) },
    { coverage: { national: { stale: true } } },
  );
  await stale.layer.update();
  await flush();
  assert.deepEqual(
    stale.layer
      .getRowControls()
      .summary.lines.filter((line) => line.id === 'provider-national'),
    [
      {
        id: 'provider-national',
        muted: true,
        text: 'NATIONAL: showing cached data',
      },
    ],
  );
  const partial = cardHarness(
    { national: station('national', CAPE_TOWN, CAPE_TOWN_VALUES) },
    { coverage: { national: { partial: true } } },
  );
  await partial.layer.update();
  await flush();
  assert.equal(
    lineText(partial.layer.getRowControls(), 'provider-national'),
    undefined,
  );
});

/** Cape Town and Durban for the AQI view; one pollutant otherwise. */
const twoStations = (request) => {
  const rows = [
    ...station('national', CAPE_TOWN, CAPE_TOWN_VALUES),
    ...station('national', DURBAN, { 'PM2.5': 40, NO2: 30 }),
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
    national: (request) =>
      request.parameter === 'SO2'
        ? new Promise((resolve) => {
            release = () => resolve(twoStations(request));
          })
        : twoStations(request),
  });
  await layer.update();
  await flush();
  layer.setParams({ station: 'national:durban:aqi' });
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
      'calculated from the station',
      moment,
    );
    assert.equal(tile(controls, 'index', 'aqi').value, '112', moment);
    assert.equal(tile(controls, 'pollutants', 'PM2.5').value, '40', moment);
    assert.equal(tile(controls, 'pollutants', 'SO2').value, '—', moment);
  }
});

test('remembered AQI-view values older than an hour are not shown', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const { layer } = cardHarness({ national: twoStations });
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
  const { layer } = cardHarness({ national: twoStations });
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
    national: station('national', CAPE_TOWN, CAPE_TOWN_VALUES),
  });
  await world.layer.update();
  await flush();
  assert.equal(world.layer.getRowControls().summary.coverage, 'Global');
  const local = cardHarness({
    openaq: [],
    national: station('national', CAPE_TOWN, CAPE_TOWN_VALUES),
  });
  await local.layer.update();
  await flush();
  assert.equal(local.layer.getRowControls().summary.coverage, 'national');
});

test('an unrated row shows its value in the view unit when it converts, else a dash', async () => {
  const { layer } = cardHarness(
    {
      national: [
        // 10 ppb NO2, no stated period: unrated, 18.82 µg/m³ at 25 °C.
        pollutant('national', CAPE_TOWN, 'NO2', 10, {
          units: 'ppb',
          averagingMinutes: null,
        }),
        pollutant('national', DURBAN, 'NO2', 7, {
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

test('the stats say loading only until the first network answers, not on every refresh', async () => {
  const { layerFeedState } = await import('../../data/feedState.js');
  const held = [];
  const { layer } = cardHarness({
    openaq: () => new Promise((resolve) => held.push(() => resolve([]))),
    national: () =>
      new Promise((resolve) =>
        held.push(() =>
          resolve(station('national', CAPE_TOWN, CAPE_TOWN_VALUES)),
        ),
      ),
  });
  const release = async () => {
    for (const answer of held.splice(0)) answer();
    await flush();
  };
  const first = layer.update();
  // Nothing has answered yet: the Layers row says loading.
  assert.equal(layer.getStats().loading, true);
  assert.equal(layerFeedState(layer.getStats()), 'loading');
  // The national network answers while OpenAQ is still asking: no longer loading.
  held.pop()();
  await first;
  await flush();
  assert.equal(layer.getStats().loading, false);
  await release();
  assert.equal(layerFeedState(layer.getStats()), 'nominal');
  // A scheduled refresh in flight does not flicker the row back to loading.
  void layer.update();
  assert.equal(layer.getStats().loading, false);
  await release();
});

test('a collapsed card with no status shows the first network line', async () => {
  const { layer } = cardHarness({ openaq: noKey() }, { definitions: [OPENAQ] });
  await layer.update();
  await flush();
  const { summary } = layer.getRowControls();
  assert.equal(summary.status, '');
  assert.equal(summary.compact, 'OPENAQ: add a key in Provider Settings');
});

// ── keys, failures, age and provenance ─────────────────────────────────────

/**
 * A layer on the default providers, each local route answering
 * `routes[path]` (`{ status, body }`); a route not listed answers 404.
 */
function routedLayer(routes) {
  const requests = [];
  const source = createAirQualitySource({
    fetchImpl: async (url) => {
      requests.push(String(url));
      const answer = routes[String(url).split('?')[0]] ?? { status: 404 };
      return Response.json(answer.body ?? {}, { status: answer.status ?? 200 });
    },
  });
  const viewer = {};
  bindFakeDraw(viewer, {
    camera: {
      on: () => () => {},
      viewRectangle: () => ({ west: 10, south: -40, east: 35, north: -20 }),
    },
  });
  const layer = createAirQualityLayer({
    source,
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  layer.init(viewer);
  layer.enable();
  return { layer, requests };
}
const NO_KEY_ROUTE = { status: 428, body: { error: 'no_key' } };

test('with no keys the layer still turns on, its key lines shown', async () => {
  const { layer } = routedLayer({
    '/api/air-quality/openaq': NO_KEY_ROUTE,
  });
  assert.equal(await layer.update(), true);
  await flush();
  const controls = layer.getRowControls();
  assert.deepEqual(
    controls.summary.lines.map((line) => [line.id, line.text]),
    [['provider-openaq', 'OpenAQ: add a key in Provider Settings']],
  );
  // The US AQI is the one index tile; the pollutants stay a click away.
  assert.deepEqual(
    group(controls, 'index').tiles.map((item) => item.id),
    ['aqi'],
  );
  assert.equal(tile(controls, 'pollutants', 'PM2.5').params.view, 'PM2.5');
  // A scheduled update keeps the layer on too.
  assert.equal(await layer.update(), true);
  layer.destroy();
});

test('a network the server leaves switched off is no failure, no line and not asked again', async () => {
  const off = () =>
    Object.assign(new Error('Air quality provider not enabled'), {
      code: 'not_configured',
    });
  const { layer, calls } = cardHarness({ openaq: noKey(), national: off() });
  assert.equal(await layer.update(), true);
  await flush();
  const controls = layer.getRowControls();
  assert.deepEqual(
    controls.summary.lines.map((line) => line.id),
    ['provider-openaq'],
  );
  const states = Object.fromEntries(
    layer.getProviderStates().map((state) => [state.id, state]),
  );
  assert.equal(states.national.status, 'disabled');
  assert.equal(states.national.error, null);
  assert.doesNotMatch(String(layer.getStats().error), /NATIONAL|unavailable/);
  const asked = calls.filter((call) => call.provider === 'national').length;
  assert.equal(await layer.update(), true);
  await flush();
  assert.equal(
    calls.filter((call) => call.provider === 'national').length,
    asked,
  );
  layer.destroy();
});

test('an update fails only when every network failed and no other view is on offer', async () => {
  const down = () => new Error('Air quality provider unavailable');
  const only = cardHarness(
    { national: down(), regional: down() },
    { definitions: [definition('national'), definition('regional')] },
  );
  assert.equal(await only.layer.update(), false);
  // The US AQI asks every network: with all of them down nothing is on
  // offer either.
  const all = cardHarness({ national: down(), openaq: down() });
  assert.equal(await all.layer.update(), false);
  // A pollutant only one network measures: the US AQI, asking the other
  // network too, is still on offer.
  const one = cardHarness(
    { national: down(), regional: down() },
    {
      definitions: [
        definition('national', { parameters: ['SO2'] }),
        definition('regional', { parameters: ['PM2.5'] }),
      ],
      view: 'SO2',
    },
  );
  assert.equal(await one.layer.update(), true);
  // A network that needs its key is guidance, not a failure.
  const keyless = cardHarness(
    { openaq: noKey(), national: down() },
    { definitions: [OPENAQ, definition('national')] },
  );
  assert.equal(await keyless.layer.update(), true);
});

test("a station's originating network and licence are named in its row and header tooltips", async () => {
  const { layer } = cardHarness({
    national: station('national', CAPE_TOWN, CAPE_TOWN_VALUES).map((row) => ({
      ...row,
      network: 'City network',
    })),
  });
  await layer.update();
  await flush();
  const [row] = layer.getRowControls().list.items;
  assert.match(
    row.title,
    / · City network · Licence: CC BY 4\.0 \(Licence holder\)$/,
  );
  layer.setParams({ station: row.params.station });
  const { summary } = layer.getRowControls();
  assert.match(
    summary.result.title,
    / · City network · Licence: CC BY 4\.0 \(Licence holder\)$/,
  );
  assert.match(
    summary.result.lines.find((line) => line.id === 'station-licence').text,
    /CC BY/,
  );
  // A station without a stated licence names its network alone.
  const plain = cardHarness({
    national: station('national', CAPE_TOWN, { 'PM2.5': 12 }).map(
      (reading) => ({
        ...reading,
        licenses: undefined,
      }),
    ),
  });
  await plain.layer.update();
  await flush();
  assert.match(
    plain.layer.getRowControls().list.items[0].title,
    / · NATIONAL$/,
  );
});

test('readings older than six hours are not drawn, even with no answer since', async (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'Date'],
    now: 1_700_000_000_000,
  });
  let down = false;
  const { layer } = cardHarness(
    {
      national: () =>
        down
          ? new Error('Air quality provider unavailable')
          : station('national', CAPE_TOWN, CAPE_TOWN_VALUES),
    },
    { definitions: [definition('national')] },
  );
  await layer.update();
  await flush();
  assert.equal(layer.getStats().count, 1);
  // The server goes down: a failed refresh keeps the readings drawn.
  down = true;
  t.mock.timers.tick(5 * 3600_000);
  await layer.update();
  await flush();
  assert.equal(layer.getStats().count, 1);
  // Six hours after they were measured they go, with no answer since.
  t.mock.timers.tick(3600_000);
  await flush();
  assert.equal(layer.getStats().count, 0);
  const controls = layer.getRowControls();
  assert.deepEqual(controls.list.items, []);
  // The card still says the network is unavailable, and how old it was.
  assert.equal(lineText(controls, 'provider-national'), 'NATIONAL unavailable');
  assert.equal(controls.summary.detail, 'NATIONAL · updated 6h ago');
  layer.disable();
});

test('in the AQI view a value older than six hours leaves the index', async (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'Date'],
    now: 1_700_000_000_000,
  });
  const { layer } = cardHarness(
    {
      national: () => [
        pollutant('national', CAPE_TOWN, 'PM2.5', 60, {
          observedMs: Date.now() - 5.5 * 3600_000,
        }),
        pollutant('national', CAPE_TOWN, 'NO2', 20, {
          observedMs: Date.now() - 3 * 3600_000,
        }),
      ],
    },
    { definitions: [definition('national')] },
  );
  await layer.update();
  await flush();
  assert.equal(layer.getRowControls().list.items[0].lead, '154');
  t.mock.timers.tick(3600_000);
  await flush();
  const [row] = layer.getRowControls().list.items;
  // PM2.5 is now 6.5 hours old: NO2 alone (20 µg/m³, 10 ppb: 9) sets the
  // index.
  assert.equal(row.lead, '9');
  assert.match(row.title, /Not used: PM2\.5 \(too old\)/);
  layer.disable();
});

test('the OpenAQ discovery loop waits while the tab is hidden', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const listeners = new Set();
  const page = {
    visibilityState: 'hidden',
    addEventListener: (type, fn) =>
      type === 'visibilitychange' && listeners.add(fn),
    removeEventListener: (type, fn) => listeners.delete(fn),
  };
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    value: page,
    configurable: true,
    writable: true,
  });
  t.after(() => {
    if (saved) Object.defineProperty(globalThis, 'document', saved);
    else delete globalThis.document;
  });
  // OpenAQ says more of the view is on its way in 8 s.
  const { layer, calls } = cardHarness(
    { openaq: [] },
    {
      definitions: [OPENAQ],
      coverage: { openaq: { partial: true, retryAt: 1_008_000 } },
    },
  );
  await layer.update();
  await flush();
  calls.length = 0;
  t.mock.timers.tick(30_000);
  await flush();
  assert.deepEqual(calls, [], 'no discovery while hidden');
  // Shown again, it resumes at once.
  page.visibilityState = 'visible';
  for (const listener of listeners) listener();
  t.mock.timers.tick(200);
  await flush();
  assert.deepEqual(
    calls.map((call) => call.provider),
    ['openaq'],
  );
  layer.destroy();
  assert.equal(listeners.size, 0, 'destroy lets go of the page');
});

test('while OpenAQ is still discovering a view one muted line says how far along', async () => {
  const { layer } = cardHarness(
    { openaq: station('openaq', DURBAN, { 'PM2.5': 40 }) },
    {
      definitions: [OPENAQ],
      coverage: { openaq: { partial: true, checked: 12, eligible: 40 } },
    },
  );
  await layer.update();
  await flush();
  assert.deepEqual(
    layer
      .getRowControls()
      .summary.lines.filter((line) => line.id === 'provider-openaq'),
    [
      {
        id: 'provider-openaq',
        muted: true,
        text: 'OPENAQ: loading stations, 12 of 40',
      },
    ],
  );
  // Complete coverage says nothing.
  const done = cardHarness(
    { openaq: station('openaq', DURBAN, { 'PM2.5': 40 }) },
    {
      definitions: [OPENAQ],
      coverage: { openaq: { partial: false, checked: 40, eligible: 40 } },
    },
  );
  await done.layer.update();
  await flush();
  assert.equal(
    lineText(done.layer.getRowControls(), 'provider-openaq'),
    undefined,
  );
});

test("the layer's stats give the discovery counts the card line shows", async () => {
  const { layer } = cardHarness(
    { openaq: station('openaq', DURBAN, { 'PM2.5': 40 }) },
    {
      definitions: [OPENAQ],
      coverage: { openaq: { partial: true, checked: 12, eligible: 40 } },
    },
  );
  await layer.update();
  await flush();
  assert.deepEqual(layer.getStats().discovery, [
    { network: 'OPENAQ', checked: 12, eligible: 40 },
  ]);
  assert.equal(layer.getStats().partial, undefined, 'the chip is unchanged');
  const done = cardHarness(
    { openaq: station('openaq', DURBAN, { 'PM2.5': 40 }) },
    {
      definitions: [OPENAQ],
      coverage: { openaq: { partial: false, checked: 40, eligible: 40 } },
    },
  );
  await done.layer.update();
  await flush();
  assert.deepEqual(done.layer.getStats().discovery, []);
});

test('a rejected key says so and points to Provider Settings', async () => {
  const { layer } = routedLayer({
    '/api/air-quality/openaq': {
      status: 401,
      body: { error: 'OpenAQ unavailable' },
    },
  });
  await layer.update();
  await flush();
  const controls = layer.getRowControls();
  assert.equal(
    lineText(controls, 'provider-openaq'),
    'OpenAQ: key rejected — check Provider Settings',
  );
  layer.destroy();
});

test('a row whose reading has no observation time still has its tooltip', async () => {
  const { layer } = cardHarness(
    {
      national: [
        interpretHourly(
          pollutant('national', CAPE_TOWN, 'NO2', 20, {
            observedMs: undefined,
          }),
        ),
      ],
    },
    { definitions: [definition('national')], view: 'NO2' },
  );
  await layer.update();
  await flush();
  const [row] = layer.getRowControls().list.items;
  assert.match(
    row.title,
    /^Fair · Cape Town · Western Cape · NATIONAL · Hourly average · Unavailable · /,
  );
  assert.doesNotMatch(row.title, /Older observation/);
});

test("a pollutant view's map label gives the value in the view's unit", async () => {
  const titles = [];
  const viewer = { canvas: { clientWidth: 800, clientHeight: 600 } };
  bindFakeDraw(viewer, {
    camera: {
      on: () => () => {},
      viewRectangle: () => ({ west: 10, south: -40, east: 35, north: -20 }),
    },
  });
  const layer = createAirQualityLayer({
    source: {
      definitions: [definition('national')],
      getSnapshot: async () => [
        interpretHourly(
          pollutant('national', CAPE_TOWN, 'NO2', 10, {
            units: 'ppb',
            label: '10.00 ppb',
          }),
        ),
      ],
    },
    overlayHost: {
      setEntries: (_id, entries) => titles.push(...entries.map((e) => e.title)),
      setVisible() {},
      clearSource() {},
    },
  });
  layer.init(viewer);
  layer.setParams({ view: 'NO2' });
  layer.enable();
  await layer.update();
  await flush();
  assert.equal(titles.at(-1), '\u2068Cape Town\u2069 19 µg/m³ · Fair');
  const [record] = layer.getAnalystRecords();
  assert.equal(record.value, 18.82);
  assert.equal(record.units, 'µg/m³');
  layer.destroy();
});

// ── one index: the computed US AQI ─────────────────────────────────────────

test("a network's own index is never shown, in the AQI view or a pollutant view", async () => {
  const rating = { score: 4, label: 'Moderate', method: 'NATIONAL index' };
  const { layer } = cardHarness(
    {
      national: (request) => {
        const rows = station('national', CAPE_TOWN, CAPE_TOWN_VALUES).map(
          (row) => ({ ...row, rating }),
        );
        return request.mode === 'aqi'
          ? rows
          : rows
              .filter((row) => row.parameter === request.parameter)
              .map(interpretHourly);
      },
    },
    { definitions: [definition('national')] },
  );
  await layer.update();
  await flush();
  assert.doesNotMatch(
    JSON.stringify(layer.getRowControls()),
    /NATIONAL index|4\/10/,
  );
  layer.setParams({ view: 'PM2.5' });
  await flush();
  assert.equal(layer.getRowControls().list.items.length, 1);
  assert.doesNotMatch(
    JSON.stringify(layer.getRowControls()),
    /NATIONAL index|4\/10/,
  );
});

test('keyless by default the layer turns on; its Layers row says KEY REQUIRED, not UNAVAILABLE, and names the missing key', async () => {
  const { layer } = routedLayer({
    '/api/air-quality/openaq': NO_KEY_ROUTE,
  });
  assert.equal(await layer.update(), true);
  await flush();
  const stats = layer.getStats();
  assert.equal(stats.count, 0);
  assert.equal(stats.error, null);
  assert.equal(stats.keyRequired, true);
  assert.equal(stats.loadingLabel, 'KEY REQUIRED');
  assert.equal(stats.source, 'OpenAQ · Worldwide');
  assert.equal(layer.source, stats.source);
  // The row as the layer manager publishes it (DataLayerManager.getAll).
  const row = {
    id: layer.id,
    name: layer.name,
    enabled: true,
    requiresKeyId: layer.requiresKeyId || null,
    stats: { count: 0, lastUpdate: null, ...stats },
  };
  assert.notEqual(presentLayerToggle(row).feedState, 'unavailable');
  assert.equal(
    LayerPanel.prototype._buildMetaText(row),
    'OpenAQ · Worldwide · KEY REQUIRED',
  );
  assert.deepEqual(row.requiresKeyId, ['openaq']);
  assert.equal(
    layerKeyRequirementTooltip(row),
    'Needs OPENAQ_API_KEY — add it in Provider Settings',
  );
  // The card names the key to add, also collapsed.
  const { summary } = layer.getRowControls();
  assert.deepEqual(
    summary.lines.map((line) => line.text),
    ['OpenAQ: add a key in Provider Settings'],
  );
  assert.equal(summary.compact, 'OpenAQ: add a key in Provider Settings');
  layer.destroy();
});

test("a reading's band is its category on the view's scale, for voice queries and context", async () => {
  const { layer } = cardHarness({
    national: (request) => {
      const rows = station('national', CAPE_TOWN, CAPE_TOWN_VALUES);
      return request.mode === 'aqi'
        ? rows
        : rows
            .filter((row) => row.parameter === request.parameter)
            .map(interpretHourly);
    },
  });
  await layer.update();
  await flush();
  // PM2.5 12 µg/m³ leads: US AQI 56, Moderate.
  let [record] = layer.getAnalystRecords();
  assert.equal(record.band, 'Moderate');
  assert.equal('risk' in record, false);
  layer.setParams({ view: 'PM2.5' });
  await flush();
  [record] = layer.getAnalystRecords();
  assert.equal(record.band, 'Fair');
  // A reading no index rates (its source flagged it) has no band.
  const unrated = cardHarness({
    national: station('national', CAPE_TOWN, { 'PM2.5': 12 }).map((row) => ({
      ...row,
      qualityFlagged: true,
    })),
  });
  await unrated.layer.update();
  await flush();
  assert.equal(unrated.layer.getAnalystRecords()[0].band, null);
});

test('remembered AQI-view values obey the six-hour observation age in other views', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const measured = Date.now() - 5.5 * 3600_000;
  const { layer } = cardHarness({
    national: (request) =>
      twoStations(request).map((row) => ({ ...row, observedMs: measured })),
  });
  await layer.update();
  await flush();
  layer.setParams({ view: 'SO2' });
  await flush();
  let controls = layer.getRowControls();
  assert.equal(tile(controls, 'index', 'aqi').value, '56');
  assert.equal(tile(controls, 'pollutants', 'PM2.5').value, '12');
  // Remembered for under an hour, but measured more than six hours ago.
  t.mock.timers.tick(40 * 60_000);
  controls = layer.getRowControls();
  assert.equal(tile(controls, 'index', 'aqi').value, '—');
  assert.equal(tile(controls, 'pollutants', 'PM2.5').value, '—');
  assert.equal(tile(controls, 'pollutants', 'NO2').value, '—');
});

test('a rated station chosen over a nearer unrated one is named the nearest rated station', async () => {
  const { layer } = cardHarness({
    national: [
      ...station('national', CAPE_TOWN, { 'PM2.5': 12 }).map((row) => ({
        ...row,
        qualityFlagged: true,
      })),
      ...station('national', DURBAN, { 'PM2.5': 40 }),
    ],
  });
  await layer.update();
  await flush();
  const controls = layer.getRowControls();
  assert.equal(
    group(controls, 'index').subtitle,
    'nearest rated station · Durban',
  );
  assert.equal(tile(controls, 'index', 'aqi').value, '112');
});
test('a selection follows the copy kept by the next merge', async () => {
  let rows = [];
  const { layer } = cardHarness({
    openaq: station('openaq', CAPE_TOWN, CAPE_TOWN_VALUES),
    national: () => rows,
  });
  await layer.update();
  await flush();
  layer.setParams({ station: 'openaq:cape-town:aqi' });
  rows = station('national', CAPE_TOWN, CAPE_TOWN_VALUES);
  await layer.update();
  await flush();
  const controls = layer.getRowControls();
  assert.equal(controls.summary.result.key, 'national:cape-town:aqi');
  assert.equal(
    controls.list.items.find((item) => item.active).params.station,
    controls.summary.result.key,
  );
});
test('stations that project outside the canvas are not counted or ranked', async () => {
  const { layer } = cardHarness(
    {
      national: [
        ...station('national', CAPE_TOWN, CAPE_TOWN_VALUES),
        ...station('national', DURBAN, { 'PM2.5': 40 }),
      ],
    },
    { project: (p) => ({ x: toLonLatH(p).lon < 25 ? 400 : 1200, y: 300 }) },
  );
  await layer.update();
  await flush();
  const controls = layer.getRowControls();
  assert.equal(controls.summary.status, '1 station');
  assert.deepEqual(
    controls.list.items.map((i) => i.text),
    ['Cape Town'],
  );
});
test('a selected station below the top five shows its index details', async () => {
  const rows = Array.from({ length: 7 }, (_, i) =>
    station(
      'national',
      { ...CAPE_TOWN, name: 'Station ' + i, lon: 18 + i / 5 },
      { 'PM2.5': 10 + i },
    ),
  ).flat();
  const { layer } = cardHarness({ national: rows });
  await layer.update();
  await flush();
  layer.setParams({ station: 'national:station-0:aqi' });
  const controls = layer.getRowControls();
  assert.ok(!controls.list.items.some((i) => i.active));
  assert.match(controls.summary.result.title, /Calculated US AQI/);
});
