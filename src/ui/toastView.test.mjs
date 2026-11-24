// src/ui/toastView.test.mjs — the page toast renders what its owners'
// createToast() publish, each owner on its own timer.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { useStatusStore } from './stores/status.js';
import { createToast } from './toast.js';
import SceneChromeView from './views/SceneChromeView.vue';

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  document.body.replaceChildren();
  const pinia = createPinia();
  const app = createApp(SceneChromeView).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  const store = useStatusStore(pinia);
  const toast = () => document.getElementById('toast');
  return { store, toast };
}

test('a toast shows its message, then fades out keeping its text', async (t) => {
  const { store, toast } = fixture(t);
  assert.equal(toast().textContent, '');
  assert.equal(toast().classList.contains('visible'), false);
  const owner = createToast({ durationMs: 2000, store });
  owner.show('Link copied');
  await nextTick();
  assert.equal(toast().textContent, 'Link copied');
  assert.equal(toast().classList.contains('visible'), true);
  assert.equal(toast().getAttribute('role'), 'status');
  t.mock.timers.tick(1999);
  await nextTick();
  assert.equal(toast().classList.contains('visible'), true);
  t.mock.timers.tick(1);
  await nextTick();
  assert.equal(toast().classList.contains('visible'), false);
  assert.equal(toast().textContent, 'Link copied');
});

test('a newer toast restarts the time, and another owner hides it on its own time', async (t) => {
  const { store, toast } = fixture(t);
  const shell = createToast({ durationMs: 2000, store });
  const scenes = createToast({ durationMs: 2600, store });
  scenes.show('Scene not saved');
  t.mock.timers.tick(1000);
  shell.show('Saved');
  t.mock.timers.tick(1600);
  await nextTick();
  assert.equal(toast().textContent, 'Saved');
  assert.equal(toast().classList.contains('visible'), false);
  shell.show('Again');
  scenes.cancel();
  shell.hide();
  await nextTick();
  assert.equal(toast().classList.contains('visible'), false);
  assert.equal(toast().textContent, 'Again');
  t.mock.timers.tick(5000);
  assert.equal(store.toast.text, 'Again');
  assert.equal(store.toast.visible, false);
});

test('a repeated message is written again so the live region announces it', async (t) => {
  const { store, toast } = fixture(t);
  const owner = createToast({ durationMs: 2000, store });
  owner.show('Fly to a POI first');
  await nextTick();
  const first = toast().firstChild;
  t.mock.timers.tick(2000);
  await nextTick();
  assert.ok(toast().firstChild === first, 'fading out leaves the text alone');
  owner.show('Fly to a POI first');
  await nextTick();
  assert.equal(toast().textContent, 'Fly to a POI first');
  assert.ok(toast().firstChild !== first, 'the repeat is a new text node');
  assert.equal(toast().classList.contains('visible'), true);
});
