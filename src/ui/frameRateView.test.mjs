// src/ui/frameRateView.test.mjs — the title bar's FPS readout renders what
// createFrameRateMonitor() publishes and toggles with the backquote key.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { useStatusStore } from './stores/status.js';
import { createFrameRateMonitor } from './frameRateMonitor.js';
import SceneChromeView from './views/SceneChromeView.vue';
import { bindRenderer } from '../render/rendererOf.js';
import { fakeSceneFrame } from '../testSupport/fakeCesiumScene.mjs';

test('the FPS readout sits in the title bar, hidden until the backquote key', async (t) => {
  document.body.replaceChildren();
  const pinia = createPinia();
  const app = createApp(SceneChromeView).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  const readout = () =>
    document.querySelector('#title-bar .frame-rate-readout');
  assert.equal(readout(), null, 'no readout without a monitor');
  const viewer = {
    scene: { postRender: { addEventListener: () => () => {} } },
  };
  bindRenderer(viewer, { frame: fakeSceneFrame(viewer) });
  const monitor = createFrameRateMonitor({
    viewer,
    store: useStatusStore(pinia),
  });
  t.after(() => monitor.destroy());
  await nextTick();
  const element = readout();
  assert.ok(element.previousElementSibling.classList.contains('subtitle'));
  assert.ok(element.classList.contains('scene-text-holdout'));
  assert.equal(element.hidden, true);
  assert.equal(element.textContent, 'FPS —');
  assert.equal(
    element.title,
    'Rendered globe frames per second · toggle with `',
  );
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: '`', bubbles: true, cancelable: true }),
  );
  await nextTick();
  assert.equal(readout().hidden, false);
  monitor.destroy();
  await nextTick();
  assert.equal(readout(), null);
});

test('the title logo is a button that asks for the way back to live at the start view', async (t) => {
  document.body.replaceChildren();
  const pinia = createPinia();
  const app = createApp(SceneChromeView).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  const { useGlobeActionsStore } = await import('./stores/globeActions.js');
  const calls = [];
  useGlobeActionsStore(pinia).connect({ home: () => calls.push('home') });
  const logo = document.querySelector('#title-bar h1 > button.title-logo');
  assert.ok(logo, 'the logo is the title heading’s button');
  assert.equal(
    logo.getAttribute('aria-label'),
    'Back to live at the starting view',
  );
  assert.ok(logo.hasAttribute('data-logo-gaze'));
  logo.click();
  assert.deepEqual(calls, ['home']);
});

test('the title heading keeps its own name beside the logo button', async (t) => {
  document.body.replaceChildren();
  const app = createApp(SceneChromeView).use(createPinia());
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  const heading = document.querySelector('#title-bar h1');
  const named = document.getElementById(
    heading.getAttribute('aria-labelledby'),
  );
  assert.equal(named.textContent.replace(/\s+/g, ' ').trim(), "GOD'S EYE VIEW");
});
