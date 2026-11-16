// The Browse dialog renders what src/ui/libraryBrowser.js presents and sends
// clicks and typing back to it.
import '../../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, defineComponent, h, nextTick } from 'vue';
import { createPinia, storeToRefs } from 'pinia';
import { setLocale, t } from '../../../i18n/index.js';
import { libraryEntry } from '../../../library/catalog.js';
import { createLibraryBrowser } from '../../libraryBrowser.js';
import { useDataLibraryStore } from '../../stores/dataLibrary.js';
import { applicationI18n } from '../../i18n.js';
import DataLibraryDialog from './DataLibraryDialog.vue';

const IDS = ['nasa-eonet-events', 'eia-power-plants', 'cctv-nyc-dot'];

/** A library with three entries; Add and Remove change what it lists. */
function fakeLibrary() {
  const added = new Set();
  const listeners = new Set();
  const notify = () => listeners.forEach((listener) => listener());
  return {
    ready: true,
    added,
    calls: [],
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    list: () =>
      IDS.map((id) => ({
        entry: libraryEntry(id),
        available: id !== 'cctv-nyc-dot',
        reason: id === 'cctv-nyc-dot' ? 'operator-opt-in' : null,
        added: added.has(id),
        on: added.has(id),
        busy: false,
        canZoom: added.has(id),
      })),
    summary: () => ({
      entries: IDS.length,
      kinds: { dataset: 2, tiles: 0, pack: 1 },
      themes: ['cameras', 'events', 'infrastructure'],
      available: 2,
      unavailable: 1,
      added: added.size,
      on: added.size,
      features: 0,
      featureLayers: 0,
    }),
    async add(id) {
      added.add(id);
      notify();
      return true;
    },
    async remove(id) {
      added.delete(id);
      notify();
      return true;
    },
    async zoom(id) {
      this.calls.push(['zoom', id]);
      return true;
    },
    async reset() {
      const count = added.size;
      added.clear();
      notify();
      return count;
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 4; i += 1) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

function mount(t_) {
  document.body.replaceChildren();
  const browse = document.createElement('button');
  browse.id = 'data-library-browse';
  document.body.append(browse);
  const pinia = createPinia();
  const store = useDataLibraryStore(pinia);
  const library = fakeLibrary();
  const owner = createLibraryBrowser({
    library,
    publish: (view) => store.publish(view),
  });
  store.connect(owner.controls);
  const Host = defineComponent({
    setup() {
      const { view } = storeToRefs(store);
      return () => (view.value ? h(DataLibraryDialog, { view: view.value }) : null);
    },
  });
  // The page's i18n, as mountApplicationViews installs it: the locale views
  // re-render on.
  const app = createApp(Host).use(pinia).use(applicationI18n());
  app.mount(document.body.appendChild(document.createElement('div')));
  t_.after(() => {
    owner.destroy();
    app.unmount();
    setLocale('en');
  });
  return { owner, library };
}

const $ = (selector) => document.querySelector(selector);
const shownIds = () =>
  [...document.querySelectorAll('#data-library .data-library-item')].map(
    (item) => item.dataset.libraryId,
  );

test('Browse opens a modal on the search field, packs last; Escape returns to Browse', async (t_) => {
  const { owner } = mount(t_);
  assert.equal($('#data-library').open, false);
  owner.open();
  await settle();
  assert.equal($('#data-library').open, true);
  assert.equal(document.activeElement, $('#data-library input[type="search"]'));
  assert.equal($('#data-library-title').textContent.trim(), 'DATA LIBRARY');
  assert.equal(shownIds().at(-1), 'cctv-nyc-dot');
  assert.match(
    $('[data-library-id="cctv-nyc-dot"] .data-library-reason').textContent,
    /CCTV_NYC_ENABLED=1/,
  );
  assert.equal(
    $('[data-library-id="cctv-nyc-dot"] .data-library-action'),
    null,
    'a pack offers no Add',
  );
  $('#data-library').dispatchEvent(new Event('cancel', { cancelable: true }));
  await settle();
  assert.equal($('#data-library').open, false);
  assert.equal(document.activeElement, $('#data-library-browse'));
});

test('filters narrow the list as the viewer types and picks', async (t_) => {
  const { owner } = mount(t_);
  owner.open();
  await settle();
  const search = $('#data-library input[type="search"]');
  search.value = 'eonet';
  search.dispatchEvent(new Event('input'));
  await settle();
  assert.deepEqual(shownIds(), ['nasa-eonet-events']);
  assert.match($('.data-library-status').textContent, /1 of 3/);
  search.value = '';
  search.dispatchEvent(new Event('input'));
  const only = $('.data-library-check input');
  only.checked = true;
  only.dispatchEvent(new Event('change'));
  await settle();
  assert.equal(shownIds().includes('cctv-nyc-dot'), false);
  const theme = $('#data-library select');
  theme.value = 'events';
  theme.dispatchEvent(new Event('change'));
  await settle();
  assert.deepEqual(shownIds(), ['nasa-eonet-events']);
});

test('Add becomes Remove on the same focused button; Zoom closes first', async (t_) => {
  const { owner, library } = mount(t_);
  owner.open();
  await settle();
  const add = $('button[data-library-id="nasa-eonet-events"][data-library-action="add"]');
  add.focus();
  add.click();
  await settle();
  assert.deepEqual([...library.added], ['nasa-eonet-events']);
  const remove = $(
    'button[data-library-id="nasa-eonet-events"]:not([data-library-action="zoom"])',
  );
  assert.equal(remove.dataset.libraryAction, 'remove');
  assert.equal(document.activeElement, remove, 'focus stays on the button');
  assert.equal($('[data-stat="added"] .data-library-stat-value').textContent, '1');
  $('button[data-library-id="nasa-eonet-events"][data-library-action="zoom"]').click();
  await settle();
  assert.equal($('#data-library').open, false);
  assert.deepEqual(library.calls, [['zoom', 'nasa-eonet-events']]);
});

test('Remove all asks twice, then focuses the search field', async (t_) => {
  const { owner, library } = mount(t_);
  await library.add('nasa-eonet-events');
  await library.add('eia-power-plants');
  owner.open();
  await settle();
  const reset = () => $('#data-library .data-library-reset');
  assert.equal(reset().hidden, false);
  reset().click();
  await settle();
  assert.equal(reset().classList.contains('is-armed'), true);
  assert.match(reset().textContent, /CONFIRM/);
  assert.equal(library.added.size, 2, 'one press removes nothing');
  reset().click();
  await settle();
  assert.equal(library.added.size, 0);
  assert.equal(reset().hidden, true);
  assert.equal(document.activeElement, $('#data-library input[type="search"]'));
});

test('a language switch relabels the open dialog and keeps its filters', async (t_) => {
  const { owner } = mount(t_);
  owner.open();
  await settle();
  const search = $('#data-library input[type="search"]');
  search.value = 'eonet';
  search.dispatchEvent(new Event('input'));
  await settle();
  setLocale('de');
  await settle();
  const title = $('#data-library-title').textContent.trim();
  assert.equal(title, t('DATA LIBRARY'));
  assert.notEqual(title, 'DATA LIBRARY');
  assert.equal(
    $('.data-library-action').textContent.trim(),
    t('ADD'),
    'cards follow the locale too',
  );
  assert.equal($('#data-library').open, true);
  assert.equal($('#data-library input[type="search"]').value, 'eonet');
});

test('clean view closes an open dialog', async (t_) => {
  const { owner } = mount(t_);
  owner.open();
  await settle();
  document.body.classList.add('ui-clean-view');
  await settle();
  assert.equal($('#data-library').open, false);
  document.body.classList.remove('ui-clean-view');
});
