import '../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, nextTick } from 'vue';
import PinUndoNotice from '../views/panels/PinUndoNotice.vue';
import { usePinnedStore } from './pinned.js';

function mount(t) {
  const pinia = createPinia();
  const host = document.createElement('div');
  document.body.append(host);
  const app = createApp(PinUndoNotice);
  app.use(pinia);
  app.mount(host);
  t.after(() => {
    app.unmount();
    host.remove();
  });
  return { host, pinned: usePinnedStore(pinia) };
}

test('Undo clicked with the mouse lets the next unpin notice time out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { host, pinned } = mount(t);
  pinned.pin({ key: 'a', kind: 'item', title: 'A' });
  pinned.pin({ key: 'b', kind: 'item', title: 'B' });
  pinned.unpin('a');
  await nextTick();
  const notice = host.querySelector('.pin-undo-notice');
  assert.ok(notice);
  // The pointer moves onto the notice and clicks Undo; the notice leaves
  // under it, so no mouseleave follows.
  notice.dispatchEvent(new window.MouseEvent('mouseenter'));
  notice.querySelector('button').click();
  await nextTick();
  assert.equal(pinned.unpinned, null);
  assert.equal(pinned.isPinned('a'), true);
  pinned.unpin('b');
  await nextTick();
  assert.ok(pinned.unpinned);
  t.mock.timers.tick(8000);
  assert.equal(pinned.unpinned, null, 'the next notice still goes');
});

test('re-pinning a camera with no new frame keeps its saved still', (t) => {
  const { pinned } = mount(t);
  const camera = { key: 'cctv:camera', kind: 'camera', title: 'Camera' };
  pinned.pin({ ...camera, still: 'last frame' });
  pinned.unpin(camera.key);
  pinned.pin(camera);
  assert.equal(pinned.stillOf(camera.key), 'last frame');
  assert.equal(pinned.unpinned, null);
  pinned.unpin(camera.key);
  pinned.pin({ ...camera, still: 'replacement' });
  assert.equal(pinned.stillOf(camera.key), 'replacement');
});

const item = (n) => ({
  key: `k:${n}`,
  kind: 'item',
  title: `I${n}`,
  icon: 'flight',
  identity: {},
});

test('the notice that a pin went stays while it is held', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pinia = createPinia();
  const pinned = usePinnedStore(pinia);
  for (const n of [1, 2, 3, 4, 5]) pinned.pin(item(n));
  assert.equal(pinned.unpinned, null, 'pinning a fifth says nothing');
  pinned.unpin('k:1');
  assert.ok(pinned.unpinned);
  pinned.holdNotice('focus', true);
  pinned.holdNotice('pointer', true);
  pinned.holdNotice('pointer', false);
  t.mock.timers.tick(20_000);
  assert.ok(pinned.unpinned, 'still held by focus');
  pinned.holdNotice('focus', false);
  t.mock.timers.tick(8_000);
  assert.equal(pinned.unpinned, null, 'gone once both let go');
  pinned.unpin('k:2');
  pinned.holdNotice('pointer', true);
  pinned.releaseNotice();
  t.mock.timers.tick(8_000);
  assert.equal(pinned.unpinned, null, 'closing Context lets a held notice go');
});

test('Undo lets go of the focus it had, so the next notice still goes', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pinned = usePinnedStore(createPinia());
  for (const n of [1, 2]) pinned.pin(item(n));
  pinned.unpin('k:1');
  pinned.holdNotice('focus', true);
  pinned.undo();
  assert.ok(pinned.isPinned('k:1'), 'put back');
  pinned.unpin('k:2');
  t.mock.timers.tick(8_000);
  assert.equal(
    pinned.unpinned,
    null,
    'no focusout came, and the notice still went',
  );
});
