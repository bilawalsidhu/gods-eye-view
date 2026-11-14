import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

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

test('panel presentation exposes groundwater wells under Infrastructure', () => {
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
    order.filter(({ label }) => label === 'Infrastructure').map(({ id }) => id),
    [
      'alpr-cameras',
      'military-installations',
      'drone-airspace',
      'local-datacenters',
      'telegeography-submarine-cables',
      'local-dams',
      'sea-marks',
      'ski-pistes',
      'us-groundwater',
    ],
  );
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

test('well snapshot separates enabled/loading/error state from coverage and reference-page date', async () => {
  const { LayerPanel, presentLayerToggle } = await import('./layerPanel.js');
  const panel = LayerPanel.prototype;
  const layer = {
    id: 'us-groundwater',
    name: 'U.S. Groundwater Wells',
    source: 'USGS',
    enabled: true,
    stats: {
      mode: 'snapshot',
      partial: true,
      count: 1042777,
      referenceRetrievedAt: '2026-10-25T17:30:16Z',
      displayMode: 'groups',
      selectedGroupCount: 12345,
    },
  };
  assert.equal(presentLayerToggle(layer).text, 'ON');
  assert.equal(presentLayerToggle(layer).feedState, 'nominal');
  const text = panel._buildMetaText(layer);
  assert.equal(text, 'Rainfolk · never');
  assert.equal(
    presentLayerToggle({
      ...layer,
      stats: { ...layer.stats, loading: true },
    }).text,
    'LOADING',
  );
  assert.equal(
    presentLayerToggle({
      ...layer,
      stats: { ...layer.stats, error: 'synthetic failure' },
    }).text,
    'DEGRADED',
  );
  assert.equal(presentLayerToggle({ ...layer, enabled: false }).text, 'OFF');
});

test('well catalog badge stays exact while represented locations and OFF state are separate', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  const panel = LayerPanel.prototype;
  const { presentLayerCount } = await import('./layerPanel.js');
  const wellCountText = (stats) => presentLayerCount(stats, true).text;
  const layer = {
    id: 'us-groundwater',
    enabled: true,
    source: 'USGS',
    stats: {
      mode: 'snapshot',
      count: 7200,
      catalogCount: 1042777,
      representedLocationCount: 7200,
      displayMode: 'groups',
      referenceRetrievedAt: '2026-10-25T17:30:16Z',
    },
  };
  assert.equal(wellCountText(layer.stats), '1M');
  assert.equal(panel._buildMetaText(layer), 'Rainfolk · never');
  assert.equal(
    panel._buildMetaText({ ...layer, enabled: false }),
    'Rainfolk · never',
  );
  assert.doesNotMatch(panel._buildMetaText(layer), /\uFFFD|in view/);
  assert.equal(
    wellCountText({
      ...layer.stats,
      count: 1,
      representedLocationCount: 1,
    }),
    '1M',
  );
  assert.equal(wellCountText({ catalogCount: 0 }), '0');
});

test('layer count summaries use native compact units without redundant decimals', async () => {
  const { formatLayerCount } = await import('./formatLayerCount.js');
  for (const [value, expected] of [
    [0, '0'],
    [53, '53'],
    [999, '999'],
    [1000, '1K'],
    [4400, '4.4K'],
    [1042777, '1M'],
    [5918051, '5.9M'],
    [999999, '1M'],
  ]) {
    assert.equal(formatLayerCount(value), expected);
  }
  const { LayerPanel } = await import('./layerPanel.js');
  assert.equal(
    LayerPanel.prototype._buildMetaText({
      id: 'us-groundwater',
      enabled: true,
      source: 'USGWD historical catalog',
      stats: { mode: 'snapshot' },
    }),
    'Rainfolk · never',
  );
});

test('Rainfolk check age uses consumer acceptance only and preserves coverage and outage states', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  const panel = LayerPanel.prototype;
  const original = Date.now;
  Date.now = () => 1800000000000;
  try {
    const layer = {
      id: 'us-groundwater',
      enabled: true,
      source: 'USGWD historical catalog',
      stats: {
        mode: 'snapshot',
        partial: true,
        stateCount: 36,
        lastCheckedAt: 1800000000000 - 125000,
        referenceRetrievedAt: '2026-10-27T18:48:01Z',
        lastUpdate: 1800000000000,
      },
    };
    assert.equal(panel._buildMetaText(layer), 'Rainfolk · 2m ago');
    Date.now = () => 1800000000000 + 60000;
    assert.equal(panel._buildMetaText(layer), 'Rainfolk · 3m ago');
    assert.equal(
      panel._buildMetaText({
        ...layer,
        stats: { ...layer.stats, lastCheckedAt: null },
      }),
      'Rainfolk · never',
    );
    assert.equal(
      panel._buildMetaText({
        ...layer,
        stats: { ...layer.stats, stateCount: 48 },
      }),
      'Rainfolk · 3m ago',
    );
    assert.match(
      panel._buildMetaText({
        ...layer,
        stats: { ...layer.stats, status: 'zoom-in' },
      }),
      /^Rainfolk · 3m ago$/,
    );
    assert.match(
      panel._buildMetaText({
        ...layer,
        stats: { ...layer.stats, loading: true },
      }),
      /^Rainfolk · 3m ago$/,
    );
    assert.match(
      panel._buildMetaText({
        ...layer,
        stats: { ...layer.stats, error: 'synthetic failure' },
      }),
      /^Rainfolk · 3m ago$/,
    );
  } finally {
    Date.now = original;
  }
});

test('wells use a short panel label and retain the formal accessible layer name', async () => {
  const { PANEL_LABEL_KEYS, layerNameForId } = await import('./layerNames.js');
  assert.equal(PANEL_LABEL_KEYS['us-groundwater'], 'Water Wells');
  assert.equal(layerNameForId('us-groundwater'), 'U.S. Groundwater Wells');
});

test('all initial and repeated lifecycle states keep the exact Rainfolk subtitle without state counts', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  const panel = LayerPanel.prototype;
  const original = Date.now;
  Date.now = () => 1800000000000;
  try {
    for (const lifecycleState of [
      'disabled',
      'enabling',
      'enabled',
      'disabling',
    ])
      for (const extra of [
        {},
        { loading: true },
        { error: 'feed failed' },
        { status: 'zoom-in', statusMessage: 'detail limited' },
      ]) {
        const layer = {
          id: 'us-groundwater',
          source: 'USGWD historical catalog',
          enabled: lifecycleState === 'enabled',
          lifecycleState,
          stats: extra,
        };
        assert.equal(panel._buildMetaText(layer), 'Rainfolk · never');
        assert.equal(
          panel._buildMetaText({
            ...layer,
            stats: {
              ...extra,
              lastCheckedAt: 1800000000000 - 125000,
              stateCount: 48,
            },
          }),
          'Rainfolk · 2m ago',
        );
      }
  } finally {
    Date.now = original;
  }
});

test('wells expose exact count and failures in native Vue descriptions without custom hover titles', async () => {
  const { LayerPanel, presentLayerCount } = await import('./layerPanel.js');
  const { h, render } = await import('vue');
  const { default: LayerRows } = await import('./layerPanel/LayerRows.vue');
  const panel = new LayerPanel({});
  const layer = {
    id: 'us-groundwater',
    name: 'U.S. Groundwater Wells',
    icon: '🪣',
    lifecycleUncertain: true,
    lifecycleState: 'disabled',
    enabled: false,
    stats: { lastError: 'source failed', catalogCount: 5918051 },
  };
  const item = panel._presentRow({ count: true }, layer);
  assert.equal(item.count.text, '5.9M');
  assert.equal(item.meta, 'Rainfolk · never');
  assert.match(item.description, /source failed/);
  assert.match(item.description, /Lifecycle state uncertain/);
  assert.match(item.description, /Historical source records/);
  assert.match(item.description, /5,918,051/);
  const container = document.body.appendChild(document.createElement('div'));
  render(h(LayerRows, { items: [item] }), container);
  const button = container.querySelector('.data-toggle-btn');
  assert.equal(button.hasAttribute('title'), false);
  assert.equal(
    button.getAttribute('aria-describedby'),
    'water-wells-description',
  );
  assert.equal(
    container.querySelector('#water-wells-description').textContent,
    item.description,
  );
  assert.equal(
    container.querySelector('.data-toggle-meta').textContent,
    'Rainfolk · never',
  );
  render(null, container);
  container.remove();
  panel.destroy();
  assert.equal(presentLayerCount({ count: 1000 }).text, '1.0K');
  assert.equal(presentLayerCount({ count: 1000 }, true).text, '1K');
  assert.equal(presentLayerCount({ catalogCount: 0 }, true).text, '0');
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
