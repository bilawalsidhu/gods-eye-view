// src/ui/layerFinder.test.mjs — the Data Layers finder and section index work
// on the rows LayerRows renders: search, the On/Off and category filter,
// Escape, the clear request voice sends, and the group ticks.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertSameNode } from '../testSupport/domAssert.mjs';
import { createPinia } from 'pinia';
import { getLocale, setLocale } from '../i18n/index.js';
import { createApp, nextTick } from 'vue';
import { LayerPanel } from 'gods-eye-view/ui/layers';
import { createGevActionRunner } from '../voice/gevActions.js';
import { bindRenderer } from '../render/rendererOf.js';
import LayerPanelsView from './views/LayerPanelsView.vue';
import { mountApplicationViews } from './views/index.js';
import { useLayerFinderStore } from './stores/layerFinder.js';

const flush = async () => {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
};

function fixture(t) {
  document.body.replaceChildren();
  // Frames run at once, so the observers' batching does not hold a test up.
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  const root = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(LayerPanelsView).use(pinia);
  app.mount(root);
  const finder = useLayerFinderStore(pinia);
  const panel = root.querySelector('#data-panel');
  const list = root.querySelector('#data-toggles');
  const layers = [
    'flights',
    'ais-live-vessels',
    'weather-radar',
    'directions',
  ].map((id) => ({
    id,
    name: id,
    enabled: id === 'flights',
    showInTogglePanel: true,
    stats: {},
  }));
  const rows = new LayerPanel({
    finder,
    getLayers: () => layers,
    getRowControls: () => null,
    hasRowControls: () => false,
    isEnabled: (id) => layers.find((layer) => layer.id === id)?.enabled,
  });
  rows.mount(list);
  const locale = getLocale();
  t.after(() => {
    rows.destroy();
    app.unmount();
    setLocale(locale);
  });
  const shown = () =>
    [...list.querySelectorAll('.data-toggle-row:not(.is-filtered)')].map(
      (row) => row.dataset.layerId,
    );
  const search = async (text) => {
    if (!document.getElementById('layer-finder-input')) {
      document.getElementById('layer-finder-search-btn').click();
      await flush();
    }
    const input = document.getElementById('layer-finder-input');
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
  };
  const openFilter = async () => {
    document.querySelector('[aria-controls="layer-finder-menu"]').click();
    await flush();
    return document.getElementById('layer-finder-menu');
  };
  return { list, panel, shown, search, openFilter, finder, rows, layers };
}

test('the public LayerPanel uses its mounted page Finder and leaves a standalone panel alone', async (t) => {
  document.body.innerHTML = '<div data-gev-view="layer-panels"></div>';
  mountApplicationViews(document);
  const style = document.head.appendChild(document.createElement('style'));
  style.textContent = readFileSync(
    new URL('./styles/layer-finder.css', import.meta.url),
    'utf8',
  );
  t.after(() => style.remove());
  const list = document.getElementById('data-toggles');
  const standaloneList = document.createElement('div');
  standaloneList.id = list.id;
  const layers = ['flights', 'ais-live-vessels', 'weather-radar'].map((id) => ({
    id,
    name: id,
    enabled: false,
    showInTogglePanel: true,
    stats: {},
  }));
  const options = {
    getLayers: () => layers,
    isEnabled: () => false,
    getRowControls: () => null,
    hasRowControls: () => false,
  };
  const rows = new LayerPanel(options);
  const standalone = new LayerPanel(options);
  t.after(() => {
    standalone.destroy();
    rows.destroy();
    mountApplicationViews(document, { omit: ['layer-panels'] });
  });
  rows.mount(list);
  standalone.mount(standaloneList);

  document.getElementById('layer-finder-search-btn').click();
  await nextTick();
  const input = document.getElementById('layer-finder-input');
  input.value = 'vessels';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();

  const shown = (container) =>
    [...container.querySelectorAll('.data-toggle-row:not(.is-filtered)')].map(
      (row) => row.dataset.layerId,
    );
  assert.deepEqual(shown(list), ['ais-live-vessels']);
  assert.equal(document.querySelector('.layer-finder__empty'), null);
  assert.deepEqual(shown(standaloneList), [
    'flights',
    'ais-live-vessels',
    'weather-radar',
  ]);
  standalone.finder.select({ query: 'flights' });
  const next = document.body.appendChild(document.createElement('div'));
  standalone.mount(next);
  assert.deepEqual(shown(standaloneList), []);
  assert.deepEqual(shown(next), ['flights']);
  const vessel = next.querySelector('[data-layer-id="ais-live-vessels"]');
  assert.equal(getComputedStyle(vessel).display, 'none');
  const heading = next.querySelector('.data-layer-group-heading.is-filtered');
  assert.equal(getComputedStyle(heading).display, 'none');
  assert.deepEqual(shown(list), ['ais-live-vessels']);

  rows.mount(document.createElement('div'));
  assert.deepEqual(shown(list), []);
  rows.mount(list);
  assert.deepEqual(shown(list), ['ais-live-vessels']);
});

test('unmounting the old controls leaves the replacement attached to the Finder', (t) => {
  const pinia = createPinia();
  const first = document.body.appendChild(document.createElement('div'));
  const next = document.body.appendChild(document.createElement('div'));
  const oldApp = createApp(LayerPanelsView).use(pinia);
  const newApp = createApp(LayerPanelsView).use(pinia);
  oldApp.mount(first);
  newApp.mount(next);
  t.after(() => {
    newApp.unmount();
    first.remove();
    next.remove();
  });
  const finder = useLayerFinderStore(pinia);
  finder.select({ query: 'flights' });
  oldApp.unmount();

  assert.equal(finder.controlsMounted, true);
  assert.equal(finder.inputs().query, 'flights');
});

test('search finds a layer by the name on screen or its English name', async (t) => {
  const { shown, search, list } = fixture(t);
  setLocale('fr');
  await search('pluie');
  assert.deepEqual(shown(), ['weather-radar']);
  await search('rain radar');
  assert.deepEqual(shown(), ['weather-radar']);
  // The Movement heading has no rows left, so it is hidden too.
  assert.equal(
    list
      .querySelector('[data-group="group:Movement"]')
      .classList.contains('is-filtered'),
    true,
  );
  setLocale('en');
  await search('nothing like it');
  assert.deepEqual(shown(), []);
  assert.match(
    document.querySelector('.layer-finder__empty')?.textContent || '',
    /No layers match/,
  );
});

test('typing filters prepared rows and a feed refresh still updates them', async (t) => {
  const { layers, list, rows, search, shown } = fixture(t);
  const layerReads = t.mock.method(rows, 'getAll');
  await search('vesse');
  await search('vessels');
  assert.deepEqual(shown(), ['ais-live-vessels']);
  assert.equal(
    layerReads.mock.callCount(),
    0,
    'search does not reread the presenter inputs',
  );

  const vessels = layers.find(({ id }) => id === 'ais-live-vessels');
  vessels.stats = { count: 12 };
  vessels.enabled = true;
  rows._refreshTogglePanel();
  const row = list.querySelector('[data-layer-id="ais-live-vessels"]');
  assert.equal(row.querySelector('.data-count').textContent.trim(), '12');
  assert.equal(
    row.querySelector('.data-toggle-btn').classList.contains('active'),
    true,
  );
  assert.deepEqual(shown(), ['ais-live-vessels']);
});

test('On and Off follow whether the layer is enabled', async (t) => {
  const { shown, openFilter } = fixture(t);
  const menu = await openFilter();
  const on = [...menu.querySelectorAll('button')].find((b) =>
    b.textContent.trim().endsWith('On'),
  );
  on.click();
  await flush();
  assert.deepEqual(shown(), ['flights']);
  assert.equal(on.getAttribute('aria-pressed'), 'true');
});

test('Show all layers restores the full list from a further-filtered suggestion', async (t) => {
  const { shown, finder, openFilter, search } = fixture(t);
  await search('flights');
  finder.pick(['ais-live-vessels']);
  await nextTick();
  assert.ok(
    !document.getElementById('layer-finder-input'),
    'the old Finder search closes',
  );
  const menu = await openFilter();
  [...menu.querySelectorAll('button')]
    .find((button) => button.textContent.trim().endsWith('Off'))
    .click();
  await flush();
  assert.deepEqual(shown(), ['ais-live-vessels']);
  document.querySelector('[title="Show all layers"]').click();
  await flush();
  assert.deepEqual(shown(), ['flights', 'ais-live-vessels', 'weather-radar']);
  assert.equal(
    document.activeElement,
    document.querySelector('[aria-controls="layer-finder-menu"]'),
  );
});

test('a chosen category survives its heading being translated', async (t) => {
  const { shown, openFilter } = fixture(t);
  const menu = await openFilter();
  [...menu.querySelectorAll('button')]
    .find((b) => b.textContent.trim().endsWith('Weather'))
    .click();
  await flush();
  assert.deepEqual(shown(), ['weather-radar']);
  setLocale('fr');
  await flush();
  assert.deepEqual(shown(), ['weather-radar']);
  assert.match(
    document.querySelector('.layer-finder__chip').textContent,
    /Météo/,
  );
});

test('Escape in the search field closes it without reaching the panel', async (t) => {
  const { search, panel } = fixture(t);
  let reached = false;
  panel.addEventListener('keydown', () => (reached = true));
  await search('vessels');
  assert.equal(document.activeElement?.id, 'layer-finder-input');
  document
    .getElementById('layer-finder-input')
    .dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  await flush();
  assert.equal(reached, false);
  assert.equal(document.getElementById('layer-finder-input') === null, true);
  assert.equal(document.activeElement?.id, 'layer-finder-search-btn');
});

test('the filter menu takes focus, moves with the arrows and closes on Escape', async (t) => {
  const { openFilter } = fixture(t);
  const menu = await openFilter();
  const buttons = [...menu.querySelectorAll('button')];
  assert.equal(document.activeElement, buttons[0]);
  menu.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
  );
  assert.equal(document.activeElement, buttons[1]);
  menu.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
  );
  assert.equal(document.activeElement, buttons.at(-1));
  menu.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  await flush();
  assert.equal(document.getElementById('layer-finder-menu') === null, true);
  assert.equal(
    document.activeElement,
    document.querySelector('[aria-controls="layer-finder-menu"]'),
  );
});

test('clearing the Finder shows every row again immediately', async (t) => {
  const { shown, search, list, rows, finder } = fixture(t);
  const target = list.querySelector('[data-layer-id="flights"]');
  await search('vessels');
  assert.deepEqual(shown(), ['ais-live-vessels']);
  finder.clearAll();
  assert.equal(
    target.classList.contains('is-filtered'),
    false,
    'voice can scroll to the row synchronously',
  );
  target.classList.add('gev-voice-focus');
  rows.rerender();
  assert.ok(target.classList.contains('gev-voice-focus'));
  await flush();
  assert.deepEqual(shown(), ['flights', 'ais-live-vessels', 'weather-radar']);
});

test('stock search and voice use the mounted list Finder', async (t) => {
  const { finder, layers, list, shown, search, rows } = fixture(t);
  finder.select({ query: 'flights' });
  await search('vessels');
  assert.deepEqual(shown(), ['ais-live-vessels']);
  assert.equal(document.querySelector('.layer-finder__empty'), null);
  await search('no matching layer');
  assert.ok(document.querySelector('.layer-finder__empty'));
  await search('vessels');
  rows.rerender();
  assert.deepEqual(shown(), ['ais-live-vessels']);

  const target = list.querySelector('[data-layer-id="flights"]');
  const scroll = t.mock.method(target, 'scrollIntoView', () => {
    assert.equal(target.classList.contains('is-filtered'), false);
  });
  const viewer = {};
  t.after(bindRenderer(viewer, { canvas: document.createElement('canvas') }));
  const runner = createGevActionRunner({
    viewer,
    styleManager: { setPanelCollapsed() {} },
    dataManager: {
      layers: new Map(layers.map((layer) => [layer.id, { module: {} }])),
      getAll: () => layers,
    },
  });
  t.after(runner.dispose);
  const result = await runner('show_data_layers_menu', { layerId: 'flights' });
  assert.equal(result.focusedLayer?.id, 'flights');
  assert.equal(scroll.mock.callCount(), 1);
  assert.equal(finder.narrowed, false);
  await flush();
  assert.equal(document.getElementById('layer-finder-input'), null);

  const detached = document.createElement('div');
  rows.mount(detached);
  await search('weather');
  assert.equal(finder.inputs().query, 'weather');
  rows.mount(list);
  await flush();
  await search('flights');
  assert.deepEqual(shown(), ['flights']);
  assert.equal(finder.inputs().query, 'flights');
});

test('the section index has a tick per group and drops filtered groups', async (t) => {
  const { search } = fixture(t);
  await flush();
  assert.equal(
    document.querySelectorAll('.layer-section-index__tick').length,
    2,
  );
  await search('vessels');
  await flush();
  // One group left: no index.
  assert.equal(
    document.querySelectorAll('.layer-section-index__tick').length,
    0,
  );
});

test('suggested layers are picked out, switched on by nobody, and the chip shows every row again', async (t) => {
  const { shown, finder } = fixture(t);
  finder.pick(['ais-live-vessels', 'weather-radar']);
  await flush();
  assert.deepEqual(shown(), ['ais-live-vessels', 'weather-radar']);
  const chip = [...document.querySelectorAll('.layer-finder__chip')].find((b) =>
    /Suggested/.test(b.textContent),
  );
  assert.ok(chip, 'the bar says the rows are suggested');
  assert.equal(chip.getAttribute('aria-label'), 'Suggested · Show all layers');
  assertSameNode(
    document.activeElement,
    chip,
    'focus moves to the Suggested chip',
  );
  assert.equal(
    document
      .querySelector('[data-layer-id="ais-live-vessels"] .data-toggle-btn')
      .classList.contains('active'),
    false,
    'nothing is switched on',
  );
  chip.click();
  await flush();
  assert.deepEqual(shown(), ['flights', 'ais-live-vessels', 'weather-radar']);
});

test('independent apps keep their own selection and Utilities rows stay visible', (t) => {
  const { finder, shown } = fixture(t);
  const other = useLayerFinderStore(createPinia());
  other.pick(['weather-radar']);
  assert.deepEqual(shown(), ['flights', 'ais-live-vessels', 'weather-radar']);
  finder.pick(['flights']);
  assert.deepEqual(shown(), ['flights']);
  assert.deepEqual(other.inputs().picked, ['weather-radar']);
  assert.equal(
    document
      .querySelector('#utilities-toggles [data-layer-id="directions"]')
      .classList.contains('is-filtered'),
    false,
  );
});
