// src/ui/imagerySplitView.test.mjs — the imagery dividers render from the
// imagery split store as children of the body, over happy-dom.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { useImagerySplitStore } from './stores/imagerySplit.js';
import { createImagerySplit } from './imagerySplit.js';
import ImagerySplitView from './views/panels/ImagerySplitView.vue';

function fixture(t) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(ImagerySplitView).use(pinia);
  app.mount(host);
  t.after(() => app.unmount());
  const store = useImagerySplitStore(pinia);
  const scene = { splitPosition: 0.37 };
  const changes = [];
  const split = (options = {}) =>
    createImagerySplit({
      scene,
      id: 'split-line',
      handleClass: 'split-handle',
      cssProperty: '--split',
      beforeTitle: 'Before',
      afterTitle: 'After',
      ariaLabel: 'Divider',
      getViewportWidth: () => 1000,
      onChange: (value) => changes.push(value),
      store,
      ...options,
    });
  return { split, scene, changes };
}

const $ = (selector) => document.querySelector(selector);

test('the divider renders on the body with its labels and slider', async (t) => {
  const { split } = fixture(t);
  split({ initialValue: 0.62 });
  await nextTick();
  const line = $('#split-line');
  assert.equal(line.parentElement, document.body);
  const [before, handle, after] = line.children;
  assert.equal(before.className, 'before');
  assert.equal(before.textContent, 'A');
  assert.equal(before.title, 'Before');
  assert.equal(after.className, 'after');
  assert.equal(after.textContent, 'B');
  assert.equal(after.title, 'After');
  assert.equal(handle.tagName, 'BUTTON');
  assert.equal(handle.type, 'button');
  assert.equal(handle.className, 'split-handle');
  assert.equal(handle.textContent, '↔');
  assert.equal(handle.getAttribute('role'), 'slider');
  assert.equal(handle.getAttribute('aria-label'), 'Divider');
  assert.equal(handle.getAttribute('aria-valuemin'), '0');
  assert.equal(handle.getAttribute('aria-valuemax'), '100');
  assert.equal(handle.getAttribute('aria-orientation'), 'horizontal');
  assert.equal(handle.getAttribute('aria-valuenow'), '62');
  assert.equal(
    handle.getAttribute('aria-valuetext'),
    'A 62 percent, B 38 percent',
  );
  assert.equal(
    document.documentElement.style.getPropertyValue('--split'),
    '62%',
  );
});

test('the handle steps by keyboard and drags with the pointer it captured', async (t) => {
  const { split, scene, changes } = fixture(t);
  split();
  await nextTick();
  const handle = $('#split-line button');
  const captured = [];
  const released = [];
  handle.setPointerCapture = (id) => captured.push(id);
  handle.releasePointerCapture = (id) => released.push(id);
  handle.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
  );
  await nextTick();
  assert.equal(scene.splitPosition, 0.51);
  assert.equal(handle.getAttribute('aria-valuenow'), '51');
  const pointer = (type, init) =>
    handle.dispatchEvent(
      new PointerEvent(type, { bubbles: true, pointerId: 7, ...init }),
    );
  pointer('pointerdown', { button: 0, clientX: 250 });
  pointer('pointermove', { clientX: 800 });
  pointer('pointercancel', {});
  pointer('pointermove', { clientX: 100 });
  await nextTick();
  assert.equal(scene.splitPosition, 0.8);
  assert.deepEqual(captured, [7]);
  assert.deepEqual(released, [7]);
  assert.deepEqual(changes, [0.51, 0.25, 0.8]);
  assert.equal(handle.getAttribute('aria-valuenow'), '80');
});

test('hiding and destroying a divider leave other dividers in place', async (t) => {
  const { split } = fixture(t);
  const first = split();
  const second = split({ id: 'second-line' });
  await nextTick();
  first.setVisible(false);
  await nextTick();
  assert.equal($('#split-line').hidden, true);
  assert.equal($('#second-line').hidden, false);
  first.destroy();
  await nextTick();
  assert.equal($('#split-line'), null);
  assert.ok($('#second-line'));
  second.destroy();
  await nextTick();
  assert.equal($('#second-line'), null);
});

test('a divider created before the view mounts renders once it does', async (t) => {
  document.body.replaceChildren();
  const pinia = createPinia();
  const split = createImagerySplit({
    id: 'early-line',
    getViewportWidth: () => 1000,
    store: useImagerySplitStore(pinia),
  });
  const app = createApp(ImagerySplitView).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  await nextTick();
  assert.equal($('#early-line').parentElement, document.body);
  split.destroy();
  await nextTick();
  assert.equal($('#early-line'), null);
});
