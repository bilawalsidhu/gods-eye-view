import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CctvControls } from './cctvControls.js';
import { CCTV_FRAME_DECODE_WAIT_MS } from './cctvFrames.js';

function element() {
  const classes = new Set();
  return {
    dataset: {},
    src: '',
    removeAttribute(name) {
      if (name === 'src') this.src = '';
    },
    classList: {
      add(...values) {
        values.forEach((value) => classes.add(value));
      },
      remove(...values) {
        values.forEach((value) => classes.delete(value));
      },
      contains(value) {
        return classes.has(value);
      },
      toggle(value, enabled) {
        if (enabled) classes.add(value);
        else classes.delete(value);
      },
    },
  };
}
function fixture(t) {
  const prior = globalThis.Image;
  const requests = [];
  globalThis.Image = class {
    constructor() {
      requests.push(this);
    }
  };
  t.after(() => {
    globalThis.Image = prior;
  });
  const controls = new CctvControls({
    elements: { _cctvFrame: element(), _cctvFrameWrap: element() },
    cctv: {},
    actions: { isEnabled: () => true },
  });
  t.after(() => controls.destroy());
  return { controls, requests };
}

test('a late image completion cannot replace a newer camera preview', (t) => {
  const { controls, requests } = fixture(t);
  controls._queueCctvFrame('first.jpg', 'a', true);
  const stale = requests[0].onload;
  controls._queueCctvFrame('second.jpg', 'b', true);
  assert.equal(requests[0].onload, null);
  requests[1].onload();
  stale();
  assert.equal(controls._frame.src, 'second.jpg');
  assert.equal(controls._frame.cameraId, 'b');
});

test('a camera frame settles once decoded, and a stale decode cannot land', async (t) => {
  const { controls, requests } = fixture(t);
  const decodes = [];
  const queue = (src, id) => {
    controls._queueCctvFrame(src, id, true);
    const request = requests.at(-1);
    request.decode = () =>
      new Promise((resolve) => decodes.push({ src, resolve }));
    return request;
  };
  const first = queue('first.jpg', 'a');
  first.onload();
  assert.equal(controls._frame.hasFrame, false);
  const second = queue('second.jpg', 'b');
  second.onload();
  decodes[1].resolve();
  await Promise.resolve();
  decodes[0].resolve();
  await Promise.resolve();
  assert.equal(controls._frame.src, 'second.jpg');
  assert.equal(controls._frame.cameraId, 'b');
  assert.equal(controls._frame.hasFrame, true);
});

test('a loaded frame shows when its decode rejects or never settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { controls, requests } = fixture(t);
  controls._queueCctvFrame('broken.jpg', 'a', true);
  requests[0].decode = () => Promise.reject(new Error('EncodingError'));
  requests[0].onload();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(controls._frame.src, 'broken.jpg');
  assert.equal(controls._frame.hasFrame, true);

  controls._queueCctvFrame('hidden.jpg', 'b', true);
  requests[1].decode = () => new Promise(() => {});
  requests[1].onload();
  assert.equal(controls._frame.hasFrame, false);
  t.mock.timers.tick(CCTV_FRAME_DECODE_WAIT_MS);
  assert.equal(controls._frame.src, 'hidden.jpg');
  assert.equal(controls._frame.hasFrame, true);
});

test('failed refresh preserves settled pixels, but changing cameras clears them', (t) => {
  const { controls, requests } = fixture(t);
  controls._queueCctvFrame('first.jpg', 'a', true);
  requests[0].onload();
  controls._queueCctvFrame('refresh.jpg', 'a', false);
  requests[1].onerror();
  assert.equal(controls._frame.src, 'first.jpg');
  assert.equal(controls._frame.hasFrame, true);
  controls._queueCctvFrame('other.jpg', 'b', true);
  assert.equal(controls._frame.src, '');
  assert.equal(controls._frame.hasFrame, false);
});

test('destroy invalidates image callbacks and releases each subscription once', (t) => {
  const { controls, requests } = fixture(t);
  let unsubscribed = 0;
  controls.cctv.subscribe = () => () => {
    unsubscribed++;
  };
  controls.connect();
  controls.connect();
  assert.equal(unsubscribed, 1);
  controls._queueCctvFrame('first.jpg', 'a', true);
  const late = requests[0].onload;
  controls.destroy();
  controls.destroy();
  controls.connect();
  late();
  assert.equal(unsubscribed, 2);
  assert.equal(requests[0].onload, null);
  assert.equal(requests[0].onerror, null);
  assert.equal(controls._frame.src, '');
  controls._queueCctvFrame('late.jpg', 'b', true);
  assert.equal(requests.length, 1);
});

test('disposing during camera enable prevents the delayed focus and future clicks', async () => {
  const button = new EventTarget();
  let resolveEnable;
  let enables = 0;
  let focuses = 0;
  const controls = new CctvControls({
    elements: { _cctvPanel: {}, _cctvNextBtn: button },
    cctv: {},
    actions: {
      isEnabled: () => true,
      syncViewport() {},
      toggleEnabled() {
        enables++;
        return new Promise((resolve) => {
          resolveEnable = resolve;
        });
      },
      runExplicitFocus() {
        focuses++;
      },
    },
  });
  button.dispatchEvent(new Event('click'));
  controls.destroy();
  resolveEnable(true);
  await new Promise((resolve) => setImmediate(resolve));
  button.dispatchEvent(new Event('click'));
  assert.equal(enables, 1);
  assert.equal(focuses, 0);
});
