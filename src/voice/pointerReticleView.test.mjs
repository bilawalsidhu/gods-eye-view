// src/voice/pointerReticleView.test.mjs — the command dock renders each
// voice pointer reticle where its PointerReticle presents it.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { usePointerReticleStore } from '../ui/stores/pointerReticle.js';
import CommandDockView from '../ui/views/CommandDockView.vue';
import { PointerReticle } from './pointerReticle.js';

test('the reticle shows at the pointed pixel, hides, and leaves on destroy', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  document.body.replaceChildren();
  const pinia = createPinia();
  const app = createApp(CommandDockView).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  const node = () => document.querySelector('.gev-pointer-reticle');
  const reticle = new PointerReticle({
    rectOf: () => ({ left: 10, top: 20 }),
    store: usePointerReticleStore(pinia),
  });
  await nextTick();
  assert.equal(node(), null, 'nothing until the first point');
  reticle.handle({
    type: 'pointer',
    pointer: { kind: 'this', screenPx: { x: 600, y: 200 } },
  });
  await nextTick();
  const element = node();
  assert.ok(element.parentElement === document.body);
  assert.equal(element.getAttribute('aria-hidden'), 'true');
  assert.equal(element.hidden, false);
  assert.equal(element.style.left, '610px');
  assert.equal(element.style.top, '220px');
  assert.equal(element.dataset.target, 'entity');
  reticle.handle({ type: 'state', state: 'idle' });
  await nextTick();
  assert.ok(node() === element, 'hiding keeps the element');
  assert.equal(element.hidden, true);
  reticle.handle({
    type: 'pointer',
    pointer: { kind: 'here', screenPx: { x: 1, y: 2 } },
  });
  await nextTick();
  assert.equal(element.hidden, false);
  assert.equal(element.dataset.target, 'ground');
  reticle.destroy();
  await nextTick();
  assert.equal(node(), null);
});

test('two reticles show two elements', async (t) => {
  document.body.replaceChildren();
  const pinia = createPinia();
  const app = createApp(CommandDockView).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  const store = usePointerReticleStore(pinia);
  const rectOf = () => ({ left: 0, top: 0 });
  const one = new PointerReticle({ rectOf, store });
  const two = new PointerReticle({ rectOf, store });
  t.after(() => {
    one.destroy();
    two.destroy();
  });
  const at = (x) => ({
    type: 'pointer',
    pointer: { kind: 'this', screenPx: { x, y: 0 } },
  });
  one.handle(at(1));
  two.handle(at(2));
  await nextTick();
  const lefts = () =>
    [...document.querySelectorAll('.gev-pointer-reticle')].map(
      (node) => node.style.left,
    );
  assert.deepEqual(lefts(), ['1px', '2px']);
  two.destroy();
  await nextTick();
  assert.deepEqual(lefts(), ['1px']);
});
