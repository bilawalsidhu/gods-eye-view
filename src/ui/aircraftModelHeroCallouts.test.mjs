import '../testSupport/registerDom.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinia } from 'pinia';
import { createApp, h, nextTick, ref } from 'vue';
import { loadFleetModelSet } from '../data/fleetModels.js';
import { fetchPublicFile } from '../testSupport/fleetGlb.mjs';
import { HERO_AUTOPLAY_MS } from './entityHeroViews.js';
import { useEntityCardStore } from './stores/entityCard.js';
import AircraftModelHero from './views/panels/AircraftModelHero.vue';

test('each model turn shows the next callout', async (t) => {
  await loadFleetModelSet({ fetchImpl: fetchPublicFile });
  const pinia = createPinia();
  const cards = useEntityCardStore(pinia);
  const record = {
    icao24: 'a1b2c3',
    callsign: 'DAL1',
    typeCode: 'B738',
    category: 'A3',
    lat: 30,
    lon: -97,
  };
  const layer = {
    id: 'flights',
    name: 'Live Flights',
    enabled: true,
    module: { getAnalystRecords: () => [record] },
  };
  const manager = {
    layers: new Map([['flights', layer]]),
    getAll: () => [layer],
    isEnabled: () => true,
  };
  cards.connect({
    dataManager: () => manager,
    previews: () => ({ model: () => ({ setActive() {}, destroy() {} }) }),
  });
  t.after(() => cards.connect(null));
  cards.select({ layerId: 'flights', id: record.icao24, record });
  const subject = cards.card.modelSubject;
  cards.clear();
  const active = ref(true);
  const callouts = ['A', 'B', 'C'].map((label, index) => ({
    label,
    value: String(index + 1),
  }));
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.mock.method(globalThis, 'requestAnimationFrame', (cb) =>
    setTimeout(cb, 16),
  );
  const root = document.createElement('div');
  const app = createApp({
    render: () =>
      h(AircraftModelHero, { subject, callouts, active: active.value }),
  });
  app.use(pinia).mount(root);
  t.after(() => app.unmount());
  const counter = () =>
    root.querySelector('.aircraft-hero__callout em')?.textContent;
  assert.equal(counter(), '01 / 03');
  let elapsed = 0;
  for (const next of ['02 / 03', '03 / 03']) {
    t.mock.timers.tick(HERO_AUTOPLAY_MS - elapsed);
    active.value = false;
    await nextTick();
    active.value = true;
    await nextTick();
    elapsed = 1500;
    // Vue schedules the leave timeout after two animation frames.
    t.mock.timers.tick(16);
    t.mock.timers.tick(16);
    t.mock.timers.tick(elapsed - 32);
    await nextTick();
    assert.equal(counter(), next);
  }
});
