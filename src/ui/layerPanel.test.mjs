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
    runInNewContext(`${declarations}\nJSON.stringify(PANEL_ORDER)`),
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

test('a row media slot mounts one video after the list, keyed, and releases it', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  const { railFixture } = await import('./railTestFixture.mjs');
  const f = railFixture();
  const previousDocument = globalThis.document;
  globalThis.document = f.document;
  const attached = [];
  const released = [];
  let media = null;
  let enabled = true;
  const layers = [
    {
      id: 'live-tv',
      name: 'Live TV',
      icon: '*',
      source: 'iptv-org',
      get enabled() {
        return enabled;
      },
      showInTogglePanel: true,
      stats: {},
    },
  ];
  const descriptor = (key) => ({
    key,
    label: `Live TV: ${key}`,
    attach(video) {
      attached.push([key, video]);
      return () => released.push(key);
    },
  });
  const panel = new LayerPanel({
    getLayers: () => layers,
    isEnabled: () => enabled,
    setEnabled() {},
    setLayerParams() {},
    hasRowControls: () => true,
    subscribeRowControls: () => null,
    getRowControls: () => ({
      info: 'Channels',
      list: {
        items: [
          { id: 'a', ordinal: 41, text: 'A', params: { channelId: 'a' } },
        ],
      },
      media,
    }),
  });
  const videos = () => {
    const found = [];
    const walk = (node) => {
      if (node.tagName === 'VIDEO') found.push(node);
      node.children.forEach(walk);
    };
    walk(f.container);
    return found;
  };
  // What a scheduled row refresh does for this row.
  const refresh = () =>
    panel._syncRowControls(
      f.find((n) => n.className === 'data-toggle-controls'),
      layers[0],
      f.find((n) => n.className === 'data-row-list'),
    );
  try {
    panel.mount(f.container);
    assert.deepEqual(videos(), [], 'no media, no video element');
    media = descriptor('a#1');
    refresh();
    const [video] = videos();
    assert.ok(video);
    assert.equal(video.preload, 'none');
    assert.equal(video.controls, true);
    assert.equal(video.getAttribute('aria-label'), 'Live TV: a#1');
    assert.equal(video.parent.className, 'data-row-media');
    const list = f.find((n) => n.className === 'data-row-list');
    const siblings = list.parent.children;
    assert.equal(siblings[siblings.indexOf(list) + 1], video.parent);
    assert.deepEqual(attached, [['a#1', video]]);
    // A later page numbers on from its first item, not from 1.
    assert.equal(list.start, 41);
    assert.equal(list.style.counterReset, 'gev-step 40');
    const info = f.find((n) => n.className === 'data-toggle-controls-info');
    assert.equal(info.getAttribute('role'), 'status', 'playback is announced');

    refresh();
    assert.equal(attached.length, 1, 'the same key keeps the same player');
    media = descriptor('a#2');
    refresh();
    assert.deepEqual(released, ['a#1']);
    assert.equal(videos().length, 1);
    assert.equal(attached.at(-1)[0], 'a#2');
    media = null;
    refresh();
    assert.deepEqual(released, ['a#1', 'a#2']);
    assert.deepEqual(videos(), []);
    assert.equal(
      f
        .find((n) => n.className === 'data-toggle-controls-info')
        .getAttribute('role'),
      null,
    );

    media = descriptor('a#3');
    refresh();
    enabled = false;
    refresh();
    assert.deepEqual(released, ['a#1', 'a#2', 'a#3'], 'disabling releases');
    enabled = true;
    media = descriptor('a#4');
    refresh();
  } finally {
    panel.destroy();
    globalThis.document = previousDocument;
  }
  assert.deepEqual(released, ['a#1', 'a#2', 'a#3', 'a#4'], 'destroy releases');
});
