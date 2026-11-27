import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { nextTick } from 'vue';
import { presentStreetLevel } from './streetLevelPresentation.js';
import { streetLevelRowControls } from './streetLevelRowControls.js';
import { providerSnapshot } from '../testSupport/streetLevelFakes.mjs';

test('panel presentation places Transit and Rail between Street Traffic and Bike Share in Movement', () => {
  const source = readFileSync(
    new URL('./layerPanel.js', import.meta.url),
    'utf8',
  );
  const declarations = source.slice(
    source.indexOf('const PANEL_GROUPS ='),
    source.indexOf('const PANEL_POSITIONS ='),
  );
  const order = JSON.parse(
    runInNewContext(
      `const msg = (text) => text;\n${declarations}\nJSON.stringify(PANEL_ORDER)`,
    ),
  );
  assert.deepEqual(
    order.filter(({ label }) => label === 'Movement').map(({ id }) => id),
    [
      'satellites',
      'flights',
      'military',
      'local-adsb',
      'ais-live-vessels',
      'traffic',
      'transit',
      'rail',
      'bikeshare',
    ],
  );
  assert.equal(order.filter(({ id }) => id === 'transit').length, 1);
  assert.equal(order.filter(({ id }) => id === 'rail').length, 1);
});

test('Wildlife follows Events and precedes Weather', () => {
  const source = readFileSync(
    new URL('./layerPanel.js', import.meta.url),
    'utf8',
  );
  const declarations = source.slice(
    source.indexOf('const PANEL_GROUPS ='),
    source.indexOf('const PANEL_POSITIONS ='),
  );
  const order = JSON.parse(
    runInNewContext(
      `const msg = (text) => text;\n${declarations}\nJSON.stringify(PANEL_ORDER)`,
    ),
  );
  const wildlife = order.findIndex(({ id }) => id === 'wildlife-sightings');
  assert.equal(order[wildlife].label, 'Wildlife');
  // News is the last of Events.
  assert.equal(order[wildlife - 1].id, 'news');
  assert.equal(order[wildlife + 1].id, 'air-quality');
  assert.equal(order.filter(({ id }) => id === 'wildlife-sightings').length, 1);
});

test('partial feed controls distinguish incomplete records from stale data and outages', async () => {
  const { LayerPanel, layerFeedState, presentLayerToggle } =
    await import('./layerPanel.js');
  const layer = {
    id: 'ais-live-vessels',
    name: 'Live Vessels',
    source: 'AISStream',
    enabled: true,
    stats: {
      partial: true,
      stale: false,
      count: 2,
      acceptedRowCount: 2,
      rawRowCount: 3,
      lastUpdate: Date.now(),
    },
  };
  const panel = LayerPanel.prototype;
  let toggle = presentLayerToggle(layer);
  assert.equal(toggle.text, 'PARTIAL');
  assert.equal(toggle.feedState, 'partial');
  assert.equal(toggle.classes['feed-partial'], true);
  assert.equal(toggle.classes['feed-stale'], false);
  assert.match(toggle.ariaLabel, /PARTIAL/);
  assert.match(
    panel._buildMetaText(layer),
    /^PARTIAL · AISStream · 2 of 3 records accepted · /,
  );
  assert.match(
    panel._buildMetaText({
      ...layer,
      stats: { ...layer.stats, rawRowCount: 2 },
    }),
    /incomplete snapshot/,
  );
  assert.equal(layerFeedState({ ...layer.stats, stale: true }), 'stale');
  assert.equal(
    layerFeedState({ ...layer.stats, error: 'Connection lost' }),
    'degraded',
  );
  assert.equal(
    layerFeedState({ ...layer.stats, status: 'unavailable' }),
    'unavailable',
  );
  assert.equal(layerFeedState({ ...layer.stats, loading: true }), 'loading');
  layer.stats = { ...layer.stats, partial: false };
  toggle = presentLayerToggle(layer);
  assert.equal(toggle.text, 'ON');
  assert.equal(toggle.classes['feed-partial'], false);
  layer.enabled = false;
  assert.equal(presentLayerToggle(layer).text, 'OFF');
});

test('a stale row dates cached data by its oldest tile, not the last load', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  const panel = LayerPanel.prototype;
  const layer = {
    id: 'traffic',
    name: 'Street Traffic',
    source: 'TomTom',
    enabled: true,
    stats: {
      mode: 'live',
      stale: true,
      count: 4,
      lastUpdate: Date.now(),
      oldestTileAt: Date.now() - 3 * 3600_000,
    },
  };
  assert.match(panel._buildMetaText(layer), /^STALE · TomTom · 3h ago$/);
  delete layer.stats.oldestTileAt;
  assert.match(panel._buildMetaText(layer), /^STALE · TomTom · just now$/);
});

test('readout rows contain only toggles and metadata; ordinary rows retain controls', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  document.body.replaceChildren();
  const container = document.body.appendChild(document.createElement('div'));
  const find = (id) => container.querySelector(`[data-layer-id="${id}"]`);
  const ids = [
    'wind',
    'weather-radar',
    'weather-satellite',
    'weather-lightning',
    'weather-cyclones',
    'other',
  ];
  let refresh;
  const layers = ids.map((id) => ({
    id,
    name: id,
    icon: '*',
    source: 'Source',
    enabled: true,
    showInTogglePanel: true,
    stats: {},
  }));
  const calls = [];
  const panel = new LayerPanel({
    getLayers: () => layers,
    isEnabled: () => true,
    setEnabled: (...args) => calls.push(args),
    setLayerParams: (...args) => calls.push(args),
    hasRowControls: () => true,
    subscribeRowControls: (_id, callback) => {
      refresh = callback;
    },
    getRowControls: (id) => ({
      readout: id !== 'other',
      summary: { status: 'Loading' },
      info: 'Detailed time',
      chips: [{ id: 'config', label: 'Soft', params: { opacity: 'light' } }],
      legend: [{ label: 'Rain', color: '#abcdef' }],
      list: {
        items: [{ id: 'storm', text: 'Storm', params: { focus: true } }],
      },
    }),
  });
  try {
    panel.mount(container);
    for (const id of ids.slice(0, -1)) {
      const row = find(id);
      assert.equal(row.children.length, 2);
      assert.ok(row.querySelector('.data-name'));
      assert.ok(row.querySelector('.data-toggle-meta'));
      for (const cls of [
        'data-toggle-chip',
        'data-count',
        'data-toggle-controls',
        'data-toggle-controls-status',
        'data-row-list',
      ])
        assert.ok(!row.querySelector(`.${cls}`), cls);
      row.querySelector('.data-toggle-btn').click();
    }
    assert.deepEqual(
      calls.map(([id]) => id),
      ids.slice(0, -1),
    );
    const ordinary = find('other');
    assert.equal(
      ordinary.querySelector('.data-toggle-controls-info').textContent,
      'Detailed time',
    );
    assert.ok(ordinary.querySelector('.data-toggle-legend-item'));
    ordinary.querySelector('.data-toggle-chip').click();
    assert.deepEqual(calls.at(-1), [
      'other',
      { opacity: 'light' },
      { origin: 'user' },
    ]);
    assert.equal(typeof refresh, 'function');
  } finally {
    panel.destroy();
    document.body.replaceChildren();
  }
});

test('Street Level row keeps keyboard focus and announces errors separately from coverage', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  const host = document.body.appendChild(document.createElement('div'));
  const layer = {
    id: 'street-level',
    name: 'Street Level',
    enabled: true,
    showInTogglePanel: true,
    stats: {},
  };
  const state = {
    enabled: true,
    providers: [providerSnapshot()],
    coverage: { count: 0 },
    sequence: { selectedId: 'sequence', images: 12 },
    street: {},
    filter: { pano: 'pano', sinceDays: 0 },
  };
  const writes = [];
  const panel = new LayerPanel({
    getLayers: () => [layer],
    isEnabled: () => layer.enabled,
    hasRowControls: () => true,
    subscribeRowControls() {},
    getRowControls: () =>
      streetLevelRowControls(presentStreetLevel(state), {
        toggleProvider() {
          layer.enabled = false;
          panel._refreshTogglePanel();
        },
        openNearest: null,
      }),
    setLayerParams: (_id, params) => {
      writes.push(params);
      Object.assign(state.filter, params);
      panel._refreshTogglePanel();
    },
  });
  const row = () => host.querySelector('[data-layer-id="street-level"]');
  const find = (selector) => row().querySelector(selector);
  const selectEnd = (key, from) => {
    const option = find(`[data-chip-id="sl-pano-${from}"]`);
    option.focus();
    option.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  };

  try {
    panel.mount(host);
    selectEnd('Home', 'pano');
    selectEnd('End', 'all');
    assert.deepEqual(writes.splice(0), [{ pano: 'all' }, { pano: 'flat' }]);
    assert.equal(document.activeElement, find('[data-chip-id="sl-pano-flat"]'));

    const slider = find('.data-toggle-slider-input');
    slider.focus();
    for (const value of ['1', '3', '5']) {
      slider.value = value;
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await nextTick();
    assert.equal(slider.getAttribute('aria-valuetext'), 'LAST YEAR');
    assert.deepEqual(writes, []);
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    assert.deepEqual(writes, [{ sinceDays: 365 }]);

    const readout = find('.data-toggle-slider-value');
    const lastYear = readout.textContent;
    assert.match(lastYear, /^LAST YEAR · SINCE /);
    state.filter.sinceDays = 30;
    panel._refreshTogglePanel();
    assert.equal(slider.value, '5');
    assert.equal(readout.textContent, lastYear);
    assert.equal(slider.getAttribute('aria-valuetext'), lastYear);
    slider.blur();
    await nextTick();
    assert.equal(slider.value, '8');
    assert.match(readout.textContent, /^LAST MONTH · SINCE /);

    const alert = find('[role="status"]');
    assert.equal(alert.textContent, '');
    state.street.error = 'No imagery here';
    panel._refreshTogglePanel();
    assert.equal(
      find('[role="status"]'),
      alert,
      'the live region was already mounted',
    );
    assert.equal(alert.textContent, 'No imagery here');
    assert.match(
      find('.data-toggle-controls-info').textContent,
      /12 images in this sequence/,
    );

    const chip = find('[data-chip-id="sl-provider-mapillary"]');
    slider.focus();
    state.keyRequired = state.keyRejected = true;
    panel._refreshTogglePanel();
    assert.equal(find('.data-toggle-slider-input'), null);
    assert.equal(document.activeElement === find('.data-toggle-btn'), true);

    chip.focus();
    chip.click();
    assert.equal(document.activeElement, find('.data-toggle-btn'));
    assert.equal(find('[data-chip-id="sl-provider-mapillary"]'), null);
  } finally {
    panel.destroy();
    host.remove();
  }
});

test('the Recent Imagery readout mounts in its rail body like the weather readout and is rebuilt or released with the panel', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  document.body.replaceChildren();
  const container = document.body.appendChild(document.createElement('div'));
  const body = document.body.appendChild(document.createElement('div'));
  body.id = 'recent-imagery-panel-body';
  const mounted = [];
  const factory = (container) => {
    const readout = {
      container,
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
    };
    mounted.push(readout);
    return readout;
  };
  const panel = new LayerPanel({
    getLayers: () => [],
    isEnabled: () => false,
    setEnabled() {},
    setLayerParams() {},
    hasRowControls: () => false,
    subscribeRowControls() {},
    getRowControls: () => null,
  });
  try {
    panel.attachRecentImagery(factory);
    assert.equal(mounted.length, 0, 'no body before the panel mounts');
    panel.mount(container);
    assert.equal(mounted.length, 1);
    assert.ok(mounted[0].container === body);
    panel.mount(container);
    assert.equal(mounted[0].destroyed, true, 'a remount rebuilds it');
    assert.equal(mounted.length, 2);
    panel.attachRecentImagery(null);
    assert.equal(mounted[1].destroyed, true);
    panel.attachRecentImagery(factory);
    assert.equal(mounted.length, 3);
    panel.destroy();
    assert.equal(mounted[2].destroyed, true);
    panel.attachRecentImagery(factory);
    assert.equal(mounted.length, 3, 'a destroyed panel mounts nothing');
  } finally {
    panel.destroy();
    document.body.replaceChildren();
  }
});

test('an omitted source is visibly unavailable and cannot be toggled on', async () => {
  const { presentLayerToggle } = await import('./layerPanel.js');
  const layer = {
    id: 'flights',
    name: 'Flights',
    enabled: false,
    stats: {
      sourceUnavailable: true,
      status: 'unavailable',
      error: 'Data source not configured: flights',
    },
  };
  const toggle = presentLayerToggle(layer);
  assert.equal(toggle.text, 'UNAVAILABLE');
  assert.equal(toggle.ariaDisabled, true);
  assert.match(toggle.title, /not configured/);
  assert.equal(
    presentLayerToggle({ ...layer, enabled: true }).ariaDisabled,
    false,
    'an active layer can always be switched off',
  );
});

test('row text keeps a hyphenated code whole and never starts a line with the separator', async () => {
  const { rowTextRuns } = await import('./layerRowText.js');
  const text = (runs) => runs.map((run) => run.text).join('');
  const kept = (runs) => runs.filter((run) => run.keep).map((run) => run.text);

  const name = rowTextRuns('Локальный ADS-B');
  assert.equal(text(name), 'Локальный ADS-B');
  assert.deepEqual(kept(name), ['ADS-B']);

  const meta = rowTextRuns('UNAVAILABLE · NASA FIRMS · LIVE · KEY REQUIRED');
  assert.equal(text(meta), 'UNAVAILABLE · NASA FIRMS · LIVE · KEY REQUIRED');
  assert.deepEqual(kept(meta), [' ·', ' ·', ' ·']);
  assert.ok(
    meta.every((run) => !run.text.startsWith('·')),
    'the space before each dot is held to the piece it closes',
  );

  assert.equal(rowTextRuns('Satellites'), null, 'plain text needs no runs');

  const compound = rowTextRuns('Kartierte ALPR-Kameras · ADS-B-Flüge');
  assert.equal(text(compound), 'Kartierte ALPR-Kameras · ADS-B-Flüge');
  assert.deepEqual(
    kept(compound),
    [' ·', 'ADS-B'],
    'a compound may break at its hyphen; the code inside it stays whole',
  );

  const long = rowTextRuns('see https-proxy-endpoint-config-x');
  assert.deepEqual(
    kept(long || []),
    [],
    'a long hyphenated run may still wrap',
  );
});

test('the unavailable chip may abbreviate, but its accessible name keeps the full state', async () => {
  const { presentLayerToggle } = await import('./layerPanel.js');
  const toggle = presentLayerToggle({
    id: 'local-firms',
    name: 'FIRMS Active Fires',
    enabled: false,
    stats: { sourceUnavailable: true, error: 'KEY REQUIRED' },
  });
  assert.equal(toggle.text, 'UNAVAILABLE');
  assert.equal(toggle.feedState, 'unavailable');
  assert.match(toggle.ariaLabel, /^Active Fires: UNAVAILABLE\./);
});

test('the Weather readout receives enabled air-quality alongside weather layers', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  const layers = ['wind', 'air-quality', 'other'].map((id) => ({
    id,
    icon: '*',
    enabled: true,
  }));
  layers.push({ id: 'weather-radar', icon: '*', enabled: false });
  const panel = new LayerPanel({
    getLayers: () => layers,
    getRowControls: (id) => ({ readout: true, summary: { label: id } }),
  });
  let entries = null;
  panel._weatherPanel = {
    update: (next) => {
      entries = next;
    },
  };
  panel._refreshWeatherPanel();
  assert.deepEqual(
    entries.map(({ id, summary }) => [id, summary.label]),
    [
      ['wind', 'wind'],
      ['air-quality', 'air-quality'],
    ],
  );
});

// Directions renders in the Utilities panel's list; Data Layers keeps the rest.
async function utilitiesFixture({ withUtilities = true } = {}) {
  const { LayerPanel } = await import('./layerPanel.js');
  document.body.replaceChildren();
  const container = document.body.appendChild(document.createElement('div'));
  container.id = 'data-toggles';
  const utilities = document.createElement('div');
  utilities.id = 'utilities-toggles';
  if (withUtilities) document.body.append(utilities);
  const layers = ['radio', 'directions', 'flights'].map((id) => ({
    id,
    name: id,
    icon: '*',
    source: 'S',
    enabled: false,
    showInTogglePanel: true,
    stats: {},
  }));
  const panel = new LayerPanel({
    getLayers: () => layers,
    isEnabled: (id) => layers.find((layer) => layer.id === id).enabled,
    setEnabled() {},
    setLayerParams() {},
    getRowControls: () => null,
    hasRowControls: () => false,
    subscribeRowControls: () => () => {},
  });
  panel.mount(container);
  const headings = (root) =>
    [...root.querySelectorAll('.data-layer-group-heading')].map((node) =>
      node.textContent.trim(),
    );
  const rowIds = (root) =>
    [...root.querySelectorAll('[data-layer-id]')].map(
      (node) => node.dataset.layerId,
    );
  const restore = () => {
    panel.destroy();
    document.body.replaceChildren();
  };
  return { container, utilities, panel, layers, headings, rowIds, restore };
}

test('Directions renders in the Utilities list without a heading, and Radio under Audio', async () => {
  const { container, utilities, panel, headings, rowIds, restore } =
    await utilitiesFixture();
  try {
    assert.deepEqual(rowIds(utilities), ['directions']);
    assert.deepEqual(headings(utilities), []);
    assert.deepEqual(rowIds(container), ['flights', 'radio']);
    assert.deepEqual(headings(container), ['Movement', 'Audio']);
    panel.mount(container);
    assert.deepEqual(
      rowIds(utilities),
      ['directions'],
      'a remount replaces it',
    );
    panel.destroy();
    assert.deepEqual(rowIds(utilities), [], 'destroy releases both lists');
  } finally {
    restore();
  }
});

test('a refresh updates the Directions row in the Utilities list', async () => {
  const { utilities, panel, layers, restore } = await utilitiesFixture();
  try {
    const toggle = () =>
      utilities.querySelector('[data-layer-id="directions"] .data-toggle-btn');
    assert.ok(!toggle().classList.contains('active'));
    layers.find(({ id }) => id === 'directions').enabled = true;
    panel._refreshTogglePanel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(toggle().classList.contains('active'));
  } finally {
    restore();
  }
});

test('without the Utilities list, Directions stays in Data Layers under Utilities', async () => {
  const { container, headings, rowIds, restore } = await utilitiesFixture({
    withUtilities: false,
  });
  try {
    assert.deepEqual(rowIds(container), ['flights', 'directions', 'radio']);
    assert.deepEqual(headings(container), ['Movement', 'Utilities', 'Audio']);
  } finally {
    restore();
  }
});

test('a layer with no feed in view says why instead of "never"', async () => {
  const { LayerPanel, presentLayerCount, presentLayerToggle } =
    await import('./layerPanel.js');
  const { setLocale } = await import('../i18n/index.js');
  const panel = LayerPanel.prototype;
  const rows = [
    {
      id: 'transit',
      name: 'Transit',
      source: 'GTFS-RT',
      enabled: true,
      stats: {
        count: 0,
        lastUpdate: null,
        source: 'GTFS-RT',
        status: 'zoom-in',
        statusMessage: 'No feed here yet · 16 regions available',
      },
      meta: 'GTFS-RT · No feed here yet · 16 regions available',
    },
    {
      id: 'bikeshare',
      name: 'Bikeshare',
      source: 'GBFS',
      enabled: true,
      stats: {
        count: 0,
        lastUpdate: null,
        loading: false,
        status: 'zoom-in',
        statusMessage: 'Fly below 48 km to a covered city',
      },
      meta: 'GBFS · Fly below 48 km to a covered city',
    },
  ];
  for (const layer of rows) {
    // Guidance is normal operation: the layer is on and nothing has failed.
    assert.equal(presentLayerToggle(layer).text, 'ON');
    assert.equal(presentLayerCount(layer.stats).empty, true);
    assert.equal(panel._buildMetaText(layer), layer.meta);
  }

  setLocale('ru');
  try {
    for (const layer of rows) {
      const meta = panel._buildMetaText(layer);
      assert.doesNotMatch(meta, /never|Fly below|No feed|covered/, meta);
      assert.match(meta, /^(GTFS-RT|GBFS) · /, meta);
    }
  } finally {
    setLocale('en');
  }
});

test('a chip count is shortened like the row count', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  const panel = Object.create(LayerPanel.prototype);
  panel._rowControlsFor = () => ({
    chips: [
      { id: 'a', label: 'A', active: true, swatch: '#fff', count: 10700 },
      { id: 'b', label: 'B', active: true, swatch: '#fff', count: 42 },
      { id: 'c', label: 'C', active: false },
    ],
  });
  const { chips, hidden } = panel._presentControls(
    {},
    { id: 'x', enabled: true },
  );
  assert.equal(hidden, false);
  assert.deepEqual(
    chips.map((chip) => chip.countText),
    ['10.7K', '42', undefined],
  );
  assert.equal(chips[0].swatch, '#fff', 'the rest of the chip passes through');
});
