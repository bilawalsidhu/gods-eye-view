// The scene chrome renders the render failure notice and its actions.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { useStatusStore } from './stores/status.js';
import SceneChromeView from './views/SceneChromeView.vue';

function mount(t) {
  document.body.replaceChildren();
  const pinia = createPinia();
  const app = createApp(SceneChromeView).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  return useStatusStore(pinia);
}

const notice = () => document.getElementById('render-failure');
const buttons = () =>
  [...(notice()?.querySelectorAll('button') ?? [])].map((button) =>
    button.textContent.trim(),
  );

test('a render failure shows an alert dialog that moves focus to Retry', async (t) => {
  const store = mount(t);
  assert.equal(notice(), null, 'no notice while the globe draws');
  const calls = [];
  store.publishRenderFailure({
    reason: 'render-error',
    detail: 'Expected width to be greater than 0',
    retry: () => calls.push('retry'),
    reset: () => calls.push('reset'),
  });
  await nextTick();
  await nextTick();
  const element = notice();
  assert.equal(element.getAttribute('role'), 'alertdialog');
  assert.equal(
    document.getElementById(element.getAttribute('aria-labelledby'))
      .textContent,
    'The globe stopped drawing',
  );
  assert.match(
    document.getElementById(element.getAttribute('aria-describedby'))
      .textContent,
    /^Rendering stopped after an error\./,
  );
  assert.equal(
    element.querySelector('.render-failure-detail').textContent,
    'Expected width to be greater than 0',
  );
  assert.deepEqual(buttons(), ['Retry', 'Reset view']);
  assert.equal(document.activeElement?.textContent.trim(), 'Retry');
  for (const button of element.querySelectorAll('button')) button.click();
  assert.deepEqual(calls, ['retry', 'reset']);
  store.publishRenderFailure(null);
  await nextTick();
  assert.equal(notice(), null);
});

test('a lost context offers Reload, and a panel that cannot reload offers nothing', async (t) => {
  const store = mount(t);
  store.publishRenderFailure({
    reason: 'context-lost',
    detail: '',
    retry: () => {},
    reset: () => {},
  });
  await nextTick();
  assert.match(
    document.getElementById('render-failure-message').textContent,
    /3D graphics/,
  );
  assert.equal(notice().querySelector('.render-failure-detail'), null);
  assert.deepEqual(buttons(), ['Reload', 'Reset view']);
  store.publishRenderFailure({
    reason: 'context-lost',
    detail: '',
    retry: null,
    reset: null,
  });
  await nextTick();
  assert.deepEqual(buttons(), []);
  assert.equal(notice().querySelector('.render-failure-hint'), null);
});

const failure = () => ({
  reason: 'render-error',
  detail: '',
  retry: () => {},
  reset: null,
});
const settle = async () => {
  await nextTick();
  await nextTick();
};

test('focus goes back where it was when the globe draws again', async (t) => {
  const store = mount(t);
  const search = document.body.appendChild(document.createElement('input'));
  search.focus();
  store.publishRenderFailure(failure());
  await settle();
  assert.equal(document.activeElement?.textContent.trim(), 'Retry');
  store.publishRenderFailure(null);
  await settle();
  assert.equal(document.activeElement, search);
});

// The globe's canvas, as CesiumWidget builds it inside the container.
const addGlobeCanvas = () => {
  const widget = document.createElement('div');
  widget.className = 'cesium-widget';
  document.getElementById('cesiumContainer').appendChild(widget);
  return widget.appendChild(document.createElement('canvas'));
};

test('focus goes to the globe canvas when the element it came from is gone', async (t) => {
  const store = mount(t);
  const canvas = addGlobeCanvas();
  const search = document.body.appendChild(document.createElement('input'));
  search.focus();
  store.publishRenderFailure(failure());
  await settle();
  search.remove();
  store.publishRenderFailure(null);
  await settle();
  // The map's keys, Enter to finish a drawing among them, read the canvas
  // as the map (src/annotations/drawTool.js).
  assert.equal(document.activeElement, canvas);
  assert.equal(canvas.getAttribute('tabindex'), '-1');
  canvas.blur();
  assert.equal(canvas.hasAttribute('tabindex'), false, 'only this once');
});

test('focus goes to the globe canvas when the element it came from cannot take it', async (t) => {
  const store = mount(t);
  const canvas = addGlobeCanvas();
  const button = document.body.appendChild(document.createElement('button'));
  button.focus();
  store.publishRenderFailure(failure());
  await settle();
  button.disabled = true;
  store.publishRenderFailure(null);
  await settle();
  assert.equal(document.activeElement, canvas);
  // A press on the globe leaves focus on the page again, as Cesium has it.
  canvas.dispatchEvent(new Event('pointerdown'));
  assert.equal(document.activeElement, document.body);
  assert.equal(canvas.hasAttribute('tabindex'), false);
});

test('focus the user moved while the notice was up stays put', async (t) => {
  const store = mount(t);
  store.publishRenderFailure(failure());
  await settle();
  const chat = document.body.appendChild(document.createElement('textarea'));
  chat.focus();
  store.publishRenderFailure(null);
  await settle();
  assert.equal(document.activeElement, chat);
});

test('the globe drawing from the start leaves focus alone', async (t) => {
  mount(t);
  await settle();
  assert.equal(document.activeElement, document.body);
  assert.equal(
    document.getElementById('cesiumContainer').hasAttribute('tabindex'),
    false,
  );
});
