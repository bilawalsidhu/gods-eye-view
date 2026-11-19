// src/ui/views/panels/GeoImport.test.mjs — DISPLAY ▸ Import renders the file
// import's rows, sends a pick and the row buttons through the display store,
// and keeps keyboard focus on a row that stays when the focused one goes.
import '../../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { GEO_FILE_ACCEPT } from '../../../data/geoFileImport.js';
import { useDisplayStore } from '../../stores/display.js';
import GeoImport from './GeoImport.vue';

function mount(t) {
  document.body.replaceChildren();
  const pinia = createPinia();
  const store = useDisplayStore(pinia);
  const calls = [];
  const record =
    (name) =>
    (...args) =>
      calls.push([name, ...args]);
  store.connect({
    importGeoFiles: record('importGeoFiles'),
    toggleGeoImport: record('toggleGeoImport'),
    flyToGeoImport: record('flyToGeoImport'),
    removeGeoImport: record('removeGeoImport'),
  });
  const app = createApp(GeoImport).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  return { store, calls };
}
const $ = (id) => document.getElementById(id);
const row = (id) => ({
  id,
  name: `${id}.geojson`,
  ownStyles: false,
  color: '#39d0ff',
  title: id,
  actions: ['toggle', 'fly', 'remove'].map((action) => ({
    icon: action,
    label: `${action} ${id}`,
    action,
    pressed: action === 'toggle' ? 'true' : undefined,
  })),
});
async function show(store, ids, hint = '') {
  store.publishGeoImport({ rows: ids.map(row), hint });
  await nextTick();
}
const button = (id, action) =>
  document.querySelector(
    `[data-import-id="${id}"] button[data-action="${action}"]`,
  );

test('the Import button opens the picker, and a pick goes to the file import', async (t) => {
  const { store, calls } = mount(t);
  const picker = $('geo-import-input');
  assert.equal(picker.getAttribute('accept'), GEO_FILE_ACCEPT);
  let opened = 0;
  picker.click = () => (opened += 1);
  $('geo-import-button').click();
  assert.equal(opened, 0, 'not before the file import presents itself');
  await show(store, []);
  $('geo-import-button').click();
  assert.equal(opened, 1);
  let cleared = false;
  Object.defineProperty(picker, 'value', {
    configurable: true,
    get: () => '',
    set: (value) => (cleared = value === ''),
  });
  const files = [new File(['{}'], 'a.geojson'), new File(['{}'], 'b.kml')];
  Object.defineProperty(picker, 'files', { value: files, configurable: true });
  picker.dispatchEvent(new Event('change'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'importGeoFiles');
  assert.deepEqual(
    calls[0][1].map((file) => file.name),
    ['a.geojson', 'b.kml'],
  );
  assert.ok(cleared, 'the selection clears, so the same file can be picked again');
  Object.defineProperty(picker, 'files', { value: [], configurable: true });
  picker.dispatchEvent(new Event('change'));
  assert.equal(calls.length, 1, 'an empty pick sends nothing');
});

test('rows render what the file import publishes and their buttons call it', async (t) => {
  const { store, calls } = mount(t);
  assert.equal($('geo-import-list').classList.contains('visible'), false);
  await show(store, ['a', 'b'], 'Added 2 files.');
  assert.ok($('geo-import-list').classList.contains('visible'));
  assert.equal($('geo-import-hint').textContent, 'Added 2 files.');
  assert.equal(button('a', 'toggle').getAttribute('aria-pressed'), 'true');
  assert.equal(button('a', 'toggle').getAttribute('aria-label'), 'toggle a');
  button('a', 'toggle').click();
  button('b', 'fly').click();
  button('a', 'remove').click();
  assert.deepEqual(calls, [
    ['toggleGeoImport', 'a'],
    ['flyToGeoImport', 'b'],
    ['removeGeoImport', 'a'],
  ]);
});

test('focus goes to the next row’s same button, then the previous, then Import', async (t) => {
  const { store } = mount(t);
  await show(store, ['a', 'b', 'c']);
  button('b', 'fly').focus();
  await show(store, ['a', 'c']);
  assert.equal(document.activeElement, button('c', 'fly'), 'the next row');
  await show(store, ['a']);
  assert.equal(document.activeElement, button('a', 'fly'), 'the previous row');
  await show(store, []);
  assert.equal(document.activeElement, $('geo-import-button'));
});

test('two rows gone in one render leave focus on the first one’s next row', async (t) => {
  const { store } = mount(t);
  await show(store, ['a', 'b', 'c', 'd', 'e']);
  button('b', 'remove').focus();
  await show(store, ['a', 'c', 'e']);
  assert.equal(document.activeElement, button('c', 'remove'));
});

test('focus outside the removed row stays where it is', async (t) => {
  const { store } = mount(t);
  await show(store, ['a', 'b']);
  button('b', 'toggle').focus();
  await show(store, ['b']);
  assert.equal(document.activeElement, button('b', 'toggle'));
  $('geo-import-button').focus();
  await show(store, []);
  assert.equal(document.activeElement, $('geo-import-button'));
});

test('focus passes through a neighbour that goes in the same render', async (t) => {
  const { store } = mount(t);
  await show(store, ['a', 'b', 'c', 'd']);
  button('b', 'fly').focus();
  await show(store, ['a', 'd']);
  assert.equal(document.activeElement, button('d', 'fly'));
});

test('a row without the same button gives focus to its first one', async (t) => {
  const { store } = mount(t);
  const short = { ...row('b'), actions: row('b').actions.slice(1) };
  store.publishGeoImport({ rows: [row('a'), short], hint: '' });
  await nextTick();
  button('a', 'toggle').focus();
  store.publishGeoImport({ rows: [short], hint: '' });
  await nextTick();
  assert.equal(document.activeElement, button('b', 'fly'));
});
