// src/ui/commandDock.test.mjs — the command dock and the scene chrome render
// what VisualSettings publishes, over happy-dom.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, h, nextTick } from 'vue';
import { setLocale } from '../i18n/index.js';
import { useDisplayStore } from './stores/display.js';
import CommandDockView from './views/CommandDockView.vue';
import SceneChromeView from './views/SceneChromeView.vue';
import { VisualSettings } from './visualSettings.js';

function fixture(t) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp({
    render: () => [h(SceneChromeView), h(CommandDockView)],
  }).use(pinia);
  app.mount(host);
  t.after(() => app.unmount());
  const store = useDisplayStore(pinia);
  // VisualSettings publishes through its store; the method needs no more.
  const settings = Object.assign(Object.create(VisualSettings.prototype), {
    store,
    activeStyle: 'normal',
  });
  const $ = (selector) => document.querySelector(selector);
  const active = () =>
    [...document.querySelectorAll('.style-btn.active')].map(
      (button) => button.dataset.style,
    );
  return { $, settings, active };
}

test('before VisualSettings publishes, the dock shows NORMAL', (t) => {
  const { $, active } = fixture(t);
  assert.deepEqual(active(), ['normal']);
  assert.equal($('#style-mini-value').textContent, 'NORMAL');
  assert.equal($('#active-style-name').textContent, 'NORMAL');
});

test('the active style marks its button and labels the dock and the corner', async (t) => {
  const { $, settings, active } = fixture(t);
  settings._publishActiveStyle('thermal');
  await nextTick();
  assert.deepEqual(active(), ['thermal']);
  assert.equal($('#style-mini-value').textContent, 'FLIR');
  assert.equal($('#active-style-name').textContent, 'FLIR');
  settings.activeStyle = 'unlisted';
  settings._publishActiveStyle();
  await nextTick();
  assert.deepEqual(active(), []);
  assert.equal($('#style-mini-value').textContent, 'UNLISTED');
  settings._publishActiveStyle('normal');
  await nextTick();
  assert.deepEqual(active(), ['normal']);
});

test('the style buttons keep classes other code sets', async (t) => {
  const { $, settings } = fixture(t);
  const noir = $('.style-btn[data-style="noir"]');
  noir.classList.add('voice-highlight');
  settings._publishActiveStyle('noir');
  await nextTick();
  assert.equal(noir.classList.contains('voice-highlight'), true);
  assert.equal(noir.classList.contains('active'), true);
});

test('the dock and the corner label the style in the UI language', async (t) => {
  t.after(() => setLocale('en'));
  setLocale('ru');
  const { $, settings } = fixture(t);
  assert.equal($('#style-mini-value').textContent, 'ОБЫЧНЫЙ');
  assert.equal($('#active-style-name').textContent, 'ОБЫЧНЫЙ');
  settings._publishActiveStyle('noir');
  await nextTick();
  assert.equal($('#style-mini-value').textContent, 'НУАР');
  assert.equal($('#active-style-name').textContent, 'НУАР');
});
