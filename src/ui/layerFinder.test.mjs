// src/ui/layerFinder.test.mjs — the Data Layers finder and section index work
// on the rows LayerRows renders: search, the On/Off and category filter,
// Escape, the clear request voice sends, and the group ticks.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, h, nextTick } from 'vue';
import LayerFinder, {
  LAYER_FINDER_CLEAR_EVENT,
} from './views/panels/LayerFinder.vue';
import LayerSectionIndex from './views/panels/LayerSectionIndex.vue';

const ROWS = [
  { group: 'movement', heading: 'Movement' },
  { id: 'flights', name: 'Live Flights', english: 'Live Flights', on: true },
  { id: 'ships', name: 'Ships', english: 'Ships', on: false },
  { group: 'weather', heading: 'Weather' },
  { id: 'radar', name: 'Radar météo', english: 'Weather Radar', on: false },
];

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
  const panel = document.body.appendChild(document.createElement('section'));
  panel.id = 'data-panel';
  const header = panel.appendChild(document.createElement('div'));
  const bar = panel.appendChild(document.createElement('div'));
  const list = panel.appendChild(document.createElement('div'));
  list.id = 'data-toggles';
  for (const row of ROWS) {
    if (row.heading) {
      const heading = list.appendChild(document.createElement('h3'));
      heading.className = 'data-layer-group-heading';
      heading.dataset.group = row.group;
      heading.textContent = row.heading;
      continue;
    }
    const el = list.appendChild(document.createElement('div'));
    el.className = 'data-toggle-row';
    el.dataset.layerId = row.id;
    el.dataset.layerName = row.english;
    el.innerHTML = `<span class="data-name">${row.name}</span><button class="data-toggle-btn${row.on ? ' active' : ''}"></button>`;
  }
  const index = panel.appendChild(document.createElement('div'));
  const apps = [
    createApp(() => h(LayerFinder, { part: 'buttons' })),
    createApp(() => h(LayerFinder, { part: 'bar' })),
    createApp(LayerSectionIndex),
  ];
  apps[0].mount(header);
  apps[1].mount(bar);
  apps[2].mount(index);
  t.after(async () => {
    document.dispatchEvent(new CustomEvent(LAYER_FINDER_CLEAR_EVENT));
    for (const app of apps) app.unmount();
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
  return { list, panel, shown, search, openFilter };
}

test('search finds a layer by the name on screen or its English name', async (t) => {
  const { shown, search, list } = fixture(t);
  await search('météo');
  assert.deepEqual(shown(), ['radar']);
  await search('weather radar');
  assert.deepEqual(shown(), ['radar']);
  // The Movement heading has no rows left, so it is hidden too.
  assert.equal(
    list
      .querySelector('[data-group="movement"]')
      .classList.contains('is-filtered'),
    true,
  );
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

test('a chosen category survives its heading being translated', async (t) => {
  const { shown, openFilter, list } = fixture(t);
  const menu = await openFilter();
  [...menu.querySelectorAll('button')]
    .find((b) => b.textContent.trim().endsWith('Weather'))
    .click();
  await flush();
  assert.deepEqual(shown(), ['radar']);
  list.querySelector('[data-group="weather"]').textContent = 'Météo';
  await flush();
  assert.deepEqual(shown(), ['radar']);
  assert.match(
    document.querySelector('.layer-finder__chip').textContent,
    /Météo/,
  );
});

test('Escape in the search field closes it without reaching the panel', async (t) => {
  const { search, panel } = fixture(t);
  let reached = false;
  panel.addEventListener('keydown', () => (reached = true));
  await search('ships');
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
  const { shown, search } = fixture(t);
  await search('ships');
  assert.deepEqual(shown(), ['ships']);
  document.dispatchEvent(new CustomEvent(LAYER_FINDER_CLEAR_EVENT));
  await flush();
  assert.deepEqual(shown(), ['flights', 'ships', 'radar']);
});

test('the section index has a tick per group and drops filtered groups', async (t) => {
  const { search } = fixture(t);
  await flush();
  assert.equal(
    document.querySelectorAll('.layer-section-index__tick').length,
    2,
  );
  await search('ships');
  await flush();
  // One group left: no index.
  assert.equal(
    document.querySelectorAll('.layer-section-index__tick').length,
    0,
  );
});
