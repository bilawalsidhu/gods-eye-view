import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { assertSameNode } from '../testSupport/domAssert.mjs';
import { installFakeResizeObserver } from '../testSupport/fakeResizeObserver.mjs';

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
async function utilitiesFixture({
  withUtilities = true,
  prepare = (list) => document.body.append(list),
  prepareUtilities = (list) => document.body.append(list),
} = {}) {
  const { LayerPanel } = await import('./layerPanel.js');
  document.body.replaceChildren();
  const container = document.createElement('div');
  prepare(container);
  container.id = 'data-toggles';
  const utilities = document.createElement('div');
  utilities.id = 'utilities-toggles';
  if (withUtilities) prepareUtilities(utilities);
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

// Each list the panel renders, counted per container.
function countRenders(panel) {
  const renders = [];
  const render = panel._renderRows;
  panel._renderRows = function (container, ...rest) {
    renders.push(container);
    return render.call(this, container, ...rest);
  };
  return renders;
}

test('a refresh skips a row list that is not displayed and repaints it once, current, when it is', async () => {
  const sizes = installFakeResizeObserver();
  const { container, utilities, panel, layers, restore } =
    await utilitiesFixture();
  try {
    const renders = countRenders(panel);
    const active = (root, id) =>
      root
        .querySelector(`[data-layer-id="${id}"] .data-toggle-btn`)
        .classList.contains('active');
    sizes.report(container, 0, 0);
    sizes.report(utilities, 0, 0);
    layers.find(({ id }) => id === 'flights').enabled = true;
    panel._refreshTogglePanel();
    layers.find(({ id }) => id === 'directions').enabled = true;
    panel._refreshTogglePanel();
    assert.deepEqual(renders, [], 'no list is rendered while not displayed');
    assert.equal(active(container, 'flights'), false);

    sizes.report(container, 240, 600);
    assert.equal(renders.length, 1, 'one render when Data Layers opens');
    assertSameNode(renders[0], container);
    assert.equal(active(container, 'flights'), true, 'with the latest rows');
    assert.equal(active(utilities, 'directions'), false, 'still owed');

    sizes.report(utilities, 240, 40);
    assert.equal(renders.length, 2);
    assertSameNode(renders[1], utilities);
    assert.equal(active(utilities, 'directions'), true);

    // Shown again with nothing owed, or refreshed with the same rows: no render.
    sizes.report(container, 0, 0);
    sizes.report(container, 240, 600);
    panel._refreshTogglePanel();
    assert.equal(renders.length, 2, 'unchanged rows are not rendered again');
    layers.find(({ id }) => id === 'radio').enabled = true;
    panel._refreshTogglePanel();
    assert.equal(renders.length, 3, 'changed rows render');
    assertSameNode(renders[2], container);
    assert.equal(active(container, 'radio'), true);
  } finally {
    restore();
    sizes.restore();
  }
});

test('filtering a list a refresh skipped filters its latest rows', async () => {
  const sizes = installFakeResizeObserver();
  const { container, utilities, panel, layers, restore } =
    await utilitiesFixture();
  try {
    const shown = () =>
      [...container.querySelectorAll('[data-layer-id]')]
        .filter((row) => !row.classList.contains('is-filtered'))
        .map((row) => row.dataset.layerId);
    sizes.report(container, 0, 0);
    sizes.report(utilities, 0, 0);
    layers.find(({ id }) => id === 'flights').enabled = true;
    panel._refreshTogglePanel();
    panel.finder.select({ show: 'on' });
    assert.deepEqual(shown(), ['flights']);
    panel.finder.select({ show: 'all' });
    assert.deepEqual(shown(), ['flights', 'radio']);
  } finally {
    restore();
    sizes.restore();
  }
});

test('a row read right after its panel is presented open sees current rows', async () => {
  const sizes = installFakeResizeObserver();
  const { flushPanelContent } = await import('./rail/panelContent.js');
  // Data Layers' list inside its panel, as LayerPanelsView renders it.
  const panelEl = document.createElement('div');
  panelEl.id = 'data-panel';
  panelEl.dataset.panelId = 'data-panel';
  const { container, utilities, panel, layers, restore } =
    await utilitiesFixture({
      prepare: (list) => {
        panelEl.append(list);
        document.body.append(panelEl);
      },
    });
  try {
    const renders = countRenders(panel);
    sizes.report(container, 0, 0);
    sizes.report(utilities, 0, 0);
    layers.find(({ id }) => id === 'flights').enabled = true;
    panel._refreshTogglePanel();
    assert.deepEqual(renders, []);
    // What the panel chrome does as it opens Data Layers, before the
    // ResizeObserver reports it displayed.
    flushPanelContent(panelEl);
    assert.ok(
      container
        .querySelector('[data-layer-id="flights"] .data-toggle-btn')
        .classList.contains('active'),
    );
    const flushed = renders.length;
    assert.ok(flushed >= 1);
    flushPanelContent(panelEl);
    sizes.report(container, 240, 600);
    assert.equal(renders.length, flushed, 'nothing owed, nothing rendered');
    panel.destroy();
    flushPanelContent(panelEl);
    assert.equal(renders.length, flushed, 'destroy releases the flush');
  } finally {
    restore();
    sizes.restore();
  }
});

test('a mode that shows the panels again repaints owed rows before anything reads them', async () => {
  const sizes = installFakeResizeObserver();
  const { SceneControls } = await import('./sceneControls.js');
  const panelEl = document.createElement('div');
  panelEl.id = 'data-panel';
  panelEl.dataset.panelId = 'data-panel';
  const { container, utilities, panel, layers, restore } =
    await utilitiesFixture({
      prepare: (list) => {
        panelEl.append(list);
        document.body.append(panelEl);
      },
    });
  const active = (id) =>
    container
      .querySelector(`[data-layer-id="${id}"] .data-toggle-btn`)
      .classList.contains('active');
  try {
    // Scene playback hides the panels; a refresh meanwhile is owed.
    SceneControls.prototype.setPlaybackActive.call({ destroyed: false }, true);
    sizes.report(container, 0, 0);
    sizes.report(utilities, 0, 0);
    layers.find(({ id }) => id === 'flights').enabled = true;
    panel._refreshTogglePanel();
    assert.equal(active('flights'), false);
    // Leaving playback shows them again: the rows are current at once.
    SceneControls.prototype.setPlaybackActive.call({ destroyed: false }, false);
    assert.equal(active('flights'), true);
    // A refresh before the observer's next report paints rather than owes.
    layers.find(({ id }) => id === 'radio').enabled = true;
    panel._refreshTogglePanel();
    assert.equal(active('radio'), true);
  } finally {
    document.body.classList.remove('scene-playback-mode');
    restore();
    sizes.restore();
  }
});

test('a layout pass repaints owed rows only where a list is displayed', async () => {
  const sizes = installFakeResizeObserver();
  const { flushDisplayedPanelContent } = await import('./rail/panelContent.js');
  const panelEl = document.createElement('div');
  panelEl.id = 'data-panel';
  panelEl.dataset.panelId = 'data-panel';
  const { container, utilities, panel, layers, restore } =
    await utilitiesFixture({
      prepare: (list) => {
        panelEl.append(list);
        document.body.append(panelEl);
      },
    });
  try {
    const renders = countRenders(panel);
    sizes.report(container, 0, 0);
    sizes.report(utilities, 0, 0);
    layers.find(({ id }) => id === 'flights').enabled = true;
    panel._refreshTogglePanel();
    // Nothing has a layout box: the pass leaves the rows owed.
    container.getClientRects = () => [];
    utilities.getClientRects = () => [];
    flushDisplayedPanelContent();
    assert.deepEqual(renders, []);
    // A class showed Data Layers before the observer reported it.
    container.getClientRects = () => [{}];
    flushDisplayedPanelContent();
    assert.equal(renders.length, 1);
    assertSameNode(renders[0], container);
    assert.ok(
      container
        .querySelector('[data-layer-id="flights"] .data-toggle-btn')
        .classList.contains('active'),
    );
  } finally {
    restore();
    sizes.restore();
  }
});

/** Data Layers and Utilities lists, each inside its own panel. */
function twoPanels() {
  const panelOf = (id) => {
    const panelEl = document.createElement('div');
    panelEl.id = id;
    panelEl.dataset.panelId = id;
    return panelEl;
  };
  const dataPanel = panelOf('data-panel');
  const utilitiesPanel = panelOf('utilities-panel');
  return {
    dataPanel,
    utilitiesPanel,
    prepare: (list) => {
      dataPanel.append(list);
      document.body.append(dataPanel);
    },
    prepareUtilities: (list) => {
      utilitiesPanel.append(list);
      document.body.append(utilitiesPanel);
    },
  };
}

test('opening one panel paints and marks displayed only the lists inside it', async () => {
  const sizes = installFakeResizeObserver();
  const { flushPanelContent } = await import('./rail/panelContent.js');
  const panels = twoPanels();
  const { container, utilities, panel, layers, restore } =
    await utilitiesFixture(panels);
  try {
    const renders = countRenders(panel);
    sizes.report(container, 0, 0);
    sizes.report(utilities, 0, 0);
    layers.find(({ id }) => id === 'flights').enabled = true;
    panel._refreshTogglePanel();
    assert.deepEqual(renders, []);
    // The panel chrome opens Data Layers; Utilities stays collapsed.
    flushPanelContent(panels.dataPanel);
    assert.equal(renders.length, 1);
    assertSameNode(renders[0], container);
    // Utilities was not shown: later refreshes still skip it.
    layers.find(({ id }) => id === 'directions').enabled = true;
    panel._refreshTogglePanel();
    assert.ok(
      renders.every((element) => element === container),
      'the collapsed Utilities list is never rendered',
    );
    // Opening Utilities paints it then, current.
    flushPanelContent(panels.utilitiesPanel);
    assert.ok(renders.includes(utilities));
    assert.ok(
      utilities
        .querySelector('[data-layer-id="directions"] .data-toggle-btn')
        .classList.contains('active'),
    );
  } finally {
    restore();
    sizes.restore();
  }
});

test('a layout pass presents no rows when no displayed list is owed', async () => {
  const sizes = installFakeResizeObserver();
  const { flushDisplayedPanelContent } = await import('./rail/panelContent.js');
  const panels = twoPanels();
  const { container, utilities, panel, layers, restore } =
    await utilitiesFixture(panels);
  try {
    // Data Layers is open and current; Utilities is collapsed and owed.
    sizes.report(container, 240, 600);
    sizes.report(utilities, 0, 0);
    layers.find(({ id }) => id === 'flights').enabled = true;
    panel._refreshTogglePanel();
    container.getClientRects = () => [{}];
    utilities.getClientRects = () => [];
    let presented = 0;
    const present = panel._presentRow;
    panel._presentRow = function (...args) {
      presented++;
      return present.apply(this, args);
    };
    flushDisplayedPanelContent();
    flushDisplayedPanelContent();
    assert.equal(presented, 0);
  } finally {
    restore();
    sizes.restore();
  }
});

test('a language change renders rows the equality check would otherwise skip', async () => {
  const { setLocale } = await import('../i18n/index.js');
  const { container, panel, restore } = await utilitiesFixture();
  try {
    const renders = countRenders(panel);
    panel._refreshTogglePanel();
    assert.deepEqual(renders, [], 'unchanged rows are skipped');
    const heading = () =>
      container.querySelector('.data-layer-group-heading').textContent.trim();
    assert.equal(heading(), 'Movement');
    await setLocale('fr');
    assert.ok(renders.length >= 1, 'the new language renders');
    assert.notEqual(heading(), 'Movement');
    const after = renders.length;
    panel._refreshTogglePanel();
    assert.equal(renders.length, after, 'and is then the rows shown');
  } finally {
    await setLocale('en');
    restore();
  }
});

test('while the page is hidden an invalidation waits, and paints once the page is shown', async () => {
  const sizes = installFakeResizeObserver();
  const { container, panel, layers, restore } = await utilitiesFixture();
  const hidden = Object.getOwnPropertyDescriptor(document, 'hidden');
  let pageHidden = true;
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => pageHidden,
  });
  try {
    const renders = countRenders(panel);
    sizes.report(container, 240, 600);
    layers.find(({ id }) => id === 'flights').enabled = true;
    panel.invalidate('flights');
    panel.paintPending();
    assert.deepEqual(renders, []);
    pageHidden = false;
    // What the page's return calls (LayerPresentation.flushVisible).
    panel.paintPending();
    assert.equal(renders.length, 1);
    panel.paintPending();
    assert.equal(renders.length, 1, 'nothing left pending');
    assert.ok(
      container
        .querySelector('[data-layer-id="flights"] .data-toggle-btn')
        .classList.contains('active'),
    );
  } finally {
    if (hidden) Object.defineProperty(document, 'hidden', hidden);
    else delete document.hidden;
    restore();
    sizes.restore();
  }
});

test("destroy and remount disconnect the row lists' observers", async () => {
  const sizes = installFakeResizeObserver();
  const { container, utilities, panel, restore } = await utilitiesFixture();
  try {
    const first = [...sizes.watching(container), ...sizes.watching(utilities)];
    assert.equal(first.length, 2);
    panel.mount(container);
    assert.ok(first.every((observer) => observer.disconnected));
    const second = [...sizes.watching(container), ...sizes.watching(utilities)];
    assert.equal(second.length, 2);
    panel.destroy();
    assert.ok(second.every((observer) => observer.disconnected));
    assert.deepEqual(sizes.watching(container), []);
  } finally {
    restore();
    sizes.restore();
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

// ── The scheduler: one paint per frame, nothing while hidden ───────────────

/** A panel over plain layer descriptors, with a clock the test moves. */
async function schedulerFixture({ layers: specs }) {
  const { LayerPanel } = await import('./layerPanel.js');
  document.body.replaceChildren();
  const container = document.body.appendChild(document.createElement('div'));
  container.id = 'data-toggles';
  const recentBody = document.body.appendChild(document.createElement('div'));
  recentBody.id = 'recent-imagery-panel-body';
  const listeners = new Set();
  const weatherClock = {
    getState: () => ({ mode: 'latest', timeline: [], products: [] }),
    subscribe(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
  const layers = specs.map((spec) => ({
    icon: '*',
    source: 'S',
    enabled: true,
    showInTogglePanel: true,
    stats: {},
    name: spec.id,
    ...spec,
  }));
  const reads = new Map();
  const panel = new LayerPanel({
    weatherClock,
    getLayers: () => layers,
    isEnabled: (id) =>
      layers.find((layer) => layer.id === id)?.enabled === true,
    setEnabled() {},
    setLayerParams() {},
    hasRowControls: () => true,
    getRowControls: (id) => {
      reads.set(id, (reads.get(id) ?? 0) + 1);
      return layers.find((layer) => layer.id === id).controls?.() ?? null;
    },
  });
  const readout = { updates: 0, update() {}, destroy() {} };
  readout.update = () => readout.updates++;
  panel.attachRecentImagery(() => readout);
  panel.mount(container);
  const frame = () =>
    new Promise((resolve) =>
      requestAnimationFrame(() => setTimeout(resolve, 0)),
    );
  await frame();
  reads.clear();
  return {
    container,
    panel,
    layers,
    reads,
    readout,
    frame,
    tick: () => {
      for (const callback of [...listeners]) callback();
    },
    restore() {
      panel.destroy();
      document.body.replaceChildren();
    },
  };
}

test('invalidations before a frame share it, and an unchanged row is not rendered again', async () => {
  let label = 'One';
  const f = await schedulerFixture({
    layers: [{ id: 'flights', controls: () => ({ info: label }) }],
  });
  try {
    const renders = countRenders(f.panel);
    for (let i = 0; i < 100; i++) f.panel.invalidate('flights');
    assert.deepEqual(renders, [], 'invalidate never paints');
    await f.frame();
    assert.equal(f.reads.get('flights'), 1, 'one frame reads the row once');
    assert.deepEqual(renders, [], 'the row it read is the one shown');
    label = 'Two';
    f.panel.invalidate('flights');
    f.panel.invalidate('flights');
    await f.frame();
    assert.equal(renders.length, 1);
    assert.equal(
      f.container.querySelector('.data-toggle-controls-info').textContent,
      'Two',
    );
    await f.frame();
    assert.equal(renders.length, 1, 'nothing is left pending');
  } finally {
    f.restore();
  }
});

test('a hidden list stays owed across invalidations and paints exactly once when shown', async () => {
  const sizes = installFakeResizeObserver();
  let label = 'One';
  const f = await schedulerFixture({
    layers: [{ id: 'flights', controls: () => ({ info: label }) }],
  });
  try {
    const renders = countRenders(f.panel);
    sizes.report(f.container, 0, 0);
    for (const next of ['Two', 'Three', 'Four']) {
      label = next;
      f.panel.invalidate('flights');
      await f.frame();
    }
    assert.deepEqual(renders, [], 'nothing paints while hidden');
    sizes.report(f.container, 240, 600);
    await f.frame();
    await f.frame();
    assert.equal(renders.length, 1, 'one catch-up paint');
    assert.equal(
      f.container.querySelector('.data-toggle-controls-info').textContent,
      'Four',
      'the catch-up shows the latest row',
    );
  } finally {
    f.restore();
    sizes.restore();
  }
});

test('a layer that follows the time is read again when it moves; others are not', async () => {
  let minute = 0;
  const f = await schedulerFixture({
    layers: [
      {
        id: 'wind',
        followsTime: true,
        controls: () => ({ info: `minute ${minute}` }),
      },
      { id: 'flights', controls: () => ({ info: 'static' }) },
    ],
  });
  try {
    const renders = countRenders(f.panel);
    for (let step = 1; step <= 3; step++) {
      minute = step;
      f.tick();
      f.tick();
      await f.frame();
      assert.equal(renders.length, step, `step ${step} paints once`);
    }
    assert.equal(f.reads.get('wind'), 3, 'the follower is read once a step');
    assert.equal(f.reads.get('flights') ?? 0, 0, 'the other row is not read');
    f.layers[0].enabled = false;
    f.panel.invalidate();
    await f.frame();
    const after = renders.length;
    f.tick();
    await f.frame();
    assert.equal(renders.length, after, 'an off follower is not read again');
  } finally {
    f.restore();
  }
});

test('the Recent Imagery readout updates on its layer invalidation, once per frame', async () => {
  const f = await schedulerFixture({
    layers: [{ id: 'recent-imagery' }, { id: 'flights' }],
  });
  try {
    f.readout.updates = 0;
    for (let i = 0; i < 10; i++) f.panel.invalidate('recent-imagery');
    await f.frame();
    assert.equal(f.readout.updates, 1);
    f.panel.invalidate('flights');
    await f.frame();
    assert.equal(f.readout.updates, 1, 'another layer does not update it');
  } finally {
    f.restore();
  }
});

test('a rebuild between an invalidation and its frame keeps it: the readout still updates', async () => {
  const f = await schedulerFixture({
    layers: [{ id: 'recent-imagery' }, { id: 'flights' }],
  });
  try {
    f.readout.updates = 0;
    f.panel.invalidate('recent-imagery');
    // A Data Library add or remove rebuilds the rows before the frame.
    f.panel.rerender();
    await f.frame();
    await f.frame();
    assert.equal(f.readout.updates, 1, 'the invalidation was not dropped');
    f.panel.invalidate('recent-imagery');
    f.panel.destroy();
    await f.frame();
    assert.equal(f.readout.updates, 1, 'destroy drops what was pending');
  } finally {
    f.restore();
  }
});
