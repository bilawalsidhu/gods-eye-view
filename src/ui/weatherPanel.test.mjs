import { onAqiPeriods } from '../testSupport/airQualityViewer.mjs';
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import { nextTick } from 'vue';
import assert from 'node:assert/strict';
import { setLocale } from '../i18n/index.js';
import { createWeatherPanel } from './weatherPanel.js';
import { railDocumentFixture as railFixture } from './railTestFixture.mjs';
import { createAirQualityLayer } from '../layers/airQuality/index.js';
import { bindFakeDraw } from '../testSupport/fakeDrawPort.mjs';
const ticks = ['2026-09-22T01:00:00Z', '2026-09-22T01:05:00Z'];
const wind = {
  id: 'wind',
  icon: '🌬',
  summary: {
    label: 'Wind motion',
    coverage: 'Global · 1° grid',
    validTime: ticks[0],
    issuedTime: ticks[0],
  },
};
const radar = {
  id: 'weather-radar',
  icon: '◉',
  summary: { label: 'Rain radar', coverage: 'CONUS' },
};
function fixture() {
  const f = railFixture();
  // Weather's list in Context reports whether its tab shows, and its count.
  const reports = [];
  const listeners = new Set();
  const calls = [];
  let state = {
    mode: 'latest',
    timeline: ticks,
    products: [{ id: radar.id, shown: ticks[1], selected: ticks[1] }],
  };
  const clock = {
    getState: () => state,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return {
    ...f,
    onPresence: (presence) => reports.push(presence),
    presence: () => reports.at(-1),
    reports,
    calls,
    listeners,
    clock,
    state: (next) => {
      state = { ...state, ...next };
      for (const fn of listeners) fn(state);
    },
  };
}
// Back to the list from any product's details.
const list = (f) =>
  f.container
    .querySelector('.context-list-card__detail [data-list-back]')
    ?.click();
const frameTime = (f) => {
  list(f);
  return f.find((n) => n.className === 'weather-frame-time');
};
const detail = (f) => f.container.querySelector('.context-list-card__detail');
const row = (f, id) => {
  list(f);
  return f.container.querySelector(`.nearby-lists__name[data-card-id="${id}"]`)
    ?.parentElement;
};
const rowIds = (f) =>
  [...f.container.querySelectorAll('.nearby-lists__name')].map(
    (n) => n.dataset.cardId,
  );
// A product's details, opened from its row (after Back from another's).
const card = (f, id) => {
  const shown = detail(f);
  if (shown?.querySelector(`h3[data-card-id="${id}"]`)) return shown;
  shown?.querySelector('[data-list-back]').click();
  row(f, id).click();
  return detail(f);
};
const line = (f, id, name) =>
  f.find((n) => n.dataset.lineId === name, card(f, id));
test('the frame time shows with any observed product; the panel has no time controls of its own', (t) => {
  t.mock.timers.enable({
    apis: ['Date'],
    now: Date.parse('2026-09-22T01:17:00Z'),
  });
  const f = fixture();
  const view = createWeatherPanel(f);
  view.update([wind]);
  assert.equal(frameTime(f).hidden, true);
  view.update([wind, radar]);
  assert.equal(frameTime(f).hidden, false);
  assert.equal(frameTime(f).textContent, '01:05 UTC · 12 min ago');
  f.state({
    timeline: [ticks[0]],
    products: [{ id: radar.id, shown: ticks[0], selected: ticks[0] }],
  });
  assert.equal(frameTime(f).textContent, '01:00 UTC · 17 min ago');
  f.state({ timeline: [], products: [] });
  assert.equal(frameTime(f).hidden, true);
  // Suspended products (reduced motion, a hidden page) leave the timeline;
  // live, their newest frame still shows.
  f.state({
    timeline: [],
    products: [
      { id: radar.id, shown: ticks[1], selected: ticks[1], suspended: true },
      {
        id: 'weather-lightning',
        shown: null,
        selected: ticks[0],
        suspended: true,
      },
    ],
  });
  assert.equal(frameTime(f).hidden, false);
  assert.equal(frameTime(f).textContent, '01:05 UTC · 12 min ago');
  f.state({ timeline: ticks, mode: 'history', target: ticks[0] });
  assert.equal(frameTime(f).textContent, '01:00 UTC');
  assert.equal(
    f.find((n) => n.tagName === 'INPUT'),
    null,
  );
  assert.equal(
    f.find((n) => ['Play', 'Latest'].includes(n.textContent)),
    null,
  );
  view.destroy();
  assert.equal(f.listeners.size, 0);
});
test('ordered articles omit Controls and retain history labels, forecast dates and missing-frame readouts', () => {
  const f = fixture();
  const view = createWeatherPanel(f);
  view.update([radar, wind]);
  assert.deepEqual(rowIds(f), ['wind', 'weather-radar']);
  assert.equal(
    f.find((n) => n.dataset.weatherOpen),
    null,
  );
  assert.match(
    line(f, 'wind', 'time').textContent,
    /Forecast · valid .*UTC · issued .*UTC/,
  );
  f.state({ mode: 'history', target: ticks[1] });
  assert.match(line(f, radar.id, 'time').textContent, /01:05 UTC.*synced/);
  assert.match(line(f, 'wind', 'time').textContent, /Does not follow history/);
  f.state({
    products: [{ id: radar.id, shown: ticks[0], selected: ticks[0] }],
  });
  assert.match(line(f, radar.id, 'time').textContent, /01:00 UTC.*nearest/);
  f.state({ products: [{ id: radar.id, shown: null, selected: null }] });
  assert.equal(
    line(f, radar.id, 'time').textContent,
    'No frame within 30 min of 01:05 UTC',
  );
  const global = {
    id: 'weather-satellite',
    summary: { label: 'Satellite clouds', maxGapMinutes: 180 },
  };
  view.update([global]);
  f.state({ products: [{ id: global.id, shown: null, selected: null }] });
  assert.equal(
    line(f, global.id, 'time').textContent,
    'No frame within 3 h of 01:05 UTC',
  );
  view.destroy();
});
test('cyclone readout retains advisory, position, intensity, geometry, coverage, legend and source link', () => {
  const f = fixture();
  const view = createWeatherPanel(f);
  const cyclone = {
    id: 'weather-cyclones',
    summary: {
      label: 'Cyclones',
      coverage: 'Atlantic + E/C Pacific',
      detail: 'JULIO · Hurricane · Advisory 10 · 09-22 01:00 UTC',
      status: 'Loading advisories…',
      lines: [
        { id: 'position', text: 'Position as of 09-22 00:00 UTC' },
        { id: 'intensity', text: '80 kt · 970 hPa' },
        { id: 'geometry', text: 'Track/cone awaiting advisory 10' },
      ],
      actions: [
        {
          id: 'advisory',
          label: 'Official advisory ↗',
          href: 'https://www.nhc.noaa.gov/advisory',
        },
      ],
    },
    legendCategorical: true,
    legend: [
      { label: 'Advisory center / forecast track', color: '#7fe6ed' },
      { label: 'Center-track uncertainty cone', color: '#7fe6ed44' },
    ],
  };
  view.update([cyclone]);
  assert.equal(frameTime(f).hidden, true);
  assert.match(
    line(f, cyclone.id, 'time').textContent,
    /JULIO.*Hurricane.*Advisory 10.*UTC/,
  );
  assert.match(line(f, cyclone.id, 'position').textContent, /00:00 UTC/);
  assert.match(line(f, cyclone.id, 'intensity').textContent, /80 kt · 970 hPa/);
  assert.match(
    line(f, cyclone.id, 'geometry').textContent,
    /awaiting advisory 10/,
  );
  const link = f.find(
    (n) => n.tagName === 'A' && n.textContent === 'Official advisory ↗',
  );
  assert.equal(link.href, cyclone.summary.actions[0].href);
  assert.equal(link.tagName, 'A');
  assert.equal(link.rel, 'noopener');
  const entries = f.find((n) => n.className === 'rail-card-legend-entries');
  assert.equal(entries.children.length, 2);
  assert.match(entries.children[0].children[1].textContent, /forecast track/);
  assert.match(entries.children[1].children[1].textContent, /uncertainty cone/);
  assert.equal(f.find((n) => n.className === 'rail-card-ramp').hidden, true);
  view.destroy();
});
test('identical updates write nothing and status keeps its line through loading and empty text', (t) => {
  // Ages read in whole minutes: a real clock crossing a minute between the two
  // updates would rightly rewrite them.
  t.mock.timers.enable({
    apis: ['Date'],
    now: Date.parse('2026-09-22T01:17:00Z'),
  });
  const f = fixture();
  const view = createWeatherPanel(f);
  for (const entries of [
    [wind, radar],
    [{ ...wind, summary: { ...wind.summary, status: 'Loading' } }],
    [wind],
    [],
  ]) {
    view.update(entries);
    const status = entries.length ? line(f, 'wind', 'status') : null;
    f.writes();
    view.update(entries);
    assert.equal(f.writes(), 0);
    if (status) {
      assert.equal(status.hidden, false);
      assert.equal(line(f, 'wind', 'status'), status);
    }
  }
  view.destroy();
  assert.equal(f.container.children.length, 0);
  assert.equal(createWeatherPanel(), null);
});
test('the list reports its tab only while a weather product shows, with their count', () => {
  const f = fixture();
  let view = createWeatherPanel(f);
  view.update([]);
  assert.equal(f.presence(), null);
  view.update([wind, radar, { id: 'missing' }]);
  assert.deepEqual(f.presence(), { count: 2 });
  view.update([]);
  assert.equal(f.presence(), null);
  view.update([wind]);
  assert.deepEqual(f.presence(), { count: 1 });
  view.destroy();
  assert.equal(f.presence(), null, 'its tab goes with it');
  view = createWeatherPanel(f);
  view.update([radar]);
  assert.deepEqual(f.presence(), { count: 1 });
  view.destroy();
});

test('settings, reading and footer actions pass the layer id, params and user origin', async () => {
  const { windReadingResult } = await import('../layers/wind/presentation.js');
  const { createWindLayer } = await import('../layers/wind/index.js');
  const layer = createWindLayer({ feed: { getSnapshot: async () => null } });
  const action = layer.getRowControls().summary.actions[0];
  assert.equal(action.label, 'Read wind at map center');
  assert.equal(action.hint, undefined);
  const f = fixture();
  const calls = [];
  const view = createWeatherPanel({
    ...f,
    setLayerParams: (...args) => calls.push(args),
  });
  const reading = {
    coordinates: '26.59°N · 123.34°W',
    wind: '6.0 m/s from N',
    model: 'ECMWF',
    validTime: '2026-09-22 06:00 UTC',
    scalarLabel: 'Wind speed',
    scalarValue: '6.0 m/s',
    explanation: 'Interpolated model forecast.',
  };
  const summary = {
    ...wind.summary,
    reading,
    result: windReadingResult(reading),
    settings: [
      {
        id: 'units',
        label: 'UNITS',
        chips: [{ id: 'units-mph', label: 'mph', params: { units: 'mph' } }],
      },
    ],
    actions: [{ ...action, disabled: false }],
  };
  view.update([{ ...wind, summary }]);
  card(f, 'wind');
  f.find((n) => n.dataset.actionId === 'read-wind').click();
  f.find((n) => n.dataset.chipId === 'units-mph').click();
  f.find((n) => n.dataset.actionId === 'clear').click();
  assert.deepEqual(calls, [
    ['wind', { inspect: true }, { origin: 'user' }],
    ['wind', { units: 'mph' }, { origin: 'user' }],
    ['wind', { inspect: false }, { origin: 'user' }],
  ]);
  const result = f.find((n) => n.className === 'rail-card-result');
  const header = result.children[0];
  assert.equal(header.className, 'rail-card-result-header');
  assert.equal(header.children[0].textContent, 'WIND AT 26.59°N 123.34°W');
  assert.equal(header.children[1].textContent, '×');
  assert.equal(header.children[1].getAttribute('aria-label'), 'Clear reading');
  assert.deepEqual(
    [...result.children[1].children[0].children].map((n) => [
      n.dataset.lineId,
      n.textContent,
    ]),
    [
      ['wind', '6.0 m/s from N'],
      ['meta', 'ECMWF · valid 09-22 06:00 UTC'],
      ['scalar', 'Wind speed · 6.0 m/s'],
      ['explanation', 'Interpolated model forecast.'],
    ],
  );
  assert.equal(
    f.find((n) => n.dataset.actionId === 'read-wind').textContent,
    'Read wind at map center',
  );
  assert.equal(
    f.find((n) => n.className === 'rail-card-action-hint').hidden,
    true,
  );
  layer.destroy();
  assert.deepEqual(
    [
      ...card(f, 'wind').querySelectorAll('.weather-card > [data-block-id]'),
    ].map((n) => n.dataset.blockId),
    ['details', 'settings', 'actions', 'reading'],
  );
  view.destroy();
});

const cyclone = {
  id: 'weather-cyclones',
  icon: '◉',
  summary: {
    label: 'Cyclones',
    compact: '3 active storms · Fay selected',
    detail: 'Fay · Advisory 3',
  },
  list: {
    items: [
      {
        id: 'fay',
        text: 'Fay · Tropical storm · 40 kt',
        active: true,
        params: { stormId: 'fay', focus: true },
      },
    ],
  },
};
const satellite = {
  id: 'weather-satellite',
  icon: '☁',
  summary: { label: 'Satellite clouds' },
};
const lightning = {
  id: 'weather-lightning',
  icon: 'ϟ',
  summary: { label: 'Lightning density' },
};

test('the briefing leads, then the active products as rows in order', () => {
  const f = fixture();
  const calls = [];
  const view = createWeatherPanel({
    ...f,
    setLayerParams: (...args) => calls.push(args),
  });
  view.update([lightning, radar, wind, cyclone, satellite]);
  const filter = f.container.querySelector('.weather-briefing');
  assert.ok(filter);
  assert.deepEqual(rowIds(f), [
    'weather-cyclones',
    'wind',
    'weather-radar',
    'weather-satellite',
    'weather-lightning',
  ]);
  assert.equal(detail(f), null, 'the list shows until a row is chosen');
  const opened = card(f, wind.id);
  assert.match(opened.querySelector('h3').textContent, /Wind motion/);
  opened.querySelector('[data-list-back]').click();
  assert.equal(detail(f), null);
  card(f, satellite.id);
  view.update([wind, cyclone]);
  assert.equal(detail(f), null, 'a product that goes off leaves the list');
  assert.deepEqual(calls, [], 'opening a product never selects a storm');
  view.update([]);
  assert.equal(f.container.querySelector('.weather-readout'), null);
  view.destroy();
});

test('from a scrolled list, a row opened by keyboard and Back keep focus on a control in view', async () => {
  const f = fixture();
  const view = createWeatherPanel({ ...f });
  view.update([lightning, radar, wind, cyclone, satellite]);
  f.container.scrollTop = 120;
  const shown = [];
  const scroll = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = function () {
    shown.push(this);
  };
  try {
    const opener = row(f, satellite.id);
    opener.focus();
    opener.click();
    await nextTick();
    await nextTick();
    const back = f.container.querySelector('[data-list-back]');
    assert.equal(document.activeElement, back, 'focus on Back');
    assert.ok(shown.includes(back), 'Back brought into view');
    back.click();
    await nextTick();
    await nextTick();
    const focused = document.activeElement;
    assert.equal(focused?.dataset.listKey, satellite.id, 'back on its row');
    assert.ok(focused.isConnected && !focused.closest('[hidden]'));
    assert.ok(shown.includes(focused), 'the row brought into view');
  } finally {
    HTMLElement.prototype.scrollIntoView = scroll;
    view.destroy();
  }
});

test('compact lines show observation age, forecast validity, storm selection or accented status', (t) => {
  t.mock.timers.enable({
    apis: ['Date'],
    now: Date.parse('2026-09-22T01:13:00Z'),
  });
  const f = fixture();
  const view = createWeatherPanel(f);
  view.update([cyclone, wind, radar]);
  const compact = (id) => row(f, id).querySelector('.weather-compact');
  assert.equal(compact(radar.id).textContent, '09-22 01:05 UTC · 8m ago');
  assert.equal(
    compact(wind.id).textContent,
    'Forecast · valid 09-22 01:00 UTC',
  );
  f.state({ mode: 'history', target: ticks[1] });
  // At a past time a frame's age counts from the timeline time.
  assert.equal(
    compact(radar.id).textContent,
    '09-22 01:05 UTC · 0m ago · synced',
  );
  assert.equal(
    compact(wind.id).textContent,
    'Forecast · valid 09-22 01:00 UTC',
  );
  assert.match(
    line(f, wind.id, 'time').textContent,
    /issued .*Does not follow history/,
  );
  f.state({
    products: [{ id: radar.id, shown: ticks[0], selected: ticks[0] }],
  });
  assert.equal(
    compact(radar.id).textContent,
    '09-22 01:00 UTC · 5m ago · nearest',
  );
  assert.equal(
    compact(cyclone.id).textContent,
    '3 active storms · Fay selected',
  );
  view.update([
    cyclone,
    wind,
    {
      ...radar,
      summary: { ...radar.summary, status: 'Map center outside coverage' },
    },
  ]);
  assert.equal(compact(radar.id).textContent, 'Map center outside coverage');
  assert.ok(compact(radar.id).classList.contains('status'));
  view.destroy();
});

test('each row shows its descriptor icon and label; details show the coverage', () => {
  const f = fixture();
  const view = createWeatherPanel(f);
  const entries = [cyclone, wind, radar, satellite, lightning];
  view.update(entries);
  for (const entry of entries) {
    const button = row(f, entry.id);
    assert.equal(button.children[0].textContent, entry.icon);
    assert.equal(button.children[1].textContent, entry.summary.label);
    assert.equal(
      card(f, entry.id).querySelector('.weather-coverage').textContent,
      entry.summary.coverage || '',
    );
  }
  view.destroy();
});
test('history time keeps the hour whatever the length of the localized date', () => {
  for (const locale of ['en', 'es', 'ru']) {
    setLocale(locale);
    try {
      const f = fixture();
      const view = createWeatherPanel(f);
      view.update([wind, radar]);
      f.state({ mode: 'history', target: ticks[1] });
      assert.equal(frameTime(f).textContent, '01:05 UTC', locale);
      assert.match(
        line(f, radar.id, 'time').textContent,
        /(^|[^\d:])01:05 UTC/,
        locale,
      );
      f.state({ products: [{ id: radar.id, shown: null, selected: null }] });
      assert.match(
        line(f, radar.id, 'time').textContent,
        /(^|[^\d:])01:05 UTC/,
        locale,
      );
      view.destroy();
    } finally {
      setLocale('en');
    }
  }
});

test('air-quality readout renders the US AQI ramp, its coverage, one index tile and a worst-first list', async () => {
  const observedMs = Date.now() - 10 * 60_000;
  /** A PM2.5 concentration (µg/m³) at a station. */
  const reading = (stationId, value, name, lat) => ({
    id: `regional:${stationId}:PM2.5`,
    provider: 'regional',
    stationId,
    name,
    zone: 'on',
    lat,
    lon: -79.38,
    parameter: 'PM2.5',
    scale: 'PM2.5',
    units: 'µg/m³',
    value,
    kind: 'observation',
    averagingMinutes: 60,
    observedMs,
    color: '#8cb4ce',
    label: String(value),
    note: null,
  });
  const layer = createAirQualityLayer({
    source: {
      definitions: [
        {
          id: 'regional',
          title: 'Ontario',
          label: 'Air quality · Ontario',
          network: 'Ontario network',
          parameters: ['PM2.5'],
        },
      ],
      getSnapshot: async () =>
        onAqiPeriods([
          reading('B', 60, 'Hamilton', 43.25),
          reading('A', 2, 'Toronto', 43.65),
        ]),
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  const viewer = {};
  bindFakeDraw(viewer);
  layer.init(viewer);
  layer.enable();
  await layer.update();
  const f = fixture();
  const view = createWeatherPanel(f);
  view.update([{ id: layer.id, icon: layer.icon, ...layer.getRowControls() }]);
  const aq = card(f, 'air-quality');
  assert.ok(aq, 'the air-quality card is shown');
  assert.match(aq.querySelector('.weather-coverage').textContent, /^Ontario$/);
  assert.match(line(f, 'air-quality', 'status').textContent, /2 stations/);
  // The US AQI as a ramp, never a band list.
  assert.equal(
    f.find((n) => n.className === 'rail-card-ramp', aq).hidden,
    false,
  );
  assert.equal(
    f.find((n) => n.className === 'rail-card-legend-entries', aq).hidden,
    true,
  );
  // The index group holds one tile, the US AQI.
  const index = f.find((n) => n.dataset.blockId === 'tiles-index', aq);
  assert.deepEqual(
    [...index.querySelectorAll('button')].map((tile) => tile.dataset.tileId),
    ['aqi'],
  );
  const list = f.find((n) => n.dataset.blockId === 'list', aq);
  assert.equal(list.hidden, false);
  // PM2.5 60 µg/m³ is a US AQI of 154; 2 µg/m³ of 11.
  assert.deepEqual(
    [...list.children].map((item) =>
      [...item.children[0].children]
        .map((part) => part.textContent)
        .filter(Boolean)
        .join(' '),
    ),
    ['154 Hamilton Unhealthy', '11 Toronto Good'],
  );
  // One line a row; the station's details are the tooltip.
  assert.match(
    list.children[0].children[0].title,
    /^Unhealthy · Hamilton · on · Ontario network · NowCast of recent hourly means · /,
  );
  view.destroy();
  layer.destroy();
});
test('source-supplied legend units are shown as given; catalog units are translated', () => {
  setLocale('ru');
  try {
    const f = fixture();
    const view = createWeatherPanel(f);
    const row = (summary) => ({
      ...radar,
      summary: { ...radar.summary, units: 'km/h', ...summary },
      legend: [
        { label: '1', color: '#000000' },
        { label: '2', color: '#ffffff' },
      ],
    });
    const scale = () =>
      f.find((n) => n.className === 'rail-card-scale').textContent;
    view.update([row()]);
    assert.equal(scale(), '1 — 2 км/ч');
    view.update([row({ unitsVerbatim: true })]);
    assert.equal(scale(), '1 — 2 km/h');
    view.destroy();
  } finally {
    setLocale('en');
  }
});

test('at a past time, frame ages count from the timeline time, not now, and the frame time is that time', (t) => {
  t.mock.timers.enable({
    apis: ['Date'],
    now: Date.parse('2032-01-01T00:00:00Z'),
  });
  const f = fixture();
  const view = createWeatherPanel(f);
  view.update([radar]);
  f.state({
    mode: 'history',
    target: '2026-09-22T01:20:00Z',
    products: [{ id: radar.id, shown: ticks[1], selected: ticks[1] }],
  });
  assert.equal(
    line(f, radar.id, 'time').textContent,
    '09-22 01:05 UTC · 15m ago · nearest',
  );
  // The panel's frame time is the timeline time alone, with no age.
  assert.equal(frameTime(f).textContent, '01:20 UTC');
  view.destroy();
});

test('the wind card notes it stays live only while its source does not follow the timeline', () => {
  const f = fixture();
  const following = new Set();
  f.clock.follows = (id) => following.has(id);
  const view = createWeatherPanel(f);
  view.update([wind, radar]);
  f.state({ mode: 'history', target: ticks[1] });
  assert.match(line(f, 'wind', 'time').textContent, /Does not follow history/);
  following.add('wind');
  f.state({ target: ticks[0] });
  assert.match(line(f, 'wind', 'time').textContent, /^Forecast · valid /);
  assert.doesNotMatch(
    line(f, 'wind', 'time').textContent,
    /Does not follow history/,
  );
  view.destroy();
});

const section = (f, id) => f.find((n) => n.dataset?.sectionId === id);
const sectionIds = (f) =>
  [...f.find((n) => n.className === 'weather-briefing').children].map(
    (n) => n.dataset.sectionId,
  );
const sectionLines = (f, id) =>
  [...section(f, id).querySelectorAll('.rail-card-line')].map(
    (n) => n.textContent,
  );
const readWind = {
  id: 'read-wind',
  label: 'Read wind at map center',
  params: { inspect: true },
};
const radarWithLegend = {
  ...radar,
  legend: [
    { label: '5', color: '#04e9e7' },
    { label: '60', color: '#fdf8fd' },
  ],
  summary: {
    ...radar.summary,
    units: 'dBZ',
    status: 'Map center outside coverage',
  },
};
const readWindEntry = {
  ...wind,
  summary: {
    ...wind.summary,
    actions: [readWind],
    result: {
      id: 'reading',
      label: 'WIND AT 29.93°N 97.74°W',
      lines: [
        { id: 'wind', text: '12.0 km/h from NW' },
        { id: 'meta', text: 'GFS · valid 09-22 01:00 UTC' },
        { id: 'scalar', text: 'Air temperature · 2 m · 21.5 °C' },
        { id: 'explanation', text: 'Model forecast' },
      ],
    },
  },
};
const calmSeas = {
  id: 'weather-cyclones',
  icon: '◉',
  summary: { label: 'Cyclones', detail: 'No active NHC/CPHC systems' },
  list: { items: [] },
};

test('the briefing reads conditions, observed frames with the radar legend, wind, then alerts, in plain statuses', (t) => {
  t.mock.timers.enable({
    apis: ['Date'],
    now: Date.parse('2026-09-22T01:09:00Z'),
  });
  const f = fixture();
  const view = createWeatherPanel(f);
  view.update([calmSeas, lightning, radarWithLegend, readWindEntry]);
  assert.deepEqual(sectionIds(f), ['here', 'observed', 'wind', 'alerts']);
  assert.deepEqual(
    [...f.container.querySelectorAll('.weather-briefing-section > h3')].map(
      (n) => n.textContent,
    ),
    ['WIND AT 29.93°N 97.74°W', 'Observed', 'Wind', 'Alerts'],
  );
  // Temperature before wind; the model and explanation stay in the card.
  assert.deepEqual(sectionLines(f, 'here'), [
    'Air temperature · 2 m · 21.5 °C',
    '12.0 km/h from NW',
  ]);
  assert.deepEqual(sectionLines(f, 'observed'), [
    'Rain radar · 4 min ago',
    'Map center outside coverage',
    'Lightning density · Waiting for observation',
  ]);
  const legend = section(f, 'observed').querySelector('.rail-card-legend');
  assert.equal(legend.hidden, false);
  assert.equal(
    [...section(f, 'observed').children].indexOf(legend),
    2,
    'the radar legend follows the radar line',
  );
  assert.equal(sectionLines(f, 'wind').length, 1);
  assert.match(sectionLines(f, 'wind')[0], /^Forecast · valid .*01:00 UTC$/);
  assert.deepEqual(sectionLines(f, 'alerts'), ['No active NHC/CPHC systems']);
  // Plain statuses: no section says a value is missing.
  for (const id of sectionIds(f))
    for (const text of sectionLines(f, id))
      assert.doesNotMatch(text, /unavailable|no value|—/i, text);
  // The newer selected frame fails to load. The radar still shows the older one.
  t.mock.timers.setTime(Date.parse('2026-09-22T02:15:00Z'));
  f.state({
    products: [{ id: radar.id, shown: ticks[0], selected: ticks[1] }],
  });
  assert.equal(sectionLines(f, 'observed')[0], 'Rain radar · 1h 15m ago');
  f.state({
    products: [{ id: radar.id, shown: ticks[1], selected: ticks[1] }],
  });
  assert.equal(sectionLines(f, 'observed')[0], 'Rain radar · 1h 10m ago');
  // At a past time: the frame's clock time, or a plain status without one.
  f.state({ mode: 'history', target: ticks[1] });
  assert.equal(sectionLines(f, 'observed')[0], 'Rain radar · 01:05 UTC');
  f.state({
    products: [{ id: radar.id, shown: null, selected: null }],
  });
  assert.equal(
    sectionLines(f, 'observed')[0],
    'Rain radar · No frame at this time',
  );
  assert.ok(
    sectionLines(f, 'wind').includes('Forecast · does not follow history'),
  );
  view.destroy();
});

test('the briefing offers the wind reading at the map center, and its rows act on their own layer', () => {
  const f = fixture();
  const calls = [];
  const view = createWeatherPanel({
    ...f,
    setLayerParams: (...args) => calls.push(args),
  });
  view.update([
    cyclone,
    { ...wind, summary: { ...wind.summary, actions: [readWind] } },
  ]);
  assert.deepEqual(sectionIds(f), ['here', 'wind', 'alerts']);
  assert.equal(
    section(f, 'here').querySelector('h3').textContent,
    'At map center',
  );
  const read = section(f, 'here').querySelector('[data-action-id="read-wind"]');
  assert.equal(read.textContent, 'Read wind at map center');
  read.click();
  section(f, 'alerts')
    .querySelector('[data-list-item-id="fay"] button')
    .click();
  assert.deepEqual(calls, [
    ['wind', { inspect: true }, { origin: 'user' }],
    ['weather-cyclones', { stormId: 'fay', focus: true }, { origin: 'user' }],
  ]);
  // A wind field still loading says so rather than showing an empty time.
  view.update([
    { ...wind, summary: { label: 'Wind motion', status: 'Loading forecast' } },
  ]);
  assert.deepEqual(sectionLines(f, 'wind'), ['Loading forecast']);
  // With no layer behind any section the briefing is hidden.
  view.update([{ id: 'air-quality', icon: '◌', summary: { label: 'AQ' } }]);
  assert.equal(f.find((n) => n.className === 'weather-briefing').hidden, true);
  view.destroy();
});

test('the briefing keeps keyboard focus on Read wind when its reading arrives', () => {
  const f = fixture();
  const requests = [];
  const view = createWeatherPanel({
    ...f,
    setLayerParams: (...args) => requests.push(args),
  });
  view.update([{ ...wind, summary: { ...wind.summary, actions: [readWind] } }]);
  const here = section(f, 'here');
  const read = here.querySelector('[data-action-id="read-wind"]');
  read.focus();
  assert.ok(f.document.activeElement === read);
  read.click();
  view.update([readWindEntry]);
  assert.ok(here.querySelector('[data-action-id="read-wind"]') === read);
  assert.ok(f.document.activeElement === read);
  assert.equal(here.getAttribute('aria-live'), 'polite');
  assert.ok(sectionLines(f, 'here').includes('12.0 km/h from NW'));
  read.click();
  assert.deepEqual(requests, [
    ['wind', { inspect: true }, { origin: 'user' }],
    ['wind', { inspect: true }, { origin: 'user' }],
  ]);
  view.destroy();
});

test('only a newly selected station opens the Air Quality detail in Context', () => {
  const f = fixture(),
    panel = createWeatherPanel(f);
  const station = (key) => ({
    id: 'air-quality',
    summary: {
      label: 'Air Quality',
      result: key ? { id: 'station', lead: true, key, label: 'Station' } : null,
    },
  });
  panel.update([station(null), wind]);
  card(f, wind.id);
  panel.update([station('a'), wind]);
  assert.ok(detail(f).querySelector('[data-card-id="air-quality"]'));
  card(f, wind.id);
  panel.update([station('a'), wind]);
  assert.ok(detail(f).querySelector('[data-card-id="wind"]'));
  panel.update([station('b'), wind]);
  assert.ok(detail(f).querySelector('[data-card-id="air-quality"]'));
  panel.destroy();
});
