import '../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import Explorer from './Explorer.vue';
import { flyToDurban } from './camera.js';

async function fixture(t) {
  document.body.replaceChildren();
  localStorage.clear();
  const entities = new Set();
  const flights = [];
  const viewer = {
    canvas: document.createElement('canvas'),
    entities: {add: (e) => {entities.add(e); return e;}, remove: (e) => entities.delete(e)},
    scene: {requestRender() {}},
    camera: {flyTo: (value) => flights.push(value)},
  };
  const app = createApp(Explorer, {viewer, navigation: {runImmediateNavigation: (_noun, action) => action()}});
  const host = document.body.appendChild(document.createElement('div'));
  app.mount(host);
  t.after(() => {app.unmount(); assert.equal(entities.size, 0);});
  const trigger = host.querySelector('.mz-ribbon button');
  trigger.click(); await nextTick();
  return {host, entities, flights, trigger};
}
test('places drawer searches, saves and filters real reference data', async (t) => {
  const {host, entities} = await fixture(t);
  assert.equal(host.querySelectorAll('.mz-place').length, 3);
  assert.equal(entities.size, 3);
  const search = host.querySelector('input[type=search]');
  search.value = 'airport'; search.dispatchEvent(new Event('input')); await nextTick();
  assert.equal(host.querySelectorAll('.mz-place').length, 1);
  assert.equal(entities.size, 1);
  host.querySelector('[aria-label="Save King Shaka International Airport"]').click(); await nextTick();
  assert.match(host.querySelector('.mz-status').textContent, /this browser/);
  const savedOnly = host.querySelector('input[type=checkbox]');
  savedOnly.checked = true; savedOnly.dispatchEvent(new Event('change')); await nextTick();
  assert.match(host.querySelector('.mz-place').textContent, /King Shaka/);
  const radius = host.querySelectorAll('select')[1];
  radius.value = '2'; radius.dispatchEvent(new Event('change')); await nextTick();
  assert.equal(host.querySelectorAll('.mz-place').length, 0);
  assert.equal(entities.size, 0);
  assert.match(host.querySelector('.mz-empty').textContent, /starter collection/);
});
test('place navigation uses the app camera policy; Escape restores focus', async (t) => {
  const {host, flights, trigger} = await fixture(t);
  host.querySelector('.mz-place-name').click(); await nextTick();
  assert.equal(flights.length, 1);
  assert.ok(host.querySelector('.mz-detail a').href.startsWith('https://icc.co.za/'));
  document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'})); await nextTick();
  assert.equal(host.querySelector('#mz-places'), null);
  assert.equal(document.activeElement, trigger);
});
test('Durban startup has no delayed camera movement', () => {
  let state, cancelled = 0;
  const stop = flyToDurban({isDestroyed: () => false, camera: {setView: (value) => {state = value;}, cancelFlight: () => cancelled++}});
  assert.ok(state.destination);
  assert.equal(state.orientation.pitch, -Math.PI / 2);
  stop(); assert.equal(cancelled, 1);
});
