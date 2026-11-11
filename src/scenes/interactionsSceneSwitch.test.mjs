// An engine switch before any shot with actions: the next panel must render
// in the new engine's container, not the old (detached) one.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { useSceneInteractionsStore } from '../ui/stores/sceneInteractions.js';
import SceneInteractions from '../ui/views/panels/SceneInteractions.vue';
import { createSceneInteractions } from './interactions.js';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';

const key = (featureId) => JSON.stringify(['qa', featureId]);
const SHOT = {
  interactions: [
    {
      id: 'card',
      label: 'Read about it',
      target: { packId: 'qa', featureId: 'point' },
      action: { type: 'card', text: 'A note.' },
    },
  ],
};

test('Scene actions open in the new engine container after a switch with no panel', async () => {
  document.body.replaceChildren();
  const pinia = createPinia();
  const app = createApp(SceneInteractions).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  const makeEngine = () => {
    const container = document.body.appendChild(document.createElement('div'));
    const canvas = container.appendChild(document.createElement('canvas'));
    return { container, engine: createFakeEngine({ container, canvas }) };
  };
  const first = makeEngine();
  const interactions = createSceneInteractions({
    engine: first.engine,
    execute: async () => true,
    store: useSceneInteractionsStore(pinia),
  });
  // The switch (director.suspendScene / attachScene), no panel shown.
  interactions.setScene(null);
  first.container.remove();
  const second = makeEngine();
  const targets = new Map([[key('point'), {}]]);
  interactions.setScene(second.engine, new Map(targets));
  interactions.activate(SHOT, new Map(targets));
  for (let i = 0; i < 4; i += 1) await nextTick();
  const inOld = Boolean(
    first.container.querySelector('[data-director-interactions]'),
  );
  const inNew = Boolean(
    second.container.querySelector('[data-director-interactions]'),
  );
  interactions.destroy();
  app.unmount();
  first.engine.destroy();
  second.engine.destroy();
  assert.equal(inOld, false, 'not in the old, detached container');
  assert.equal(inNew, true, 'in the new container');
});
