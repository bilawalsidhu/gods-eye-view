// src/ui/renderFailureView.test.mjs — the scene chrome renders the render
// failure notice installRenderFailureNotice() publishes, with its actions.
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
    shown: 1,
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
    shown: 1,
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
    shown: 1,
    retry: null,
    reset: null,
  });
  await nextTick();
  assert.deepEqual(buttons(), []);
  assert.equal(notice().querySelector('.render-failure-hint'), null);
});
