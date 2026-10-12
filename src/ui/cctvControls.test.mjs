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
test('current connection feedback overrides stale successful source health while loading or unavailable', (t) => {
  const { controls } = fixture(t);
  controls._cctvSourceBadge = { dataset: {} };
  const camera = {
    sourceKind: 'live',
    sourceStatus: 'ok',
    retry: { status: 'loading' },
    connection: { status: 'loading' },
  };
  controls._syncCctvSourceBadge(camera, true);
  assert.match(controls._cctvSourceBadge.textContent, /RECONNECTING/);
  assert.equal(controls._cctvSourceBadge.dataset.frameState, 'loading');
  camera.connection.status = 'error';
  controls._syncCctvSourceBadge(camera, true);
  assert.match(controls._cctvSourceBadge.textContent, /UNAVAILABLE/);
  assert.equal(controls._cctvSourceBadge.dataset.frameState, 'error');
});
test('Refresh announces acquisition, preserves keyboard target during cooldown and clears its timer at Close/disposal', (t) => {
  const { controls } = fixture(t);
  const attributes = new Map();
  controls._cctvRefreshBtn = { setAttribute: (k, v) => attributes.set(k, v) };
  controls._cctvRetryStatus = { dataset: {} };
  controls.actions.setPanelCollapsed = () => {};
  const state = {
    enabled: true,
    activeCameraId: 'a',
    activeCamera: {
      id: 'a',
      retry: {
        attempt: 1,
        status: 'loading',
        nextAllowedAt: Date.now() + 5000,
      },
      connection: { status: 'loading', message: 'Reconnecting' },
    },
  };
  controls._renderCctvState(state);
  assert.equal(attributes.get('aria-busy'), 'true');
  assert.equal(attributes.get('aria-disabled'), 'true');
  assert.equal(controls._cctvRefreshBtn.disabled, false);
  assert.equal(controls._cctvRetryStatus.textContent, 'Reconnecting');
  state.activeCamera.retry.status = 'ready';
  state.activeCamera.connection = { status: 'ready', message: 'Connected' };
  controls._renderCctvState(state);
  assert.ok(controls._cctvRetryTimer);
  assert.match(attributes.get('aria-label'), /wait/);
  controls._renderCctvState({ enabled: true, activeCameraId: null });
  assert.equal(controls._cctvRetryTimer, null);
  assert.equal(controls._cctvRetryStatus.hidden, true);
  assert.equal(controls._cctvRefreshBtn.disabled, true);
});

test('mobile expanded and compact viewers paint despite desktop rail collapse; hidden viewers release only the surface', (t) => {
  const { controls } = fixture(t);
  const prior = {
    document: globalThis.document,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  let expanded = true,
    mapFirst = true,
    cameraOpen = true,
    cancelled = 0;
  globalThis.document = {
    hidden: false,
    body: {
      classList: {
        contains: (name) =>
          name === 'mobile-map-first' ? mapFirst : cameraOpen,
      },
    },
  };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => cancelled++;
  t.after(() => Object.assign(globalThis, prior));
  controls._cctvPanel = {
    classList: { contains: () => true },
    closest: () => (expanded ? {} : null),
  };
  controls._cctvVideo = {
    width: 1,
    height: 1,
    getContext: () => ({ clearRect() {}, drawImage() {} }),
  };
  controls.actions.setPanelCollapsed = () => {};
  const decoder = {};
  controls.cctv.getActiveVideoElement = () => decoder;
  const state = {
    enabled: true,
    activeCameraId: 'live',
    activeCamera: { id: 'live', isVideo: true },
  };
  controls._renderCctvState(state);
  const surface = controls._cctvVideoSurface;
  assert.ok(surface);
  expanded = false;
  controls._renderCctvState(state);
  assert.equal(controls._cctvVideoSurface, surface);
  cameraOpen = false;
  controls._renderCctvState(state);
  assert.equal(controls._cctvVideoSurface, null);
  assert.equal(cancelled, 1);
  assert.equal(controls.cctv.getActiveVideoElement(), decoder);
  cameraOpen = true;
  controls._renderCctvState(state);
  assert.ok(controls._cctvVideoSurface);
  globalThis.document.hidden = true;
  controls._renderCctvState(state);
  assert.equal(controls._cctvVideoSurface, null);
  globalThis.document.hidden = false;
  mapFirst = false;
  controls._renderCctvState(state);
  assert.equal(
    controls._cctvVideoSurface,
    null,
    'desktop collapsed policy remains',
  );
});

test('a late image completion cannot replace a newer camera preview', (t) => {
  const { controls, requests } = fixture(t);
  controls._queueCctvFrame('first.jpg', 'a', true);
  const stale = requests[0].onload;
  controls._queueCctvFrame('second.jpg', 'b', true);
  assert.equal(requests[0].onload, null);
  requests[1].onload();
  stale();
  assert.equal(controls._cctvFrame.src, 'second.jpg');
  assert.equal(controls._cctvFrame.dataset.cameraId, 'b');
});

test('failed refresh preserves settled pixels, but changing cameras clears them', (t) => {
  const { controls, requests } = fixture(t);
  controls._queueCctvFrame('first.jpg', 'a', true);
  requests[0].onload();
  controls._queueCctvFrame('refresh.jpg', 'a', false);
  requests[1].onerror();
  assert.equal(controls._cctvFrame.src, 'first.jpg');
  assert.equal(controls._cctvFrameWrap.classList.contains('has-frame'), true);
  controls._queueCctvFrame('other.jpg', 'b', true);
  assert.equal(controls._cctvFrame.src, '');
  assert.equal(controls._cctvFrameWrap.classList.contains('has-frame'), false);
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
  assert.equal(controls._cctvFrame.src, '');
  controls._queueCctvFrame('late.jpg', 'b', true);
  assert.equal(requests.length, 1);
});

function calibrationFixture(t) {
  const { controls } = fixture(t);
  const prior = globalThis.document;
  const inputs = [];
  globalThis.document = {
    createElement() {
      const input = new EventTarget();
      Object.assign(input, {
        focus() {},
        select() {},
        remove() {
          this.parent.input = null;
        },
      });
      inputs.push(input);
      return input;
    },
  };
  t.after(() => {
    globalThis.document = prior;
  });
  const chip = {
    dataset: { calField: 'heading' },
    textContent: '',
    input: null,
    appendChild(input) {
      this.input = input;
      input.parent = this;
    },
    querySelector() {
      return this.input;
    },
  };
  const patches = [];
  controls.actions.setParams = (params) => patches.push(params);
  controls.actions.setPanelCollapsed = () => {};
  controls._cctvCalReadout = { querySelectorAll: () => [chip] };
  controls._cctvState = {
    enabled: true,
    activeCameraId: 'a',
    activeCamera: { id: 'a', headingDeg: 30, basePose: { headingDeg: 20 } },
  };
  const key = (name) =>
    Object.assign(new Event('keydown', { cancelable: true }), { key: name });
  return { controls, chip, inputs, patches, key };
}

test('calibration commits against the captured camera base and releases its editor', (t) => {
  const { controls, chip, inputs, patches, key } = calibrationFixture(t);
  controls._beginCctvCalValueEdit(chip);
  inputs[0].value = '100';
  controls._cctvState.activeCamera.basePose.headingDeg = 60;
  inputs[0].dispatchEvent(key('Enter'));
  inputs[0].dispatchEvent(new Event('blur'));
  assert.deepEqual(patches, [
    {
      selectedCameraId: 'a',
      calibration: { cameraId: 'a', patch: { headingDeg: 80 } },
    },
  ]);
  assert.equal(controls._calibrationEdit, null);
});

test('a camera switch cancels calibration before old blur can change the new camera', (t) => {
  const { controls, chip, inputs, patches } = calibrationFixture(t);
  controls._beginCctvCalValueEdit(chip);
  inputs[0].value = '100';
  controls._renderCctvState({
    enabled: true,
    activeCameraId: 'b',
    activeCamera: { id: 'b', headingDeg: 200, basePose: { headingDeg: 190 } },
  });
  inputs[0].dispatchEvent(new Event('blur'));
  assert.deepEqual(patches, []);
  assert.equal(chip.input, null);
  assert.equal(chip.textContent, 'HDG 200.0°');
});

test('Escape claims calibration cancellation and disposal prevents late commits', (t) => {
  const { controls, chip, inputs, patches, key } = calibrationFixture(t);
  controls._beginCctvCalValueEdit(chip);
  inputs[0].value = '100';
  const escape = key('Escape');
  inputs[0].dispatchEvent(escape);
  inputs[0].dispatchEvent(new Event('blur'));
  assert.equal(escape.defaultPrevented, true);
  controls._beginCctvCalValueEdit(chip);
  inputs[1].value = '120';
  controls.destroy();
  inputs[1].dispatchEvent(new Event('blur'));
  assert.deepEqual(patches, []);
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

test('Close deselects the stream and cancels a pending camera focus without disabling the catalog', async () => {
  const close = new EventTarget(),
    next = new EventTarget();
  let resolveEnable,
    deactivated = 0,
    focused = 0;
  const collapses = [];
  const controls = new CctvControls({
    elements: {
      _cctvPanel: { querySelector: () => close },
      _cctvNextBtn: next,
    },
    cctv: {
      deactivateActiveCamera() {
        deactivated++;
      },
    },
    actions: {
      isEnabled: () => true,
      syncViewport() {},
      toggleEnabled: () =>
        new Promise((resolve) => {
          resolveEnable = resolve;
        }),
      runExplicitFocus() {
        focused++;
      },
      setPanelCollapsed: (...args) => collapses.push(args),
    },
  });
  next.dispatchEvent(new Event('click'));
  close.dispatchEvent(new Event('click'));
  resolveEnable(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deactivated, 1);
  assert.equal(focused, 0);
  assert.deepEqual(collapses, [['cctv-panel', true, { explicit: true }]]);
  controls.destroy();
  close.dispatchEvent(new Event('click'));
  assert.equal(deactivated, 1);
});
