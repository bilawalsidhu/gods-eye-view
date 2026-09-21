import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('finder filters descriptor labels, names and sources without replacing rows or issuing actions', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  const layers = [
    { id: 'cctv', name: 'CCTV', source: 'City feeds', enabled: true },
    {
      id: 'local-firms',
      name: 'FIRMS',
      source: 'NASA',
      stats: { source: 'VIIRS' },
      enabled: false,
    },
    { id: 'custom', name: 'Custom layer', enabled: false },
  ];
  const finder = { value: '' };
  const heading = () => ({
    classList: { contains: () => true },
    hidden: false,
  });
  const row = (id) => ({
    classList: { contains: () => false },
    dataset: { layerId: id },
    hidden: false,
  });
  const cameras = heading();
  const events = heading();
  const other = heading();
  const rows = layers.map(({ id }) => row(id));
  const children = [cameras, rows[0], events, rows[1], other, rows[2]];
  const before = structuredClone(layers);
  const panel = new LayerPanel({
    getLayers: () => layers,
    setEnabled: () => assert.fail('search must not change enabled state'),
    setLayerParams: () => assert.fail('search must not write parameters'),
  });
  panel._toggleContainer = {
    parentElement: { querySelector: () => finder },
    children,
  };
  for (const query of ['fire', 'AcTiVe FiReS', 'firms', 'NASA', 'viirs']) {
    finder.value = query;
    panel._filterRows();
    assert.deepEqual(
      rows.map(({ hidden }) => hidden),
      [true, false, true],
    );
    assert.deepEqual(
      [cameras.hidden, events.hidden, other.hidden],
      [true, false, true],
    );
  }
  for (const query of ['cam', 'CCTV', 'city']) {
    finder.value = query;
    panel._filterRows();
    assert.deepEqual(
      rows.map(({ hidden }) => hidden),
      [false, true, true],
    );
  }
  finder.value = 'no match';
  panel._filterRows();
  assert.ok(children.every(({ hidden }) => hidden));
  for (const query of ['', '   ']) {
    finder.value = query;
    panel._filterRows();
    assert.ok(children.every(({ hidden }) => !hidden));
  }
  assert.deepEqual(layers, before);
  assert.equal(panel._toggleContainer.children, children);
  panel.destroy();
});

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
