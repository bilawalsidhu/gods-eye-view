import '../testSupport/registerDom.mjs';
import test from 'node:test';
import { setLocale } from '../i18n/index.js';
import assert from 'node:assert/strict';
import { assertSameNode } from '../testSupport/domAssert.mjs';
import { nextTick } from 'vue';
import { createRailCards } from './railCards.js';
import { createWeatherPanel } from './weatherPanel.js';
import { railDocumentFixture as railFixture } from './railTestFixture.mjs';

const legend = {
  colors: ['#112233', '#ffffff', '#abcdef'],
  labels: ['-10', '0', '10'],
  units: '°C',
  zeroIndex: 1,
};
const card = {
  id: 'a',
  title: 'Temperature',
  badge: 'Global',
  open: true,
  blocks: [
    { id: 'details', type: 'lines', lines: [{ id: 'status', text: '' }] },
    { id: 'legend', type: 'legend', legend },
    {
      id: 'actions',
      type: 'actions',
      actions: [{ id: 'view', label: 'View coverage' }],
    },
  ],
};
test('keyed cards and optional blocks reorder without redundant writes', () => {
  const f = railFixture();
  const view = createRailCards(f);
  view.update([card]);
  const article = f.container.children[0];
  assert.equal(article.tagName, 'ARTICLE');
  const header = article.children[0];
  assert.equal(header.tagName, 'BUTTON');
  assert.equal(header.getAttribute('aria-expanded'), 'true');
  assert.ok(header.getAttribute('aria-controls'));
  for (const cards of [
    [card],
    [
      {
        ...card,
        blocks: [
          { id: 'summary', type: 'summary', text: '<img onerror=alert(1)>' },
        ],
      },
    ],
    [card, { ...card, id: 'b', open: false }],
    [{ ...card, id: 'b' }, card],
    [],
  ]) {
    view.update(cards);
    f.writes();
    view.update(cards);
    assert.equal(f.writes(), 0);
  }
  view.update([{ ...card, blocks: [...card.blocks].reverse() }]);
  assert.deepEqual(
    [...f.container.children[0].children[1].children].map(
      (n) => n.dataset.blockId,
    ),
    ['actions', 'legend', 'details'],
  );
  view.destroy();
  assert.equal(f.container.children.length, 0);
  assert.equal(createRailCards(), null);
});
test('footer buttons retain focus and current callbacks; links use safe new tabs', () => {
  const f = railFixture();
  const view = createRailCards(f);
  const calls = [];
  const model = (actions) => ({
    ...card,
    blocks: [{ id: 'actions', type: 'actions', actions }],
  });
  view.update([
    model([{ id: 'view', label: 'First', onClick: () => calls.push(1) }]),
  ]);
  const button = f.find((n) => n.dataset.actionId === 'view');
  button.focus();
  view.update([
    model([
      {
        id: 'view',
        label: 'Read wind here',
        hint: 'at map center',
        onClick: () => calls.push(2),
      },
      {
        id: 'link',
        label: 'Official advisory ↗',
        href: 'https://example.org/advisory',
      },
    ]),
  ]);
  assertSameNode(f.document.activeElement, button);
  assert.equal(button.parentElement.tagName, 'FOOTER');
  assert.equal(
    f.find((n) => n.className === 'rail-card-action-hint').textContent,
    'at map center',
  );
  button.click();
  assert.deepEqual(calls, [2]);
  const link = f.find((n) => n.dataset.actionId === 'link');
  assert.equal(link.tagName, 'A');
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener');
  view.update([
    model([
      {
        id: 'view',
        label: 'Read wind here',
        disabled: true,
        onClick: () => calls.push(3),
      },
    ]),
  ]);
  button.click();
  assert.deepEqual(calls, [2]);
  view.destroy();
  button.click();
  assert.deepEqual(calls, [2]);
});
test('a live setting range whose owner clamps shows the clamped value', async () => {
  const f = railFixture();
  const model = (value) => ({
    ...card,
    blocks: [
      {
        id: 'settings',
        type: 'settings',
        settings: [
          {
            id: 'image',
            label: 'IMAGE',
            range: {
              id: 'gain',
              param: 'gain',
              min: 0,
              max: 100,
              step: 1,
              value,
              ariaLabel: 'Gain',
            },
          },
        ],
      },
    ],
  });
  // The owner takes at most 80 and answers at once.
  const view = createRailCards({
    ...f,
    onParams: (_id, params) => view.update([model(Math.min(80, params.gain))]),
  });
  view.update([model(80)]);
  await nextTick();
  const slider = f.find((node) => node.dataset.rangeId === 'gain');
  slider.value = '95';
  slider.dispatchEvent(new Event('input'));
  await nextTick();
  assert.equal(slider.value, '80');
  view.destroy();
});
test('setting ranges stay below presets and commit expensive filters on release', async () => {
  const f = railFixture();
  const calls = [];
  const view = createRailCards({
    ...f,
    onParams: (...args) => calls.push(args),
  });
  const model = (value) => ({
    ...card,
    blocks: [
      {
        id: 'settings',
        type: 'settings',
        settings: [
          {
            id: 'image',
            label: 'IMAGE',
            chips: [
              {
                id: 'clouds-only',
                label: 'Clouds only',
                params: { infrared: 100 },
              },
              { id: 'full', label: 'Full', params: { infrared: 0 } },
            ],
            range: {
              id: 'cloud-filter',
              param: 'infrared',
              min: 0,
              max: 100,
              step: 1,
              value,
              label: 'FILTER',
              unit: '%',
              ariaLabel: 'Cloud filter strength',
              commitOnChange: true,
            },
          },
        ],
      },
    ],
  });
  view.update([model(100)]);
  const setting = f.find((node) => node.dataset.blockId === 'image');
  assert.equal(setting.children[1].className, 'rail-card-chips');
  assert.equal(setting.children[2].className, 'rail-card-setting-range-row');
  assert.equal(setting.children[2].children[0].textContent, 'FILTER');
  const slider = f.find((node) => node.dataset.rangeId === 'cloud-filter');
  assert.equal(slider.tagName, 'INPUT');
  assert.equal(slider.type, 'range');
  assert.equal(slider.min, '0');
  assert.equal(slider.max, '100');
  assert.equal(slider.step, '1');
  assert.equal(slider.value, '100');
  assert.equal(slider.getAttribute('aria-label'), 'Cloud filter strength');
  slider.focus();
  slider.value = '53';
  slider.dispatchEvent(new Event('input'));
  await nextTick();
  assert.equal(calls.length, 0, 'expensive image work waits until release');
  assert.equal(
    f.find((node) => node.className === 'rail-card-setting-range-value')
      .textContent,
    '53%',
  );
  view.update([model(100)]);
  assert.equal(slider.value, '53', 'a status refresh retains the pending drag');
  assert.equal(
    slider.getAttribute('aria-valuetext'),
    '53%',
    'the accessible preview also survives a refresh',
  );
  slider.dispatchEvent(new Event('change'));
  assert.deepEqual(calls.at(-1), ['a', { infrared: 53 }]);
  await nextTick();
  assert.equal(slider.value, '53', 'release keeps the handle until the owner');
  view.update([model(53)]);
  assert.equal(slider.value, '53');
  assertSameNode(f.document.activeElement, slider);
  slider.value = '41';
  slider.dispatchEvent(new Event('input'));
  await nextTick();
  view.update([model(70)]);
  assert.equal(
    slider.value,
    '70',
    'an authoritative value supersedes the draft',
  );
  view.destroy();
  slider.value = '41';
  slider.dispatchEvent(new Event('change'));
  assert.equal(calls.length, 1, 'destroy removes the range listener');
});
test('controls of a removed block dispatch nothing', () => {
  const f = railFixture();
  const calls = [];
  const view = createRailCards({
    ...f,
    onParams: (...args) => calls.push(args),
  });
  const actions = {
    id: 'actions',
    type: 'actions',
    actions: [{ id: 'go', label: 'Go', params: { go: 1 } }],
  };
  view.update([{ ...card, blocks: [actions] }]);
  const button = f.find((node) => node.dataset.actionId === 'go');
  view.update([{ ...card, blocks: [] }]);
  button.click();
  assert.deepEqual(calls, []);
  view.update([{ ...card, blocks: [{ ...actions }] }]);
  f.find((node) => node.dataset.actionId === 'go').click();
  assert.deepEqual(calls, [['a', { go: 1 }]]);
  view.destroy();
});

test('legend validates colors, preserves the freezing anchor and ignores CSSOM normalization', () => {
  const f = railFixture();
  const view = createRailCards(f);
  const show = (legend) =>
    view.update([
      { ...card, blocks: [{ id: 'legend', type: 'legend', legend }] },
    ]);
  show(legend);
  const zero = f.find((n) => n.className === 'rail-card-zero');
  const ramp = f.find((n) => n.className === 'rail-card-ramp');
  assert.equal(zero.hidden, false);
  assert.equal(zero.style.left, '50%');
  // An unchanged legend writes nothing, whatever the browser normalizes the
  // colors it reads back to.
  f.writes();
  show(legend);
  assert.equal(f.writes(), 0);
  show({
    ...legend,
    colors: Array(10).fill('#abcdef'),
    labels: Array.from({ length: 10 }, (_, i) => String(i * 10 - 40)),
    zeroIndex: 4,
  });
  assert.ok(Math.abs(parseFloat(zero.style.left) - 44.444444) < 0.001);
  show({ ...legend, units: 'km/h' });
  assert.equal(zero.hidden, true);
  show({ ...legend, colors: ['url(https://example.org)', '#ffffff'] });
  assert.equal(ramp.hidden, true);
  assert.equal(ramp.style.background, '');
  view.destroy();
});
test('labelled rows, lists and results retain focus and dispatch current params', () => {
  const f = railFixture();
  const calls = [];
  const view = createRailCards({
    ...f,
    onParams: (...args) => calls.push(args),
  });
  const model = (paused = false) => ({
    ...card,
    blocks: [
      {
        id: 'storms',
        type: 'list',
        list: {
          ariaLabel: 'Storms',
          items: [
            {
              id: 'a',
              text: 'Storm A',
              active: !paused,
              params: { stormId: 'a', focus: true },
            },
            {
              id: 'b',
              text: 'Storm B',
              active: paused,
              params: { stormId: 'b', focus: true },
            },
          ],
        },
      },
      {
        id: 'settings',
        type: 'settings',
        settings: [
          {
            id: 'motion',
            label: 'MOTION',
            chips: [
              {
                id: 'motion',
                label: paused ? 'Resume' : 'Pause',
                params: { paused: !paused },
              },
            ],
          },
        ],
      },
      {
        id: 'reading',
        type: 'result',
        label: 'WIND AT SAMPLED LOCATION · 41°N 87°W',
        lines: [{ id: 'wind', text: '<b>18 km/h</b>' }],
        clear: { params: { inspect: false } },
      },
    ],
  });
  view.update([model()]);
  const setting = f.find((n) => n.dataset.blockId === 'motion');
  assert.equal(setting.children[0].textContent, 'MOTION');
  assert.equal(setting.children[1].getAttribute('role'), 'group');
  assert.equal(setting.children[1].getAttribute('aria-label'), 'MOTION');
  const chip = f.find((n) => n.dataset.chipId === 'motion');
  chip.focus();
  view.update([model(true)]);
  assertSameNode(f.document.activeElement, chip);
  chip.click();
  assert.deepEqual(calls.at(-1), ['a', { paused: false }]);
  const storm = f.find(
    (n) => n.tagName === 'BUTTON' && n.dataset.listItemId === 'b',
  );
  assert.equal(storm.getAttribute('aria-pressed'), 'true');
  storm.click();
  assert.deepEqual(calls.at(-1), ['a', { stormId: 'b', focus: true }]);
  const clear = f.find((n) => n.dataset.actionId === 'clear');
  assert.equal(clear.textContent, '×');
  assert.equal(clear.getAttribute('aria-label'), 'Clear reading');
  clear.click();
  assert.deepEqual(calls.at(-1), ['a', { inspect: false }]);
  assert.equal(f.find((n) => n.dataset.lineId === 'wind').children.length, 0);
  f.writes();
  view.update([model(true)]);
  assert.equal(f.writes(), 0);
  view.destroy();
  const before = calls.length;
  chip.click();
  clear.click();
  storm.click();
  assert.equal(calls.length, before);
});

const tilesBlock = (active = 'aqi') => ({
  id: 'tiles-index',
  type: 'tiles',
  title: 'Pollutants',
  subtitle: 'nearest station · Cape Town',
  tiles: [
    {
      id: 'aqi',
      value: '56',
      note: 'Moderate',
      label: 'US AQI',
      title: 'US AQI · Moderate',
      accent: '#ffff00',
      active: active === 'aqi',
      params: { view: 'aqi' },
    },
    {
      id: 'PM2.5',
      value: '12',
      label: 'PM2.5',
      accent: '#6b7785',
      active: active === 'PM2.5',
      params: { view: 'PM2.5' },
    },
  ],
});

test('a tiles block draws one button per tile with its value, bracketed note and label', () => {
  const f = railFixture();
  const view = createRailCards(f);
  view.update([{ ...card, blocks: [tilesBlock()] }]);
  const block = f.find((n) => n.dataset.blockId === 'tiles-index');
  // The Globe view's worldwide tiles, two to a row.
  assert.ok(block.classList.contains('view-context__world'));
  assert.equal(block.querySelector('h4').firstChild.textContent, 'Pollutants');
  assert.equal(
    block.querySelector('.rail-card-tiles-sub').textContent,
    'nearest station · Cape Town',
  );
  const tiles = [...block.querySelectorAll('button')];
  assert.deepEqual(
    tiles.map((tile) => tile.dataset.tileId),
    ['aqi', 'PM2.5'],
  );
  assert.ok(
    tiles.every((tile) => tile.classList.contains('view-context__world-tile')),
  );
  const [aqi, pm25] = tiles;
  assert.equal(aqi.querySelector('strong').textContent, '56 (Moderate)');
  assert.equal(aqi.querySelector('span').textContent, 'US AQI');
  assert.equal(aqi.title, 'US AQI · Moderate');
  // A band-colour bar stands where the Globe view tile has its icon.
  assert.match(
    aqi.querySelector('.rail-card-tile-swatch').style.background,
    /^(#ffff00|rgb\(255, 255, 0\))$/,
  );
  assert.equal(pm25.querySelector('strong').textContent, '12');
  assert.equal(aqi.getAttribute('aria-pressed'), 'true');
  assert.ok(aqi.classList.contains('is-active'));
  assert.equal(pm25.getAttribute('aria-pressed'), 'false');
  f.writes();
  view.update([{ ...card, blocks: [tilesBlock()] }]);
  assert.equal(f.writes(), 0);
  view.destroy();
});

test('a group of one tile fills its row; a group of two shares it', async () => {
  // The Index group holds one tile, the US AQI: it spans both columns.
  const { readFileSync } = await import('node:fs');
  const style = document.createElement('style');
  style.textContent = readFileSync(
    new URL('./styles/weather.css', import.meta.url),
    'utf8',
  );
  document.head.appendChild(style);
  try {
    const f = railFixture();
    const view = createRailCards(f);
    const [aqi, pm25] = tilesBlock().tiles;
    const span = () =>
      [...f.container.querySelectorAll('[data-tile-id]')].map((tile) => [
        tile.dataset.tileId,
        getComputedStyle(tile).gridColumn,
      ]);
    view.update([{ ...card, blocks: [{ ...tilesBlock(), tiles: [aqi] }] }]);
    assert.deepEqual(span(), [['aqi', '1 / -1']]);
    view.update([{ ...card, blocks: [tilesBlock()] }]);
    await nextTick();
    assert.deepEqual(
      span().map(([id, column]) => [id, column || 'auto']),
      [
        ['aqi', 'auto'],
        [pm25.id, 'auto'],
      ],
    );
    view.destroy();
  } finally {
    style.remove();
  }
});

test('a tile click dispatches its params', () => {
  const f = railFixture();
  const calls = [];
  const view = createRailCards({
    ...f,
    onParams: (...args) => calls.push(args),
  });
  view.update([{ ...card, blocks: [tilesBlock()] }]);
  f.find((n) => n.dataset.tileId === 'PM2.5').click();
  assert.deepEqual(calls, [['a', { view: 'PM2.5' }]]);
  view.update([{ ...card, blocks: [tilesBlock('PM2.5')] }]);
  assert.ok(
    f.find((n) => n.dataset.tileId === 'PM2.5').classList.contains('is-active'),
  );
  view.destroy();
});

test('a toggle block flips aria-checked and dispatches its params', () => {
  const f = railFixture();
  const calls = [];
  const view = createRailCards({
    ...f,
    onParams: (...args) => calls.push(args),
  });
  const toggle = (on) => ({
    id: 'toggle-stations',
    type: 'toggle',
    label: 'STATIONS',
    on,
    params: { stations: !on },
  });
  view.update([{ ...card, blocks: [toggle(true)] }]);
  const block = f.find((n) => n.dataset.blockId === 'toggle-stations');
  assert.equal(block.textContent.trim(), 'STATIONS');
  const button = block.querySelector('button');
  assert.equal(button.getAttribute('role'), 'switch');
  assert.equal(button.getAttribute('aria-checked'), 'true');
  assert.equal(button.getAttribute('aria-label'), 'STATIONS');
  button.click();
  assert.deepEqual(calls, [['a', { stations: false }]]);
  view.update([{ ...card, blocks: [toggle(false)] }]);
  assertSameNode(block.querySelector('button'), button);
  assert.equal(button.getAttribute('aria-checked'), 'false');
  button.click();
  assert.deepEqual(calls.at(-1), ['a', { stations: true }]);
  view.destroy();
});

test('a lead result renders first', () => {
  const f = railFixture();
  const entry = (lead) => ({
    id: 'air-quality',
    icon: '◍',
    summary: {
      label: 'Air quality',
      status: '2 stations reporting',
      toggles: [{ id: 'stations', label: 'STATIONS', on: true, params: {} }],
      result: {
        id: 'station',
        lead,
        label: 'Cape Town',
        clear: { label: 'Deselect station', params: { station: null } },
        lines: [{ id: 'station-source', muted: true, text: 'Measured' }],
      },
    },
    legend: [
      { color: '#00e400', label: 'Good' },
      { color: '#ffff00', label: 'Moderate' },
    ],
    legendCategorical: true,
    sublists: [
      { ...tilesBlock(), id: 'index' },
      { id: 'empty', title: 'None', tiles: [] },
    ],
    list: {
      title: 'HIGHEST IN VIEW',
      ariaLabel: 'Observations in view',
      items: [{ id: 'cape-town', lead: '56', text: 'Cape Town' }],
    },
  });
  const panel = createWeatherPanel({ container: f.container });
  const order = () =>
    [
      ...f.container.querySelectorAll(
        '[data-card-id="air-quality"] [data-block-id]',
      ),
    ]
      .map((node) => node.dataset.blockId)
      .filter((id, index, all) => all.indexOf(id) === index);
  panel.update([entry(true)]);
  // The selected station heads the card; the tiles follow the details and
  // legend; the ranked list, under its title, comes last.
  assert.deepEqual(order(), [
    'station',
    'result-lines',
    'details',
    'toggle-stations',
    'legend',
    'tiles-index',
    'list-title',
    'list',
  ]);
  // The heading result is framed by its class, and its close button says
  // what it lets go of.
  const head = f.container.querySelector(
    '[data-card-id="air-quality"] .rail-card-result',
  );
  assert.ok(head.classList.contains('is-lead'));
  const close = head.querySelector('[data-action-id="clear"]');
  assert.equal(close.getAttribute('aria-label'), 'Deselect station');
  panel.update([entry(false)]);
  assert.ok(
    !f.container
      .querySelector('[data-card-id="air-quality"] .rail-card-result')
      .classList.contains('is-lead'),
  );
  assert.equal(order()[0], 'details');
  assert.equal(order().at(-2), 'station');
  panel.destroy();
});

test('a list row draws its colour dot before its value; a bad colour draws none', () => {
  const f = railFixture();
  const view = createRailCards(f);
  const paint = (swatch) =>
    view.update([
      {
        ...card,
        blocks: [
          {
            id: 'list',
            type: 'list',
            list: {
              ariaLabel: 'Highest in view',
              items: [
                {
                  id: 'durban',
                  swatch,
                  lead: '112',
                  text: 'Durban',
                  title: 'Durban · details',
                },
              ],
            },
          },
        ],
      },
    ]);
  paint('#ff7e00');
  const row = f.container.querySelector('.data-row-list-item');
  const [dot, lead, text] = row.children;
  assert.ok(dot.classList.contains('data-row-list-swatch'));
  assert.equal(dot.getAttribute('aria-hidden'), 'true');
  assert.match(dot.style.background, /^(#ff7e00|rgb\(255, 126, 0\))$/);
  assert.equal(lead.textContent, '112');
  assert.equal(text.textContent, 'Durban');
  // The details are the tooltip, not a second line.
  assert.equal(row.title, 'Durban · details');
  assert.equal(row.querySelector('.data-row-list-badge'), null);
  paint('url(https://example.com)');
  assert.equal(row.querySelector('.data-row-list-swatch'), null);
  view.destroy();
});

test("a result's title is its header's tooltip", () => {
  const f = railFixture();
  const view = createRailCards(f);
  const paint = (title) =>
    view.update([
      {
        ...card,
        blocks: [
          {
            id: 'station',
            type: 'result',
            lead: true,
            label: 'Cape Town',
            title,
            lines: [{ id: 'station-source', muted: true, text: 'Measured' }],
          },
        ],
      },
    ]);
  paint('NATIONAL · Licence: CC BY 4.0 (City of Cape Town)');
  const label = f.container.querySelector(
    '.rail-card-result-header .panel-title',
  );
  assert.equal(label.textContent, 'Cape Town');
  assert.equal(
    label.title,
    'NATIONAL · Licence: CC BY 4.0 (City of Cape Town)',
  );
  paint(undefined);
  assert.equal(label.getAttribute('title'), null);
  view.destroy();
});

test('clearing a lead result keeps focus in the card', (t) => {
  const f = railFixture(),
    view = createRailCards(f);
  t.after(() => view.destroy());
  for (const [active, tile, selector] of [
    [true, true, '.data-row-list-item.active'],
    [false, true, '.rail-card-tile.is-active'],
    [false, false, '.rail-card-header'],
  ]) {
    view.update([
      {
        ...card,
        blocks: [
          {
            id: 'station',
            type: 'result',
            lead: true,
            label: 'Station',
            clear: { params: { station: null } },
          },
          tilesBlock(tile ? 'aqi' : ''),
          {
            id: 'list',
            type: 'list',
            list: {
              items: [
                { id: 's', text: 'Station', active, params: { station: 's' } },
              ],
            },
          },
        ],
      },
    ]);
    const close = f.container.querySelector('[data-action-id="clear"]');
    close.focus();
    close.click();
    assertSameNode(
      close.ownerDocument.activeElement,
      f.container.querySelector(selector),
    );
  }
});
test('in Arabic a tile value and a row lead are isolated', (t) => {
  const f = railFixture(),
    view = createRailCards(f);
  t.after(() => view.destroy());
  setLocale('ar');
  try {
    const tiles = tilesBlock();
    tiles.tiles[0].value = '500+';
    view.update([
      {
        ...card,
        blocks: [
          tiles,
          {
            id: 'list',
            type: 'list',
            list: { items: [{ id: 's', lead: '500+', text: 'Station' }] },
          },
        ],
      },
    ]);
    assert.ok(
      f.container
        .querySelector('.rail-card-tile strong')
        .textContent.startsWith('\u2068500+\u2069'),
    );
    assert.equal(
      f.container.querySelector('.data-row-list-lead').textContent,
      '\u2068500+\u2069',
    );
  } finally {
    setLocale('en');
  }
});
