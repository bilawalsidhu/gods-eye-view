import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CctvControls } from './cctvControls.js';

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

test('the camera panel owns the embedded player across visibility, selection and disable transitions', (t) => {
  const { controls, requests } = fixture(t);
  const prior = globalThis.document;
  const children = new Set();
  globalThis.document = {
    hidden: false,
    createElement(tag) {
      return {
        tag,
        setAttribute() {},
        remove() {
          children.delete(this);
        },
      };
    },
  };
  t.after(() => {
    globalThis.document = prior;
  });
  controls._cctvFrameWrap.appendChild = (node) => children.add(node);
  controls._cctvPanel = element();
  controls._cctvSourceBadge = element();
  controls.actions.setPanelCollapsed = () => {};
  const camera = {
    id: 'youtube-buenos-aires',
    name: 'Buenos Aires',
    feedType: 'embed',
    embedUrl:
      'https://www.youtube-nocookie.com/embed/r8Busmkpsh8?playsinline=1',
    sourcePageUrl: 'https://www.youtube.com/watch?v=r8Busmkpsh8',
  };
  const state = {
    enabled: true,
    activeCameraId: camera.id,
    activeCamera: camera,
    cameras: [camera],
  };
  const render = () => controls._renderCctvState(state);
  render();
  assert.equal(children.size, 2);
  assert.equal(
    requests.length,
    0,
    'no synthetic/still preview for a public player',
  );
  assert.equal(controls.store.view.embedded, true);
  assert.equal(controls.store.sourceBadge.label, 'PUBLIC PLAYER · EXTERNAL');
  const player = [...children][0];
  render();
  assert.equal(
    [...children][0],
    player,
    'health refreshes do not reload the player',
  );
  controls._cctvPanel.getClientRects = () => [];
  render();
  assert.equal(
    children.size,
    0,
    'a sheet-hidden expanded panel unloads its player',
  );
  controls._cctvPanel.getClientRects = () => [{}];
  render();
  assert.equal(
    children.size,
    2,
    'showing the sheet recreates the selected player',
  );
  controls._cctvPanel.classList.add('collapsed');
  render();
  assert.equal(children.size, 0);
  controls._cctvPanel.classList.remove('collapsed');
  render();
  assert.equal(children.size, 2);
  document.hidden = true;
  render();
  assert.equal(children.size, 0);
  document.hidden = false;
  render();
  controls._renderCctvState({ ...state, enabled: false });
  assert.equal(children.size, 0);
  render();
  controls._renderCctvState({
    ...state,
    activeCameraId: null,
    activeCamera: null,
  });
  assert.equal(children.size, 0);
  render();
  controls.destroy();
  assert.equal(children.size, 0);
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
