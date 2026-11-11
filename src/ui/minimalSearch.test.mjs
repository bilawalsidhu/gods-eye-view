import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, h, nextTick } from 'vue';
import MinimalSearch from './MinimalSearch.vue';
import { useLocationStore } from './stores/location.js';
import { useProviderSettingsStore } from './stores/providerSettings.js';
import { publishLayerSearch, clearLayerSearch } from './layerSearchCatalog.js';

async function fixture(t, { enabled = false, failed = false } = {}) {
  document.body.replaceChildren();
  const pinia = createPinia();
  const location = useLocationStore(pinia);
  const providers = useProviderSettingsStore(pinia);
  const calls = [];
  const state = { cities: [{ id: 'austin', label: 'Austin' }], searching: false, searchError: null };
  location.publish(state);
  location.connect({
    chooseCity: id => calls.push(['city', id]),
    editSearch() {},
    async search(query) { calls.push(['search', query]); if (failed) location.publish({ ...state, searchError: 'Location not found' }); },
  });
  providers.connect({ open: () => calls.push(['keys']) });
  const owner = {};
  publishLayerSearch(owner, [{ id: 'flights', name: 'Live flights', enabled }], id => calls.push(['toggle', id]));
  const host = document.body.appendChild(document.createElement('div'));
  const app = createApp({ render: () => h(MinimalSearch, { panels: [{ id: 'pp-toggles', label: 'Display' }], onPanel: id => calls.push(['panel', id]) }) }).use(pinia);
  app.mount(host);
  t.after(() => { app.unmount(); clearLayerSearch(owner); });
  async function open() {
    if (!document.querySelector('#minimal-universal-search')) {
      host.querySelector('.console-search-trigger').click();
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    return document.querySelector('#minimal-universal-search');
  }
  const input = await open();
  return { calls, host, input, pinia,
    async type(query) { const input = await open(); input.value = query; input.dispatchEvent(new Event('input', { bubbles: true })); await nextTick(); },
    async enter() { const input = await open(); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await nextTick(); await new Promise(resolve => setTimeout(resolve, 30)); },
  };
}

test('universal search offers a live layer action without querying a provider while typing', async t => {
  const f = await fixture(t);
  await f.type('flights');
  assert.equal(f.calls.length, 0);
  assert.equal(document.querySelector('[data-slot="command-group"]').hidden, false);
  assert.match(document.querySelector('[role="option"]').textContent, /Enable Live flights/);
  await f.enter();
  assert.deepEqual(f.calls, [['toggle', 'flights']]);
});

test('an explicit enable command does not invert an already enabled layer', async t => {
  const f = await fixture(t, { enabled: true });
  await f.type('enable flights');
  await f.enter();
  assert.deepEqual(f.calls, []);
});

test('universal search dispatches known cities, panels and API settings to their owners', async t => {
  const f = await fixture(t);
  for (const query of ['Austin', 'Display', 'API keys']) { await f.type(query); await f.enter(); }
  assert.deepEqual(f.calls, [['city', 'austin'], ['panel', 'pp-toggles'], ['keys']]);
});

test('unmatched place queries use the existing geocoder only on submission', async t => {
  const f = await fixture(t);
  await f.type('Paris');
  assert.deepEqual(f.calls, []);
  await f.enter();
  assert.deepEqual(f.calls, [['search', 'Paris']]);
  assert.equal(document.querySelector('#minimal-universal-search'), null);
});

test('failed place searches retain their query and show the existing error', async t => {
  const f = await fixture(t, { failed: true });
  await f.type('Missing place'); await f.enter();
  assert.equal(f.input.value, 'Missing place');
  assert.equal(document.querySelector('[role="alert"]').textContent, 'Location not found');
});

test('Ctrl+K focuses search and Escape dismisses its results', async t => {
  const f = await fixture(t);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
  await nextTick(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(document.activeElement, f.input);
  await f.type('flight');
  f.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await nextTick();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(document.querySelector('#minimal-universal-search'), null);
});

for (const mode of ['ui-clean-view', 'recording-mode', 'scene-playback-mode']) {
  test(`search closes and ignores its shortcut in ${mode}`, async t => {
    const f = await fixture(t);
    t.after(() => { document.body.className = ''; });
    await f.type('flight');
    document.body.classList.add(mode);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(document.querySelector('#minimal-universal-search'), null);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
    await nextTick();
    assert.equal(document.querySelector('#minimal-universal-search'), null);
    assert.deepEqual(f.calls, []);
    document.body.classList.remove(mode);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.ok(document.querySelector('#minimal-universal-search'));
  });
}


test('the translated Settings command opens the shared settings store', async t => {
  const { setLocale } = await import('../i18n/index.js');
  const { useLocaleStore } = await import('./stores/locale.js');
  const f = await fixture(t);
  t.after(() => setLocale('en'));
  setLocale('de');
  useLocaleStore(f.pinia).publishPicker({ current: 'de' });
  await f.type('Einstellungen');
  const result = document.querySelector('[data-result-id="settings"]');
  assert.ok(result);
  assert.equal(result.textContent.includes('Einstellungen'), true);
  result.click(); await nextTick(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(useProviderSettingsStore(f.pinia).settingsOpen, true);
});
