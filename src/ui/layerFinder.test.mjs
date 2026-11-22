// src/ui/layerFinder.test.mjs — the Data Layers finder and section index work
// on the rows LayerRows renders: search, the On/Off and category filter,
// Escape, the clear request voice sends, and the group ticks.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { getLocale, setLocale } from '../i18n/index.js';
import { createApp, nextTick } from 'vue';
import { LayerPanel } from 'gods-eye-view/ui/layers';
import LayerPanelsView from './views/LayerPanelsView.vue';
import { mountApplicationViews } from './views/index.js';
import {
  LAYER_FINDER_CLEAR_EVENT,
  useLayerFinderStore,
} from './stores/layerFinder.js';

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

test('the public panel uses the mounted view finder without explicit injection', async (t) => {
  document.body.innerHTML = '<div data-gev-view="layer-panels"></div>';
  mountApplicationViews(document);
  const list = document.getElementById('data-toggles');
  const standaloneList = document.createElement('div');
  standaloneList.id = list.id;
  const layers = ['flights', 'ais-live-vessels'].map((id) => ({
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
    document.dispatchEvent(new CustomEvent(LAYER_FINDER_CLEAR_EVENT));
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
  assert.deepEqual(shown(standaloneList), ['flights', 'ais-live-vessels']);
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
  const { shown, finder, openFilter } = fixture(t);
  finder.pick(['ais-live-vessels']);
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

test('a clear request shows every row again', async (t) => {
  const { shown, search, list, rows } = fixture(t);
  const target = list.querySelector('[data-layer-id="flights"]');
  await search('vessels');
  assert.deepEqual(shown(), ['ais-live-vessels']);
  document.dispatchEvent(new CustomEvent(LAYER_FINDER_CLEAR_EVENT));
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
