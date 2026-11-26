// src/ui/aircraftCardModel.test.mjs — a selected aircraft's card offers its
// 3D model view: the card reads what picks the fleet model from the entity
// description and hands it to the renderer's card preview. Over happy-dom.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, nextTick } from 'vue';
import { loadFleetModelSet } from '../data/fleetModels.js';
import { fetchPublicFile } from '../testSupport/fleetGlb.mjs';
import ContextView from './views/ContextView.vue';
import { useEntityCardStore } from './stores/entityCard.js';
import { usePanelChromeStore } from './stores/panelChrome.js';

// The card's model view draws only once the fleet model set has loaded.
const silentInfo = console.info;
console.info = () => {};
await loadFleetModelSet({ fetchImpl: fetchPublicFile });
console.info = silentInfo;

const AIRLINER = Object.freeze({
  icao24: 'a1b2c3',
  callsign: 'DAL1',
  typeCode: 'B738',
  category: 'A3',
  lat: 30.27,
  lon: -97.74,
  altitudeM: 9000,
  heading: 90,
});

test('a selected aircraft card shows its 3D model view and asks the renderer for its model', async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 503 });
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(ContextView).use(pinia);
  const cards = useEntityCardStore(pinia);
  const chrome = usePanelChromeStore(pinia);
  let owner = null;
  t.after(() => {
    cards.connect(null);
    if (owner) chrome.detach(owner);
    app.unmount();
    globalThis.fetch = realFetch;
  });
  app.mount(host);
  owner = chrome.connect({});
  const asked = [];
  const previews = {
    model(_host, model) {
      asked.push(model);
      return { setActive() {}, destroy() {} };
    },
  };
  const flights = {
    id: 'flights',
    name: 'Live Flights',
    enabled: true,
    stats: { count: 1, lastUpdate: Date.now() },
    module: { getAnalystRecords: () => [AIRLINER] },
  };
  cards.connect({
    dataManager: () => ({
      layers: new Map([['flights', flights]]),
      isEnabled: (id) => id === 'flights',
      getAll: () => [flights],
    }),
    regionalBrief: async () => null,
    previews: () => previews,
    canFollow: () => false,
  });
  chrome.publish(owner, 'global-context-panel', { collapsed: false });
  assert.ok(
    cards.select({
      layerId: 'flights',
      id: AIRLINER.icao24,
      record: AIRLINER,
    }),
  );
  await nextTick();
  await nextTick();
  assert.equal(cards.card?.kind, 'aircraft');
  assert.ok(
    document.querySelector('.aircraft-hero'),
    'the card shows the aircraft model view',
  );
  assert.equal(asked.length, 1, 'the renderer was asked for the model');
  assert.ok(asked[0].gltf, 'with the fleet model the globe draws');
});
