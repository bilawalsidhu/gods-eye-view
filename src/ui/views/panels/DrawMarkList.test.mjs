// src/ui/views/panels/DrawMarkList.test.mjs — UTILITIES ▸ Draw's shapes:
// one row each, rendered from what the draw tool publishes, with the row
// controls answered through the display store. Rows are updated in place, so
// a board change never takes a half-typed name or the button under a click.
import '../../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { drawMarkActions, presentDrawMarks } from '../../../annotations/drawMarks.js';
import { useDisplayStore } from '../../stores/display.js';
import DrawMarkList from './DrawMarkList.vue';

const LINE = { id: 'a1', type: 'route', manual: true, name: null, label: '950 m', color: 'primary', hidden: false };
const PIN = { id: 'a2', type: 'pin', manual: true, name: 'Camp', label: 'Camp', color: 'amber', hidden: false };
const VOICE = { id: 'a3', type: 'area', manual: false, label: 'Texas', color: 'primary', hidden: false };

function mount(t) {
  document.body.replaceChildren();
  const toggle = document.body.appendChild(document.createElement('button'));
  toggle.id = 'draw-toggle';
  const pinia = createPinia();
  const store = useDisplayStore(pinia);
  const calls = [];
  store.connect(
    new Proxy(
      {},
      { get: (_, name) => (...args) => calls.push([name, ...args]) },
    ),
  );
  const app = createApp(DrawMarkList).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  return { store, calls };
}

async function show(store, marks, actions = []) {
  store.publishDraw({ active: true, shape: 'area', color: 'primary', hint: '', marks: presentDrawMarks(marks, drawMarkActions(actions)) });
  await nextTick();
}
const row = (id) => document.querySelector(`#draw-mark-list [data-mark-id="${id}"]`);
const control = (id, name) => row(id)?.querySelector(`[data-control="${name}"]`);
const key = (el, keyName) => {
  const event = new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true });
  el.dispatchEvent(event);
  return event;
};

test('lists only hand-drawn marks, named or by kind, with Import-style actions', async (t) => {
  const { store } = mount(t);
  const list = document.getElementById('draw-mark-list');
  assert.equal(list.classList.contains('visible'), false);
  await show(store, [LINE, PIN, VOICE]);
  assert.equal(list.classList.contains('visible'), true);
  assert.deepEqual([...list.children].map((node) => node.dataset.markId), ['a1', 'a2']);
  assert.equal(control('a1', 'name').value, '');
  assert.equal(control('a1', 'name').placeholder, 'Line · 950 m');
  assert.equal(control('a2', 'name').value, 'Camp');
  assert.match(control('a2', 'swatch').style.background, /#ffb547|rgb\(255, 181, 71\)/);
  assert.equal(control('a2', 'toggle').getAttribute('aria-label'), 'Hide Camp');
  assert.equal(control('a2', 'toggle').hasAttribute('aria-pressed'), false, 'the label says the state');
  assert.equal(control('a2', 'fly').getAttribute('aria-label'), 'Fly to Camp');
  assert.equal(control('a2', 'remove').getAttribute('aria-label'), 'Remove Camp');
});

test('an application\'s row actions sit before fly to, labelled, and act on their mark', async (t) => {
  const { store, calls } = mount(t);
  const tag = { id: 'tag', icon: 'sell', label: (name) => `Tag ${name}`, shapes: ['line'], run: () => {} };
  await show(store, [{ ...LINE, path: [[0, 0], [1, 0]] }, PIN], [tag]);
  const button = control('a1', 'action-tag');
  assert.equal(button.getAttribute('aria-label'), 'Tag Line · 950 m');
  assert.equal(button.textContent, 'sell');
  assert.equal(button.nextElementSibling, control('a1', 'fly'));
  assert.equal(control('a2', 'action-tag'), null, 'a pin is not offered a line action');
  button.click();
  assert.deepEqual(calls, [['runDrawMarkAction', 'a1', 'tag']]);
  const note = row('a1').querySelector('.draw-mark-note');
  assert.equal(note.getAttribute('role'), 'status');
  assert.equal(note.textContent, '');
  assert.equal(row('a2').querySelector('.draw-mark-note'), null, 'a row without actions has no note');
  const line = { ...LINE, path: [[0, 0], [1, 0]] };
  store.publishDraw({ active: true, shape: 'area', color: 'primary', hint: '', marks: presentDrawMarks([line], drawMarkActions([tag]), new Map([['a1', { busy: true, text: '' }]])) });
  await nextTick();
  assert.equal(control('a1', 'action-tag').getAttribute('aria-disabled'), 'true');
  assert.equal(row('a1').querySelector('.draw-mark-note').textContent, '…');
  store.publishDraw({ active: true, shape: 'area', color: 'primary', hint: '', marks: presentDrawMarks([line], drawMarkActions([tag]), new Map([['a1', { busy: false, text: 'Tagged' }]])) });
  await nextTick();
  assert.equal(control('a1', 'action-tag').getAttribute('aria-disabled'), 'false');
  assert.equal(row('a1').querySelector('.draw-mark-note').textContent, 'Tagged');
});

test('show/hide, fly to and remove act on that one mark', async (t) => {
  const { store, calls } = mount(t);
  await show(store, [LINE, PIN]);
  control('a2', 'toggle').click();
  control('a1', 'fly').click();
  control('a1', 'remove').click();
  assert.deepEqual(calls, [
    ['toggleDrawMark', 'a2'],
    ['flyToDrawMark', 'a1'],
    ['removeDrawMark', 'a1'],
  ]);
  await show(store, [{ ...PIN, hidden: true }]);
  assert.equal(control('a2', 'toggle').getAttribute('aria-label'), 'Show Camp');
  assert.ok(row('a2').classList.contains('hidden-mark'));
});

test('the swatch opens the colours in the row; a colour recolours and closes it', async (t) => {
  const { store, calls } = mount(t);
  await show(store, [LINE]);
  control('a1', 'swatch').click();
  await nextTick();
  assert.equal(control('a1', 'swatch').getAttribute('aria-expanded'), 'true');
  control('a1', 'color-red').click();
  await nextTick();
  await nextTick();
  assert.deepEqual(calls, [['recolorDrawMark', 'a1', 'red']]);
  assert.equal(control('a1', 'picker'), null, 'choosing closes the picker');
  assert.equal(document.activeElement, control('a1', 'swatch'), 'and focus goes back to the swatch');
});

test('a name is saved on Enter or leaving the field; an unchanged one costs nothing', async (t) => {
  const { store, calls } = mount(t);
  await show(store, [LINE, PIN]);
  const name = control('a1', 'name');
  name.focus();
  name.value = '  Ridge walk ';
  key(name, 'Enter');
  assert.deepEqual(calls, [['renameDrawMark', 'a1', 'Ridge walk']]);
  assert.equal(document.activeElement, name, 'Enter keeps focus in the field');
  name.blur();
  assert.equal(calls.length, 1, 'the blur after Enter saves nothing more');
  const pinName = control('a2', 'name');
  pinName.focus();
  pinName.blur();
  assert.equal(calls.length, 1, 'leaving an unchanged name saves nothing');
  pinName.focus();
  pinName.value = 'Base';
  pinName.blur();
  assert.deepEqual(calls.at(-1), ['renameDrawMark', 'a2', 'Base']);
});

test('Escape drops the draft and stays in the list, even with the row\'s colours open', async (t) => {
  const { store, calls } = mount(t);
  await show(store, [PIN]);
  control('a2', 'swatch').click();
  await nextTick();
  const name = control('a2', 'name');
  name.focus();
  name.value = 'Base';
  const event = key(name, 'Escape');
  assert.equal(event.defaultPrevented, true);
  assert.equal(name.value, 'Camp', 'the saved name comes back');
  assert.equal(document.activeElement, name, 'focus stays in the field');
  await nextTick();
  assert.deepEqual(calls, [], 'the draft is not saved');
  // Escape in the open colours closes them and gives focus to the swatch.
  control('a2', 'color-green').focus();
  key(control('a2', 'color-green'), 'Escape');
  await nextTick();
  await nextTick();
  assert.equal(control('a2', 'picker'), null);
  assert.equal(document.activeElement, control('a2', 'swatch'));
});

test('a board change keeps the row, the name being typed and the focus', async (t) => {
  const { store } = mount(t);
  await show(store, [LINE, PIN]);
  const before = row('a1');
  const name = control('a1', 'name');
  name.focus();
  name.value = 'Half typ';
  await show(store, [{ ...LINE, color: 'green' }, PIN, VOICE]);
  assert.equal(row('a1'), before, 'the row is kept');
  assert.equal(control('a1', 'name').value, 'Half typ', 'the draft survives');
  assert.equal(document.activeElement, name);
});

test('when the focused row goes, focus moves to the next row, else the Draw button', async (t) => {
  const { store } = mount(t);
  await show(store, [LINE, PIN]);
  control('a1', 'remove').focus();
  await show(store, [PIN]);
  assert.equal(document.activeElement, control('a2', 'remove'));
  await show(store, []);
  assert.equal(document.activeElement, document.getElementById('draw-toggle'));
});

test('the colours open next to the swatch with the current one focused, and the arrows try others', async (t) => {
  const { store, calls } = mount(t);
  await show(store, [PIN]);
  control('a2', 'swatch').click();
  await nextTick();
  const picker = control('a2', 'picker');
  assert.equal(control('a2', 'swatch').getAttribute('aria-controls'), picker.id);
  assert.equal(picker.previousElementSibling, control('a2', 'swatch'), 'right after its swatch');
  assert.equal(document.activeElement, control('a2', 'color-amber'), 'the current colour has focus');
  assert.deepEqual(
    [...picker.querySelectorAll('[role="radio"]')].map((node) => node.getAttribute('tabindex')),
    ['-1', '0', '-1', '-1', '-1'],
    'one tab stop, on the checked colour',
  );
  key(control('a2', 'color-amber'), 'ArrowRight');
  key(control('a2', 'color-amber'), 'End');
  assert.deepEqual(calls, [
    ['recolorDrawMark', 'a2', 'cyan'],
    ['recolorDrawMark', 'a2', 'red'],
  ]);
  await nextTick();
  assert.ok(control('a2', 'picker'), 'the arrows keep the colours open');
});
