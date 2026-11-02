import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTick } from 'vue';
import { createUiRuntime, applicationPinia } from './vueRuntime.js';
import { createWellRecordUi } from './wellRecordUi.js';
import WellRecordsView from './views/WellRecordsView.vue';
import { createRecordPicker } from '../layers/usGroundwater/recordPicker.js';

test('Vue record actions retain keyed focus, navigate, reject disabled actions and release missing records', async () => {
  const host = document.body.appendChild(document.createElement('div'));
  const actions = document.body.appendChild(document.createElement('div'));
  actions.id = 'world-overlay-actions';
  const map = document.body.appendChild(document.createElement('button'));
  const runtime = createUiRuntime({ pinia: applicationPinia() });
  runtime.mount(WellRecordsView, host);
  const ui = createWellRecordUi();
  let selected, highlighted;
  const view = {
    records: [
      { id: 'a', label: 'record a' },
      { id: 'b', label: 'record b' },
    ],
    disabled: false,
    select: (id) => {
      selected = id;
    },
    focus: (id, focused) => {
      highlighted = focused ? id : null;
    },
    focusMap: () => map.focus(),
  };
  ui.publishRecords(view);
  await nextTick();
  const first = document.querySelector('[data-record-id="a"]');
  const second = document.querySelector('[data-record-id="b"]');
  first.focus();
  await nextTick();
  assert.equal(highlighted, 'a');
  ui.publishRecords({ ...view });
  await nextTick();
  assert.equal(document.activeElement, first);
  assert.equal(document.querySelector('[data-record-id="a"]'), first);
  first.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
  );
  assert.equal(document.activeElement, second);
  second.click();
  assert.equal(selected, 'b');
  selected = null;
  ui.publishRecords({ ...view, disabled: true });
  await nextTick();
  second.click();
  assert.equal(selected, null);
  assert.equal(second.getAttribute('aria-disabled'), 'true');
  ui.publishRecords(null);
  await nextTick();
  assert.equal(document.activeElement, map);
  assert.equal(document.querySelector('[data-record-id]'), null);
  assert.equal(document.querySelector('.well-record-focus'), null);
  runtime.destroy();
  host.remove();
  actions.remove();
  map.remove();
});

test('Vue coincident chooser preserves identity, restores focus and cannot select after cancellation', async () => {
  const host = document.body.appendChild(document.createElement('div'));
  const actions = document.body.appendChild(document.createElement('div'));
  actions.id = 'world-overlay-actions';
  const previous = document.body.appendChild(document.createElement('button'));
  const runtime = createUiRuntime({ pinia: applicationPinia() });
  runtime.mount(WellRecordsView, host);
  const ui = createWellRecordUi();
  let selected, stale;
  const picker = createRecordPicker(
    (entity) => {
      selected = entity;
    },
    (view) => {
      stale = view ?? stale;
      ui.publishChoices(view);
    },
  );
  const records = [
    { id: 'a', name: 'source a' },
    { id: 'b', name: 'source b' },
  ];
  previous.focus();
  picker.choose(records);
  await nextTick();
  const dialog = document.querySelector('.well-record-dialog');
  assert.ok(dialog);
  assert.match(dialog.textContent, /may describe the same physical well/);
  const select = dialog.querySelector('select');
  assert.equal(document.activeElement, select);
  select.value = 'b';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
  dialog.querySelector('button').click();
  await nextTick();
  assert.equal(selected, records[1]);
  assert.equal(document.activeElement, previous);
  assert.equal(document.querySelector('.well-record-dialog'), null);
  picker.choose(records);
  await nextTick();
  const abandoned = stale;
  document
    .querySelector('.well-record-dialog')
    .dispatchEvent(new Event('cancel', { cancelable: true }));
  await nextTick();
  selected = null;
  abandoned.select('a');
  assert.equal(selected, null);
  assert.equal(document.querySelector('.well-record-dialog'), null);
  picker.close();
  runtime.destroy();
  host.remove();
  actions.remove();
  previous.remove();
});
