import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('panel presentation places Transit between Street Traffic and Bike Share in Movement', () => {
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
      'bikeshare',
    ],
  );
  assert.equal(order.filter(({ id }) => id === 'transit').length, 1);
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
      'local-datacenters',
      'telegeography-submarine-cables',
      'local-dams',
      'us-groundwater',
    ],
  );
});

test('partial feed controls distinguish incomplete records from stale data and outages', async () => {
  const { LayerPanel, layerFeedState } = await import('./layerPanel.js');
  const classes = new Map();
  const attrs = new Map();
  const button = {
    classList: { toggle: (key, value) => classes.set(key, value) },
    dataset: {},
    setAttribute: (key, value) => attrs.set(key, value),
  };
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
  panel._syncToggleButton(button, layer);
  assert.equal(button.textContent, 'PARTIAL');
  assert.equal(button.dataset.feedState, 'partial');
  assert.equal(classes.get('feed-partial'), true);
  assert.equal(classes.get('feed-stale'), false);
  assert.match(attrs.get('aria-label'), /PARTIAL/);
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
  panel._syncToggleButton(button, layer);
  assert.equal(button.textContent, 'ON');
  assert.equal(classes.get('feed-partial'), false);
  layer.enabled = false;
  panel._syncToggleButton(button, layer);
  assert.equal(button.textContent, 'OFF');
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
  const { railFixture } = await import('./railTestFixture.mjs');
  const f = railFixture();
  const previousDocument = globalThis.document;
  globalThis.document = f.document;
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
    panel.mount(f.container);
    for (const id of ids.slice(0, -1)) {
      const row = f.find((n) => n.dataset.layerId === id);
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
        assert.equal(row.querySelector(`.${cls}`), null);
      row.querySelector('.data-toggle-btn').click();
    }
    assert.deepEqual(
      calls.map(([id]) => id),
      ids.slice(0, -1),
    );
    const ordinary = f.find((n) => n.dataset.layerId === 'other');
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
    globalThis.document = previousDocument;
  }
});

test('the Recent Imagery readout mounts in its rail body like the weather readout and is rebuilt or released with the panel', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  const { railFixture } = await import('./railTestFixture.mjs');
  const f = railFixture();
  const body = f.document.createElement('div');
  f.document.getElementById = (id) =>
    id === 'recent-imagery-panel-body' ? body : null;
  const previousDocument = globalThis.document;
  globalThis.document = f.document;
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
    panel.mount(f.container);
    assert.equal(mounted.length, 1);
    assert.equal(mounted[0].container, body);
    panel.mount(f.container);
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
    globalThis.document = previousDocument;
  }
});

test('an omitted source is visibly unavailable and cannot be toggled on', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  const attrs = new Map();
  const button = {
    classList: { toggle() {} },
    dataset: {},
    setAttribute: (key, value) => attrs.set(key, value),
  };
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
  LayerPanel.prototype._syncToggleButton(button, layer);
  assert.equal(button.textContent, 'UNAVAILABLE');
  assert.equal(attrs.get('aria-disabled'), 'true');
  assert.match(button.title, /not configured/);
  LayerPanel.prototype._syncToggleButton(button, { ...layer, enabled: true });
  assert.equal(
    attrs.get('aria-disabled'),
    'false',
    'an active layer can always be switched off',
  );
});

test('row text keeps a hyphenated code whole and never starts a line with the separator', async () => {
  const { setRowText } = await import('./layerPanel.js');
  const previousDocument = globalThis.document;
  const element = () => ({
    className: '',
    textContent: '',
    children: [],
    appendChild(child) {
      this.children.push(child);
      return child;
    },
  });
  globalThis.document = { createElement: element };
  try {
    const text = (node) =>
      node.children.length
        ? node.children.map((child) => child.textContent).join('')
        : node.textContent;
    const kept = (node) =>
      node.children
        .filter((child) => child.className === 'data-keep')
        .map((child) => child.textContent);

    const name = element();
    setRowText(name, 'Локальный ADS-B');
    assert.equal(text(name), 'Локальный ADS-B');
    assert.deepEqual(kept(name), ['ADS-B']);

    const meta = element();
    setRowText(meta, 'UNAVAILABLE · NASA FIRMS · LIVE · KEY REQUIRED');
    assert.equal(text(meta), 'UNAVAILABLE · NASA FIRMS · LIVE · KEY REQUIRED');
    assert.deepEqual(kept(meta), [' ·', ' ·', ' ·']);
    assert.ok(
      meta.children.every((child) => !child.textContent.startsWith('·')),
      'the space before each dot is held to the piece it closes',
    );

    const plain = element();
    setRowText(plain, 'Satellites');
    assert.equal(plain.textContent, 'Satellites');
    assert.equal(plain.children.length, 0);

    const compound = element();
    setRowText(compound, 'Kartierte ALPR-Kameras · ADS-B-Flüge');
    assert.equal(text(compound), 'Kartierte ALPR-Kameras · ADS-B-Flüge');
    assert.deepEqual(
      kept(compound),
      [' ·', 'ADS-B'],
      'a compound may break at its hyphen; the code inside it stays whole',
    );

    const long = element();
    setRowText(long, 'see https-proxy-endpoint-config-x');
    assert.deepEqual(kept(long), [], 'a long hyphenated run may still wrap');
  } finally {
    globalThis.document = previousDocument;
  }
});

test('the unavailable chip may abbreviate, but its accessible name keeps the full state', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  const attrs = new Map();
  const button = {
    classList: { toggle() {} },
    dataset: {},
    setAttribute: (key, value) => attrs.set(key, value),
  };
  LayerPanel.prototype._syncToggleButton(button, {
    id: 'local-firms',
    name: 'FIRMS Active Fires',
    enabled: false,
    stats: { sourceUnavailable: true, error: 'KEY REQUIRED' },
  });
  assert.equal(button.textContent, 'UNAVAILABLE');
  assert.equal(button.dataset.feedState, 'unavailable');
  assert.match(attrs.get('aria-label'), /^Active Fires: UNAVAILABLE\./);
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
  const { LayerPanel } = await import('./layerPanel.js');
  const panel = LayerPanel.prototype;
  const button = { classList: { toggle() {} }, dataset: {}, setAttribute() {} };
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
  panel._syncToggleButton(button, layer);
  assert.equal(button.textContent, 'ON');
  assert.equal(button.dataset.feedState, 'nominal');
  const text = panel._buildMetaText(layer);
  assert.equal(text, 'Rainfolk · never');
  panel._syncToggleButton(button, {
    ...layer,
    stats: { ...layer.stats, loading: true },
  });
  assert.equal(button.textContent, 'LOADING');
  panel._syncToggleButton(button, {
    ...layer,
    stats: { ...layer.stats, error: 'synthetic failure' },
  });
  assert.equal(button.textContent, 'DEGRADED');
  panel._syncToggleButton(button, { ...layer, enabled: false });
  assert.equal(button.textContent, 'OFF');
});

test('well catalog badge stays exact while represented locations and OFF state are separate', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  const panel = LayerPanel.prototype;
  const wellCountText = (stats) => panel._layerCountText(stats, true);
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

test('well row explanations and exact catalog count are accessible without custom hover titles', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  const panel = LayerPanel.prototype;
  const previousDocument = globalThis.document;
  const attributes = new Map([['title', 'old wells popup']]);
  const node = {
    textContent: 'Rainfolk · never',
    removeAttribute: (key) => attributes.delete(key),
    setAttribute: (key, value) => attributes.set(key, value),
  };
  panel._syncMetaText(node, {
    id: 'us-groundwater',
    enabled: false,
    source: 'USGWD historical catalog',
    stats: {},
  });
  assert.equal(attributes.has('title'), false);
  assert.match(attributes.get('aria-label'), /Historical source records/);
});

test('wells preserve exact count and failures in toggle descriptions without altering peer catalog rows', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  const panel = LayerPanel.prototype;
  const attrs = new Map();
  const count = {
    textContent: '',
    classList: { toggle() {} },
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: (k) => attrs.delete(k),
  };
  const row = {
    dataset: { layerId: 'us-groundwater' },
    classList: { toggle() {} },
  };
  panel._syncCount(row, count, { catalogCount: 5918051 });
  assert.equal(count.textContent, '5.9M');
  assert.equal(attrs.get('aria-label'), 'Catalog records: 5,918,051');
  assert.equal(attrs.has('title'), false);
  panel._syncCount(row, count, { catalogCount: null });
  assert.equal(attrs.has('aria-label'), false);
  row.dataset.layerId = 'other';
  panel._syncCount(row, count, { catalogCount: 5918051 });
  assert.equal(count.textContent, '5,918,051');
  assert.equal(count.title, 'Catalog records: 5,918,051');
  const toggleAttrs = new Map(),
    description = { id: 'water-wells-description', textContent: '' };
  const meta = {
    textContent: 'Rainfolk · never',
    _wellDescriptionNode: description,
    _wellToggle: { setAttribute: (k, v) => toggleAttrs.set(k, v) },
    setAttribute() {},
    removeAttribute() {},
  };
  panel._syncMetaText(meta, {
    id: 'us-groundwater',
    lifecycleUncertain: true,
    lifecycleState: 'disabled',
    stats: { lastError: 'source failed', catalogCount: 5918051 },
  });
  assert.equal(toggleAttrs.get('aria-describedby'), description.id);
  assert.match(description.textContent, /source failed/);
  assert.match(description.textContent, /Lifecycle state uncertain/);
  assert.match(description.textContent, /Historical source records/);
  assert.match(description.textContent, /5,918,051/);
});

test('peer noncatalog counts and shared legend formatter keep native decimals while wells use compact units', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  const panel = LayerPanel.prototype;
  assert.equal(panel._layerCountText({ count: 1000 }, false), '1.0K');
  assert.equal(panel._layerCountText({ count: 1000 }, true), '1K');
  assert.equal(panel._formatCount(1000), '1.0K');
  assert.equal(panel._formatCount(1000000), '1000.0K');
});
