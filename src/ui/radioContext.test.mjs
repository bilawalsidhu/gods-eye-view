// src/ui/radioContext.test.mjs — useRadioLayer finds the Radio layer when
// the shell connects, follows a replaced layer, and polls for nothing.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, h, nextTick } from 'vue';
import { useRadioLayer } from './radioContext.js';
import { useEntityCardStore } from './stores/entityCard.js';

function radioModule(name, calls) {
  return {
    subscribe(listener) {
      calls.push(`subscribe ${name}`);
      listener({ enabled: true, name });
      return () => calls.push(`unsubscribe ${name}`);
    },
  };
}

test('the Radio layer is attached when the shell connects, and again when it is replaced', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const pinia = createPinia();
  const cards = useEntityCardStore(pinia);
  let radio = null;
  const host = document.body.appendChild(document.createElement('div'));
  const app = createApp({
    setup() {
      radio = useRadioLayer();
      return () => h('div');
    },
  }).use(pinia);
  app.mount(host);
  t.after(() => {
    app.unmount();
    host.remove();
  });
  // Mounted before the layer manager is connected: nothing yet.
  assert.equal(radio.module.value, null);
  const calls = [];
  const layers = new Map([['radio', { module: radioModule('a', calls) }]]);
  const listeners = new Set();
  cards.connect({
    dataManager: () => ({
      layers,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }),
  });
  await nextTick();
  assert.equal(radio.ui.value?.name, 'a', 'attached on connect, no wait');
  // The layer is replaced; the manager's next change re-attaches.
  layers.set('radio', { module: radioModule('b', calls) });
  for (const listener of listeners) listener({ type: 'registrations' });
  await nextTick();
  assert.equal(radio.ui.value?.name, 'b');
  assert.deepEqual(calls, ['subscribe a', 'unsubscribe a', 'subscribe b']);
  // Nothing is polling: no timers wait.
  t.mock.timers.tick(60_000);
  assert.deepEqual(calls, ['subscribe a', 'unsubscribe a', 'subscribe b']);
  cards.connect(null);
});
