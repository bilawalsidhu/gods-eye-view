import test from 'node:test';
import assert from 'node:assert/strict';
import { installPowerSaving } from './powerSaving.js';

function fixture(storage = null) {
  const viewer = {
    targetFrameRate: 60,
    resolutionScale: 1,
    scene: { msaaSamples: 4, requestRender() {} },
  };
  const windowRef = new EventTarget();
  const control = installPowerSaving(viewer, {
    storage,
    documentRef: {},
    windowRef,
  });
  return { viewer, control };
}

test('battery budget reduces continuous rendering work and restores original ownership on teardown', () => {
  const { viewer, control } = fixture();
  assert.equal(viewer.targetFrameRate, 20);
  assert.equal(viewer.resolutionScale, 0.75);
  assert.equal(viewer.scene.msaaSamples, 1);
  assert.equal(viewer.gevOverlayDprLimit, 1);
  assert.equal(control.setProfile('quality'), true);
  assert.equal(viewer.targetFrameRate, 60);
  assert.equal(viewer.resolutionScale, 1);
  assert.equal(viewer.scene.msaaSamples, 4);
  assert.equal(control.setProfile('balanced'), true);
  assert.equal(viewer.targetFrameRate, 30);
  assert.equal(control.setProfile('unknown'), false);
  assert.equal(viewer.targetFrameRate, 30);
  control.destroy();
  control.destroy();
  assert.equal(viewer.targetFrameRate, 60);
  assert.equal(viewer.resolutionScale, 1);
  assert.equal(viewer.scene.msaaSamples, 4);
  assert.equal(Object.hasOwn(viewer, 'gevOverlayDprLimit'), false);
  assert.equal(control.setProfile('battery'), false);
});

test('explicit rendering preference survives reload; inaccessible storage does not prevent startup', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key),
    setItem: (key, value) => values.set(key, value),
  };
  const first = fixture(storage);
  first.control.setProfile('quality');
  first.control.destroy();
  const second = fixture(storage);
  assert.equal(second.control.getState().profile, 'quality');
  second.control.destroy();
  const denied = fixture({
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('denied');
    },
  });
  assert.equal(denied.viewer.targetFrameRate, 20);
  denied.control.setProfile('balanced');
  assert.equal(denied.viewer.targetFrameRate, 30);
  denied.control.destroy();
});

test('profile applies through the accessible control and releases its listener', () => {
  const select = Object.assign(new EventTarget(), { value: '' });
  const status = { textContent: '' };
  const viewer = { scene: { requestRender() {} } };
  const control = installPowerSaving(viewer, {
    storage: null,
    documentRef: {
      getElementById: (id) => (id.endsWith('select') ? select : status),
    },
    windowRef: new EventTarget(),
  });
  assert.equal(select.value, 'battery');
  select.value = 'quality';
  select.dispatchEvent(new Event('change'));
  assert.equal(viewer.targetFrameRate, 60);
  assert.match(status.textContent, /higher power use/);
  control.destroy();
  select.value = 'battery';
  select.dispatchEvent(new Event('change'));
  assert.equal(viewer.targetFrameRate, undefined);
});
