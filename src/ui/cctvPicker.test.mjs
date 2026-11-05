// src/ui/cctvPicker.test.mjs — the camera picker lists the cameras in view and
// says how many more the view leaves out.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, nextTick } from 'vue';
import { CctvControls } from './cctvControls.js';
import { useCctvStore } from './stores/cctv.js';
import CctvPanel from './views/panels/CctvPanel.vue';

function fixture(t) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(CctvPanel).use(pinia);
  app.mount(host);
  const select = document.getElementById('cctv-camera-select');
  const controls = new CctvControls({
    elements: {
      _cctvPanel: document.getElementById('cctv-panel'),
      _cctvSelect: select,
    },
    cctv: {},
    actions: {
      isEnabled: () => true,
      setPanelCollapsed() {},
      syncViewport() {},
    },
    store: useCctvStore(pinia),
  });
  t.after(() => {
    controls.destroy();
    app.unmount();
  });
  const render = async (state) => {
    controls._renderCctvState(state);
    await nextTick();
  };
  const values = () => [...select.options].map((option) => option.value);
  return { controls, select, render, values };
}

const camera = (id) => ({ id, city: 'Austin', name: `Cam ${id}` });

test('the picker closes with the count of cameras outside the view', async (t) => {
  const { select, render, values } = fixture(t);
  await render({
    enabled: true,
    count: 40,
    cameraIndex: [camera('a'), camera('b')],
  });
  assert.deepEqual(values(), ['a', 'b', '']);
  assert.equal(select.options[0].textContent, 'Austin · Cam a');
  const note = select.options[2];
  assert.equal(note.disabled, true);
  assert.equal(note.dataset.cctvOutside, '');
  assert.equal(
    note.textContent,
    '38 more cameras outside this view · pan or zoom out',
  );
  assert.equal(select.selectedIndex, -1, 'nothing active, nothing picked');

  await render({
    enabled: true,
    count: 2,
    cameraIndex: [camera('a'), camera('b')],
  });
  assert.deepEqual(
    values(),
    ['a', 'b'],
    'a view holding every camera has no note',
  );
});

test('with no camera in view, the closed picker shows the note', async (t) => {
  const { select, render } = fixture(t);
  await render({ enabled: true, count: 1, cameraIndex: [] });
  assert.equal(select.options.length, 1);
  assert.equal(
    select.options[select.selectedIndex].textContent,
    '1 more camera outside this view · pan or zoom out',
  );
  assert.equal(select.value, '');
});

test('a disabled layer has no note', async (t) => {
  const { select, render } = fixture(t);
  await render({ enabled: false, count: 40, cameraIndex: [] });
  assert.equal(select.options.length, 0);
  assert.equal(select.selectedIndex, -1);
  assert.equal(select.disabled, true);
});

test('the active camera is the one picked', async (t) => {
  const { select, render } = fixture(t);
  const [a, b] = [camera('a'), camera('b')];
  await render({
    enabled: true,
    count: 2,
    cameraIndex: [a, b],
    activeCameraId: 'b',
    activeCamera: b,
  });
  assert.equal(select.value, 'b');
  assert.equal(select.disabled, false);
});

test('a camera activated under a focused picker counts against the note', async (t) => {
  const { select, render, values } = fixture(t);
  const a = camera('a');
  const b = camera('b');
  await render({
    enabled: true,
    count: 3,
    cameraIndex: [a],
    activeCameraId: 'a',
    activeCamera: a,
  });
  assert.equal(
    select.options[select.options.length - 1].textContent,
    '2 more cameras outside this view · pan or zoom out',
  );
  select.focus();
  await render({
    enabled: true,
    count: 3,
    cameraIndex: [b, a],
    activeCameraId: 'b',
    activeCamera: b,
  });
  assert.deepEqual(values(), ['b', 'a', '']);
  assert.equal(
    select.options[select.options.length - 1].textContent,
    '1 more camera outside this view · pan or zoom out',
  );
  assert.equal(select.value, 'b');
});

test('a focused picker that empties is disabled and shows the note', async (t) => {
  const { select, render, values } = fixture(t);
  await render({ enabled: true, count: 3, cameraIndex: [camera('a')] });
  select.focus();
  await render({ enabled: true, count: 3, cameraIndex: [] });
  assert.equal(select.disabled, true);
  assert.deepEqual(values(), ['']);
  assert.equal(select.selectedIndex, 0, 'no stale camera is picked');
});

test('a focused picker keeps its options until it lets go', async (t) => {
  const { select, render, values } = fixture(t);
  await render({ enabled: true, count: 3, cameraIndex: [camera('a')] });
  select.focus();
  await render({ enabled: true, count: 3, cameraIndex: [camera('b')] });
  assert.deepEqual(values(), ['a', '']);
  select.blur();
  await nextTick();
  assert.deepEqual(values(), ['b', '']);
});

test('losing the active camera clears the pick', async (t) => {
  const { select, render } = fixture(t);
  const a = camera('a');
  await render({
    enabled: true,
    count: 1,
    cameraIndex: [a],
    activeCameraId: 'a',
    activeCamera: a,
  });
  assert.equal(select.value, 'a');
  await render({ enabled: true, count: 1, cameraIndex: [a] });
  assert.equal(select.selectedIndex, -1);
});

test('the last camera outside the view, added under focus, drops the note', async (t) => {
  const { select, render, values } = fixture(t);
  const [a, b] = [camera('a'), camera('b')];
  await render({ enabled: true, count: 2, cameraIndex: [a] });
  assert.deepEqual(values(), ['a', '']);
  select.focus();
  await render({
    enabled: true,
    count: 2,
    cameraIndex: [b],
    activeCameraId: 'b',
    activeCamera: b,
  });
  assert.deepEqual(values(), ['b', 'a']);
  assert.equal(select.value, 'b');
});

test('other panel updates leave the picker alone', async (t) => {
  const { controls, select, render } = fixture(t);
  const [a, b] = [camera('a'), camera('b')];
  await render({
    enabled: true,
    count: 2,
    cameraIndex: [a, b],
    activeCameraId: 'a',
    activeCamera: a,
  });
  const before = [...select.options];
  // The user arrows to another camera while its activation is pending.
  select.value = 'b';
  controls.store.setSummary('Typing…');
  controls.store.setSourceBadge({ label: 'LIVE · OK', state: 'ready' });
  await nextTick();
  assert.equal(select.value, 'b');
  assert.ok(
    [...select.options].every((option, index) => option === before[index]),
    'the options are the same elements',
  );
});

test('an active id without its camera record leaves the pick alone', async (t) => {
  const { select, render } = fixture(t);
  const [a, b] = [camera('a'), camera('b')];
  await render({ enabled: true, count: 2, cameraIndex: [a, b] });
  select.value = 'b';
  await render({
    enabled: true,
    count: 2,
    cameraIndex: [a, b],
    activeCameraId: 'a',
  });
  assert.equal(select.value, 'b');
});
