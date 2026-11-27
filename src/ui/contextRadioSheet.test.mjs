// src/ui/contextRadioSheet.test.mjs — Radio's fold under Context's station
// list follows the phone sheet the shell publishes, over happy-dom.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, nextTick } from 'vue';
import ContextView from './views/ContextView.vue';
import { useDisplayStore } from './stores/display.js';
import { useEntityCardStore } from './stores/entityCard.js';
import { usePanelChromeStore } from './stores/panelChrome.js';
import { resetContextLists } from './contextLists.js';

function fixture(t) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 503 });
  resetContextLists();
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const cards = useEntityCardStore(pinia);
  const chrome = usePanelChromeStore(pinia);
  const owner = chrome.connect({});
  const radioUi = {
    enabled: true,
    stations: [],
    filteredStations: [],
    categories: [],
    filter: 'all',
    audioState: 'stopped',
  };
  const radio = {
    id: 'radio',
    name: 'Radio',
    enabled: true,
    records: [],
    stats: { count: 0 },
    module: {
      getAnalystRecords: () => [],
      subscribe(listener) {
        listener(radioUi);
        return () => {};
      },
    },
  };
  const rows = [radio];
  const manager = {
    layers: new Map(rows.map((row) => [row.id, row])),
    isEnabled: (id) => rows.some((row) => row.id === id && row.enabled),
    getAll: () => rows,
    subscribe: () => () => {},
  };
  cards.connect({
    dataManager: () => manager,
    regionalBrief: async () => null,
    previews: () => null,
    canFollow: () => false,
    follow() {},
    flyTo() {},
  });
  const app = createApp(ContextView).use(pinia);
  app.mount(host);
  t.after(() => {
    cards.connect(null);
    chrome.detach(owner);
    app.unmount();
    resetContextLists();
    globalThis.fetch = realFetch;
  });
  chrome.publish(owner, 'global-context-panel', { collapsed: false });
  return { display: useDisplayStore(pinia) };
}

const foldInList = () =>
  Boolean(document.querySelector('#radio-fold-slot #radio-panel'));

test('the Radio fold moves under the station list when the phone opens the Context sheet', async (t) => {
  const { display } = fixture(t);
  await nextTick();
  await nextTick();
  assert.equal(foldInList(), true, 'on a desktop the fold is under the list');
  // A phone with the Layers sheet open: Context is off screen.
  display.publishPhoneShell({ enabled: true, sheet: 'layers', tabs: [] });
  document.body.classList.add('mobile-shell');
  document.body.setAttribute('data-mobile-sheet', 'layers');
  t.after(() => {
    document.body.classList.remove('mobile-shell');
    document.body.removeAttribute('data-mobile-sheet');
  });
  await nextTick();
  await nextTick();
  assert.equal(foldInList(), false);
  // Switching to the Context sheet brings the fold back under the list.
  document.body.setAttribute('data-mobile-sheet', 'context');
  display.publishPhoneShell({ enabled: true, sheet: 'context', tabs: [] });
  await nextTick();
  await nextTick();
  assert.equal(foldInList(), true);
});
