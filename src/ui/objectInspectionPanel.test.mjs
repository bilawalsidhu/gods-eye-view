import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import ObjectInspection from './views/panels/ObjectInspection.vue';
import { useObjectInspectionStore } from './stores/objectInspection.js';

test('inspector renders all supplied details as text, updates the selected object and routes focus/return', async (t) => {
  document.body.replaceChildren();
  const pinia = createPinia();
  const store = useObjectInspectionStore(pinia);
  const calls = [];
  const token = store.connect({
    focus: () => calls.push('focus'),
    restore: () => calls.push('restore'),
  });
  store.publish({
    label: 'SHIP ONE',
    layerName: 'Live AIS',
    source: 'Fixture',
    latitude: 40.1234567,
    longitude: -75,
    fields: [{ label: 'destination', value: '<b>PORT</b>' }],
  });
  store.canReturn = true;
  const app = createApp(ObjectInspection).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => {
    app.unmount();
    store.detach(token);
  });
  assert.equal(document.querySelector('h3').textContent, 'SHIP ONE');
  assert.ok(document.body.textContent.includes('40.123457'));
  assert.ok(document.body.textContent.includes('<b>PORT</b>'));
  assert.equal(document.querySelector('dd b'), null);
  document.querySelector('#inspection-focus').click();
  document.querySelector('#inspection-restore').click();
  assert.deepEqual(calls, ['focus', 'restore']);
  store.publish({
    label: 'SHIP TWO',
    fields: [{ label: 'speed', value: '18 kt' }],
  });
  await nextTick();
  assert.equal(document.querySelector('h3').textContent, 'SHIP TWO');
  assert.ok(!document.body.textContent.includes('<b>PORT</b>'));
  store.canReturn = false;
  await nextTick();
  assert.equal(document.querySelector('#inspection-restore').disabled, true);
});
