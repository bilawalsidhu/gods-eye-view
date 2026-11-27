import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, h, nextTick, shallowRef } from 'vue';
import { loadCities } from '../data/wikidataCities.js';
import { contextSearchOpen, contextSearchText } from './contextSearch.js';
import { useEntityCardStore } from './stores/entityCard.js';
import { useRadioStore } from './stores/radio.js';
import RadioStations from './views/panels/RadioStations.vue';

test('Radio city, tag and Context text filters compose across zoom and directory refresh', async (t) => {
  const rows = [
    ['Austin', 30.267, -97.743, 961855, 'US', 'Q16559'],
    ['Austin', 49.7, -100, 9000, 'CA', 'Q60'],
    ['Foreign city', 30.267, -97.743, 5000000, 'CA', 'Q1'],
  ];
  await loadCities(async () => ({ ok: true, json: async () => ({ rows }) }));
  let catalog = [
    {
      id: 'news',
      name: 'Morning radio',
      lat: 30.267,
      lon: -97.743,
      countryCode: 'US',
      tags: ['news'],
    },
    {
      id: 'music',
      name: 'Evening music',
      lat: 30.27,
      lon: -97.74,
      country: 'United States',
      tags: ['music'],
    },
    {
      id: 'distant',
      name: 'Big city radio',
      lat: 49.7,
      lon: -100,
      countryCode: 'CA',
      tags: ['news'],
    },
    {
      id: 'rural',
      name: 'Rural radio',
      lat: 31.2,
      lon: -97.74,
      countryCode: 'US',
      tags: ['music'],
    },
    {
      id: 'unknown',
      name: 'Unverified country',
      lat: 30.267,
      lon: -97.743,
      tags: ['news'],
    },
  ];
  const ui = shallowRef({
    source: 'internet',
    enabled: true,
    presentationActive: true,
    acceptedCatalogGeneration: 1,
    filter: 'all',
    categories: [
      { id: 'all', label: 'All' },
      { id: 'news', label: 'News' },
      { id: 'talk', label: 'Talk' },
      { id: 'weather', label: 'Weather / Emergency' },
      { id: 'music', label: 'Music' },
      { id: 'genre:jazz', label: 'Jazz' },
    ],
  });
  const module = {
    getLoadedRadioStations: () => catalog,
    stationMatchesRadioCategory: (station, id) => station.tags.includes(id),
    filterRadioStations: (stations, category) =>
      category === 'all'
        ? stations
        : stations.filter(({ tags }) => tags.includes(category)),
  };
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const inspect = shallowRef(true);
  const app = createApp({
    render: () =>
      inspect.value ? h(RadioStations, { module, ui: ui.value }) : null,
  }).use(pinia);
  const radio = useRadioStore(pinia);
  const owner = radio.connect({
    setRadioFilter: (filter) => {
      ui.value = { ...ui.value, filter };
    },
  });
  t.after(() => {
    app.unmount();
    host.remove();
    radio.detach(owner);
    contextSearchOpen.value = false;
    contextSearchText.value = '';
  });
  app.mount(host);
  const settle = async () => {
    await nextTick();
    await new Promise((resolve) => setImmediate(resolve));
    await nextTick();
  };
  await settle();
  let card = host.querySelector('[data-list-card=radio]');
  const keys = () =>
    [...card.querySelectorAll('[data-list-key]')].map(
      (row) => row.dataset.listKey,
    );
  const chip = (name) =>
    [...card.querySelectorAll('button')].find(
      (button) => button.textContent.trim() === name,
    );
  assert.deepEqual(keys(), ['news', 'music', 'distant', 'rural', 'unknown']);
  const strips = card.querySelectorAll('.city-filter__strip');
  assert.equal(strips.length, 1);
  const stripChips = () => Array.from(strips[0].querySelectorAll('button'));
  const collapsedChips = stripChips();
  assert.deepEqual(
    collapsedChips.map((button) => button.textContent.trim()),
    [
      'All',
      'News',
      'Talk',
      'Weather / Emergency',
      'Music',
      'Jazz',
      'Austin · CA',
      'Austin · US',
    ],
  );
  const reveal = card.querySelector('.city-filter__toggle');
  reveal.focus();
  reveal.click();
  await nextTick();
  assert.equal(reveal.getAttribute('aria-expanded'), 'true');
  assert.equal(document.activeElement, reveal);
  assert.deepEqual(stripChips(), collapsedChips);
  reveal.click();
  await nextTick();
  assert.equal(reveal.getAttribute('aria-expanded'), 'false');
  assert.equal(chip('Foreign city'), undefined);
  chip('Austin · CA').click();
  await settle();
  assert.deepEqual(keys(), ['distant']);
  chip('Austin · US').click();
  await settle();
  assert.deepEqual(keys(), ['news', 'music']);
  chip('News').click();
  await settle();
  assert.deepEqual(keys(), ['news']);
  assert.equal(chip('All').getAttribute('aria-pressed'), 'false');
  assert.equal(chip('News').getAttribute('aria-pressed'), 'true');
  assert.equal(chip('Austin · US').getAttribute('aria-pressed'), 'true');
  contextSearchOpen.value = true;
  contextSearchText.value = 'missing';
  await settle();
  assert.deepEqual(keys(), []);
  assert.deepEqual(
    stripChips().map((button) => button.textContent.trim()),
    ['All', 'News', 'Austin · US'],
  );
  contextSearchText.value = 'morning';
  await settle();
  assert.deepEqual(keys(), ['news']);
  assert.deepEqual(
    stripChips().map((button) => button.textContent.trim()),
    ['All', 'News', 'Austin · US'],
  );
  contextSearchText.value = 'music';
  await settle();
  assert.deepEqual(keys(), []);
  assert.deepEqual(
    stripChips().map((button) => button.textContent.trim()),
    ['All', 'News', 'Music', 'Austin · US'],
  );
  contextSearchText.value = 'morning';
  await settle();
  const firstRow = () => card.querySelector('[data-list-key="news"]');
  const focused = firstRow();
  focused.focus();
  // Hold the city index at its first yield after the directory publishes.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let indexTime = 0;
  const indexClock = t.mock.method(performance, 'now', () => (indexTime += 5));
  catalog = catalog.map((station) =>
    station.id === 'news'
      ? { ...station, name: 'Morning radio updated', lat: 30.268 }
      : station,
  );
  ui.value = { ...ui.value, acceptedCatalogGeneration: 2 };
  useEntityCardStore(pinia).setView({
    center: { lat: -28, lon: 135 },
    heightM: 20_000_000,
  });
  await settle();
  assert.deepEqual(
    keys(),
    ['news'],
    'the station stays in its settled city while the index yields',
  );
  assert.equal(firstRow(), focused);
  assert.equal(document.activeElement, focused);
  assert.match(focused.textContent, /Morning radio updated/);

  contextSearchText.value = 'big city';
  await nextTick();
  chip('Austin · CA').click();
  await nextTick();
  assert.deepEqual(keys(), ['distant']);
  indexClock.mock.restore();
  t.mock.timers.tick(0);
  await settle();
  t.mock.timers.reset();
  assert.deepEqual(keys(), ['distant']);
  assert.equal(chip('Austin · CA').getAttribute('aria-pressed'), 'true');

  contextSearchText.value = 'morning';
  await nextTick();
  chip('Austin · US').click();
  await settle();
  assert.deepEqual(keys(), ['news']);
  catalog = catalog.map((station) =>
    station.id === 'news' ? { ...station, lat: 31.2 } : station,
  );
  ui.value = { ...ui.value, acceptedCatalogGeneration: 3 };
  await settle();
  assert.deepEqual(
    keys(),
    [],
    'an actually moved station leaves the settled city',
  );
  assert.equal(chip('Austin · US').getAttribute('aria-pressed'), 'true');

  const all = chip('All');
  all.click();
  await settle();
  assert.equal(all.getAttribute('aria-pressed'), 'true');
  assert.equal(chip('News').getAttribute('aria-pressed'), 'false');
  assert.equal(chip('Austin · US'), undefined);
  assert.deepEqual(
    keys(),
    ['news'],
    'All leaves the explicit Context text search active',
  );
  contextSearchText.value = '';
  await settle();
  assert.deepEqual(keys(), ['news', 'music', 'distant', 'rural', 'unknown']);
  chip('Austin · CA').click();
  await settle();
  inspect.value = false;
  await settle();
  assert.equal(host.querySelector('[data-list-card=radio]'), null);
  inspect.value = true;
  await settle();
  card = host.querySelector('[data-list-card=radio]');
  assert.equal(chip('Austin · CA').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(keys(), ['distant']);
  catalog = catalog.filter((station) => station.id !== 'distant');
  ui.value = { ...ui.value, acceptedCatalogGeneration: 4 };
  await settle();
  assert.equal(chip('All').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(keys(), ['news', 'music', 'rural', 'unknown']);
});
