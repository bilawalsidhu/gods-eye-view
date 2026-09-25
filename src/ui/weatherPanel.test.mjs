import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeatherPanel } from './weatherPanel.js';
import { railFixture } from './railTestFixture.mjs';
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
function fixture(onWrite) {
  const f = railFixture(onWrite);
  const panel = f.document.createElement('div');
  const count = f.document.createElement('span');
  let collapsed = true;
  let clicks = 0;
  panel.hidden = true;
  panel.classList = { contains: () => collapsed };
  const collapse = {
    click() {
      collapsed = !collapsed;
      clicks++;
    },
  };
  panel.querySelector = (selector) =>
    selector === '#weather-panel-count' ? count : collapse;
  f.container.closest = () => panel;
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
    setTarget: (tick) => calls.push(['target', tick]),
    latest: () => calls.push(['latest']),
    togglePlay: () => calls.push(['play']),
    step: (n) => calls.push(['step', n]),
  };
  return {
    ...f,
    panel,
    count,
    collapse,
    clicks: () => clicks,
    calls,
    listeners,
    clock,
    state: (next) => {
      state = { ...state, ...next };
      for (const fn of listeners) fn(state);
    },
  };
}
const timelineHost = (f) =>
  f.find((n) => n.className === 'weather-timeline-block');
const card = (f, id) => f.find((n) => n.dataset.cardId === id);
const line = (f, id, name) =>
  f.find((n) => n.dataset.lineId === name, card(f, id));
test('timeline stays visible with any observed product; native preview and transport use the clock', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const view = createWeatherPanel(f);
  view.update([wind]);
  assert.equal(timelineHost(f).hidden, true);
  view.update([wind, radar]);
  assert.equal(timelineHost(f).hidden, false);
  f.state({ timeline: [ticks[0]] });
  assert.equal(timelineHost(f).hidden, false);
  assert.equal(f.find((n) => n.tagName === 'INPUT').disabled, true);
  f.state({ timeline: [] });
  assert.equal(timelineHost(f).hidden, false);
  f.state({ timeline: ticks });
  assert.equal(timelineHost(f).hidden, false);
  const slider = f.find((n) => n.tagName === 'INPUT');
  slider.value = '0';
  slider.dispatchEvent(new Event('input'));
  assert.deepEqual(f.calls, []);
  slider.dispatchEvent(new Event('change'));
  assert.deepEqual(f.calls, [['target', ticks[0]]]);
  f.find((n) => n.textContent === 'Latest' && n.tagName === 'BUTTON').click();
  f.find((n) => n.textContent === 'Play').click();
  assert.deepEqual(f.calls.slice(1), [['latest'], ['play']]);
  slider.dispatchEvent(new Event('input'));
  view.update([wind]);
  t.mock.timers.tick(150);
  assert.equal(f.calls.length, 3, 'hiding cancels pending drag');
  view.destroy();
  assert.equal(f.listeners.size, 0);
});
test('ordered articles omit Controls and retain history labels, forecast dates and missing-frame readouts', () => {
  const f = fixture();
  const view = createWeatherPanel(f);
  view.update([radar, wind]);
  const windCard = card(f, 'wind');
  assert.equal(windCard.tagName, 'ARTICLE');
  assert.equal(windCard.parent.children[0], windCard);
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
    legend: [
      { label: 'Advisory center / forecast track', color: '#7fe6ed' },
      { label: 'Center-track uncertainty cone', color: '#7fe6ed44' },
    ],
  };
  view.update([cyclone]);
  assert.equal(timelineHost(f).hidden, true);
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
  const link = f.find((n) => n.textContent === 'Official advisory ↗');
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
test('identical updates write nothing and status keeps its line through loading and empty text', () => {
  let writes = 0;
  const f = fixture(() => writes++);
  const view = createWeatherPanel(f);
  for (const entries of [
    [wind, radar],
    [{ ...wind, summary: { ...wind.summary, status: 'Loading' } }],
    [wind],
    [],
  ]) {
    view.update(entries);
    const status = entries.length ? line(f, 'wind', 'status') : null;
    writes = 0;
    view.update(entries);
    assert.equal(writes, 0);
    if (status) {
      assert.equal(status.hidden, false);
      assert.equal(line(f, 'wind', 'status'), status);
    }
  }
  view.destroy();
  assert.equal(f.container.children.length, 0);
  assert.equal(createWeatherPanel(), null);
});
test('count, hidden-empty and first-appearance expansion survive remount and owner collapse', () => {
  const f = fixture();
  let view = createWeatherPanel(f);
  view.update([]);
  assert.equal(f.panel.hidden, true);
  assert.equal(f.clicks(), 0);
  view.update([wind, radar, { id: 'missing' }]);
  assert.equal(f.count.textContent, '2');
  assert.equal(f.panel.hidden, false);
  assert.equal(f.clicks(), 1);
  f.collapse.click();
  view.update([]);
  view.update([wind]);
  assert.equal(f.panel.classList.contains('collapsed'), true);
  assert.equal(f.clicks(), 2);
  assert.equal(f.count.textContent, '1');
  view.destroy();
  assert.equal(f.count.textContent, '0');
  assert.equal(f.panel.hidden, true);
  view = createWeatherPanel(f);
  view.update([radar]);
  assert.equal(f.panel.hidden, false);
  assert.equal(f.clicks(), 2);
  view.destroy();
  const expanded = fixture();
  expanded.collapse.click();
  const other = createWeatherPanel(expanded);
  other.update([wind]);
  assert.equal(expanded.clicks(), 1);
  other.destroy();
});

test('a stored or shared collapse choice is not overridden on first appearance', () => {
  for (const preference of ['stored', 'share']) {
    const f = fixture();
    f.panel.dataset = { collapsedPreference: preference };
    const view = createWeatherPanel(f);
    view.update([radar]);
    assert.equal(f.panel.hidden, false);
    assert.equal(
      f.clicks(),
      0,
      `${preference} preference keeps the panel collapsed`,
    );
    view.destroy();
  }
  const f = fixture();
  f.panel.dataset = { collapsedPreference: 'default' };
  const view = createWeatherPanel(f);
  view.update([radar]);
  assert.equal(f.clicks(), 1, 'a default state still expands once');
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
    result.children[1].children[0].children.map((n) => [
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
  const body = card(f, 'wind').children[1];
  assert.deepEqual(
    body.children.map((n) => n.dataset.blockId),
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
const opened = (f) =>
  [cyclone, wind, radar, satellite, lightning]
    .filter(({ id }) => card(f, id)?.dataset.open === 'true')
    .map(({ id }) => id);
const clickHeader = (f, id) => card(f, id).children[0].click();

test('cyclones lead, and observed history owns one bordered group with only active products in scope', () => {
  const f = fixture();
  const view = createWeatherPanel(f);
  view.update([lightning, radar, wind, cyclone, satellite]);
  const root = f.container.children[0];
  assert.deepEqual(
    root.children[0].children.map((n) => n.dataset.cardId),
    ['weather-cyclones', 'wind'],
  );
  const group = f.find((n) => n.className === 'weather-observed-group');
  assert.equal(root.children[1], group);
  assert.equal(group.children[0].textContent, 'Observed history');
  assert.equal(
    group.children[1].textContent,
    'Rain radar · Satellite clouds · Lightning density',
  );
  assert.equal(group.children[2], timelineHost(f));
  assert.deepEqual(
    group.children[3].children.map((n) => n.dataset.cardId),
    ['weather-radar', 'weather-satellite', 'weather-lightning'],
  );
  assert.deepEqual(opened(f), ['weather-cyclones']);
  assert.equal(
    card(f, cyclone.id).children[1].children[0].dataset.blockId,
    'storms',
  );
  view.update([wind, satellite]);
  assert.equal(group.children[1].textContent, 'Satellite clouds');
  view.update([wind]);
  assert.equal(group.hidden, true);
  view.destroy();
});

test('the panel order is cyclones, wind, radar, satellite, lightning, warnings', () => {
  const f = fixture();
  const view = createWeatherPanel(f);
  const warnings = {
    id: 'weather-alerts',
    icon: '⚠',
    summary: { label: 'Warnings · Xweather', coverage: 'US · Canada' },
  };
  view.update([warnings, lightning, radar, wind, cyclone, satellite]);
  const root = f.container.children[0];
  assert.deepEqual(
    root.children[0].children.map((n) => n.dataset.cardId),
    ['weather-cyclones', 'wind'],
  );
  const group = f.find((n) => n.className === 'weather-observed-group');
  assert.deepEqual(
    group.children[3].children.map((n) => n.dataset.cardId),
    [
      'weather-radar',
      'weather-satellite',
      'weather-lightning',
      'weather-alerts',
    ],
  );
  assert.equal(
    group.children[1].textContent,
    'Rain radar · Satellite clouds · Lightning density · Warnings',
  );
  view.update([{ ...warnings, summary: { coverage: 'US' } }]);
  assert.equal(group.hidden, false);
  assert.equal(group.children[1].textContent, 'Warnings');
  view.destroy();
});

test('the observed-history scope names each card as its source labels it', () => {
  const f = fixture();
  const view = createWeatherPanel(f);
  view.update([
    { ...radar, summary: { label: 'Rain radar · Global' } },
    { ...lightning, summary: { label: 'Lightning · 5 min flashes' } },
  ]);
  const group = f.find((n) => n.className === 'weather-observed-group');
  assert.equal(group.children[1].textContent, 'Rain radar · Lightning');
  view.update([
    radar,
    { ...lightning, summary: { label: 'Lightning density · 15 min' } },
  ]);
  assert.equal(group.children[1].textContent, 'Rain radar · Lightning density');
  view.destroy();
});

test('accordion changes only on headers, newly enabled layers and loss of the open layer', () => {
  const f = fixture();
  const calls = [];
  let view = createWeatherPanel({
    ...f,
    setLayerParams: (...args) => calls.push(args),
  });
  view.update([wind, cyclone, radar]);
  assert.deepEqual(opened(f), [cyclone.id]);
  clickHeader(f, wind.id);
  clickHeader(f, wind.id);
  assert.deepEqual(opened(f), [wind.id]);
  assert.equal(
    card(f, wind.id).children[0].getAttribute('aria-expanded'),
    'true',
  );
  assert.equal(
    card(f, cyclone.id).children[0].getAttribute('aria-expanded'),
    'false',
  );
  assert.equal(card(f, cyclone.id).children[1].hidden, true);
  assert.deepEqual(calls, [], 'opening/collapsing never selects a storm');
  f.state({ mode: 'history', target: ticks[0] });
  view.update([
    wind,
    { ...cyclone, summary: { ...cyclone.summary, status: 'Updated' } },
    radar,
  ]);
  assert.deepEqual(opened(f), [wind.id]);
  view.update([wind, cyclone, radar, lightning, satellite]);
  assert.deepEqual(opened(f), [satellite.id], 'last newly enabled entry wins');
  view.update([wind, cyclone, radar, lightning]);
  assert.deepEqual(
    opened(f),
    [cyclone.id],
    'disabled open layer falls back to first in card order',
  );
  clickHeader(f, radar.id);
  view.destroy();
  view = createWeatherPanel(f);
  view.update([]);
  view.update([wind, cyclone, radar]);
  assert.deepEqual(opened(f), [radar.id], 'explicit choice survives remount');
  view.update([]);
  view.update([wind]);
  assert.deepEqual(opened(f), [wind.id]);
  view.destroy();
});

test('first appearance without storms chooses the first card and late storm arrival never steals it', () => {
  const f = fixture();
  const view = createWeatherPanel(f);
  view.update([satellite, wind]);
  assert.deepEqual(opened(f), [wind.id]);
  view.update([satellite, wind, { ...cyclone, list: { items: [] } }]);
  assert.deepEqual(opened(f), [cyclone.id]);
  clickHeader(f, wind.id);
  view.update([satellite, wind, cyclone]);
  assert.deepEqual(opened(f), [wind.id]);
  view.destroy();
});

test('compact lines show observation age, forecast validity, storm selection or accented status', (t) => {
  t.mock.timers.enable({
    apis: ['Date'],
    now: Date.parse('2026-09-22T01:13:00Z'),
  });
  const f = fixture();
  const view = createWeatherPanel(f);
  view.update([cyclone, wind, radar]);
  const compact = (id) =>
    f.find((n) => n.className.startsWith('rail-card-compact'), card(f, id));
  assert.equal(compact(radar.id).textContent, '09-22 01:05 UTC · 8m ago');
  assert.equal(
    compact(wind.id).textContent,
    'Forecast · valid 09-22 01:00 UTC',
  );
  f.state({ mode: 'history', target: ticks[1] });
  assert.equal(
    compact(radar.id).textContent,
    '09-22 01:05 UTC · 8m ago · synced',
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
    '09-22 01:00 UTC · 13m ago · nearest',
  );
  clickHeader(f, wind.id);
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
  assert.match(compact(radar.id).className, /status/);
  view.destroy();
});

test('all five headers retain descriptor icons and disclosure state when opened or compact', () => {
  const f = fixture();
  const view = createWeatherPanel(f);
  const entries = [cyclone, wind, radar, satellite, lightning];
  view.update(entries);
  for (const active of entries) {
    clickHeader(f, active.id);
    for (const entry of entries) {
      const article = card(f, entry.id);
      const open = entry === active;
      assert.equal(article.dataset.open, String(open));
      assert.equal(article.classList.contains('is-open'), open);
      const header = article.children[0];
      const labels = header.children[0];
      const heading = labels.children[0];
      assert.equal(
        labels.children[1].textContent,
        entry.summary.coverage || '',
      );
      assert.equal(
        labels.children[1].classList.contains('rail-card-badge'),
        true,
      );
      assert.equal(header.children[1].className, 'rail-card-disclosure');
      assert.equal(heading.children[0].className, 'data-icon');
      assert.equal(heading.children[0].textContent, entry.icon);
      assert.equal(heading.children[0].hidden, false);
      assert.equal(heading.children[1].textContent, entry.summary.label);
      assert.equal(
        heading.children[1].getAttribute('title'),
        entry.summary.label,
      );
      assert.equal(
        heading.children[1].classList.contains('rail-card-nowrap'),
        true,
      );
      assert.equal(header.children[1].textContent, open ? '▾' : '▸');
    }
  }
  view.destroy();
});

test('a change of open card scrolls its header into view once; refreshes never move the body', () => {
  const f = fixture();
  const body = f.container;
  const writes = [];
  const intoView = [];
  const rects = new Map();
  let scrollTop = 240;
  Object.defineProperty(body, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value) => {
      writes.push(value);
      scrollTop = value;
    },
  });
  body.clientHeight = 200;
  body.getBoundingClientRect = () => ({ top: 100, height: 200 });
  const create = f.document.createElement;
  f.document.createElement = (tag) => {
    const node = create(tag);
    node.getBoundingClientRect = function () {
      return rects.get(this.dataset.cardId) || { top: 0, height: 0 };
    };
    node.scrollIntoView = function () {
      intoView.push(this.dataset.cardId);
    };
    return node;
  };
  // Rectangles are viewport coordinates; the body's visible top is at 100.
  const place = (id, top, height) => rects.set(id, { top: 100 + top, height });
  const view = createWeatherPanel(f);
  view.update([cyclone, wind, radar]);
  assert.deepEqual(opened(f), [cyclone.id]);

  // Plain refreshes: clock, identical and changed descriptors, the open header.
  f.state({ mode: 'history', target: ticks[0] });
  view.update([cyclone, wind, radar]);
  view.update([
    { ...cyclone, summary: { ...cyclone.summary, status: 'Updated' } },
    wind,
    radar,
  ]);
  clickHeader(f, cyclone.id);
  assert.deepEqual(writes, [], 'no scroll writes without a change of card');

  // Opened below the fold: the smallest move that shows the whole card.
  place(radar.id, 150, 120);
  clickHeader(f, radar.id);
  assert.deepEqual(opened(f), [radar.id]);
  assert.deepEqual(writes, [240 + 70], 'one write, placed by the opened card');

  // Taller than the body: the header goes to the top.
  place(wind.id, 40, 480);
  clickHeader(f, wind.id);
  assert.deepEqual(writes.slice(1), [310 + 40]);

  // Header left above the view by the collapse: back to the top edge.
  place(cyclone.id, -60, 120);
  clickHeader(f, cyclone.id);
  assert.deepEqual(writes.slice(2), [350 - 60]);

  // Already fully visible: nothing to do.
  place(radar.id, 20, 100);
  clickHeader(f, radar.id);
  assert.equal(writes.length, 3);

  // A newly enabled layer opens and is revealed the same way.
  place(lightning.id, 190, 60);
  view.update([cyclone, wind, radar, lightning]);
  assert.deepEqual(opened(f), [lightning.id]);
  assert.deepEqual(writes.slice(3), [290 + 50]);

  f.state({ mode: 'latest' });
  view.update([cyclone, wind, radar, lightning]);
  assert.equal(writes.length, 4, 'refresh after a reveal leaves it alone');
  assert.deepEqual(intoView, [], 'ancestor scrollers are never moved');
  view.destroy();
});
