import test from 'node:test';
import assert from 'node:assert/strict';
import { createCameraCategories } from './cameraCategories.js';

function fixture() {
  const calls = [];
  const engine = {
    id: 'cctv',
    name: 'CCTV',
    init: async (viewer) => {
      calls.push(['init', viewer]);
    },
    enable: () => calls.push(['enable']),
    disable: () => calls.push(['disable']),
    destroy: () => calls.push(['destroy']),
    update: () => calls.push(['update']),
    setCameraCategoryEnabled: (category, enabled) =>
      calls.push([category, enabled]),
    getStats: () => ({
      count: 40,
      categoryCounts: { general: 12, penndot: 28 },
    }),
    getDetectableObjects: ({ category }) => [category],
    getUIState: () => ({ activeCameraId: 'selected' }),
  };
  return { ...createCameraCategories(engine), calls };
}

test('category rows share initialization and playback while toggles and counts remain independent', async () => {
  const { general, penndot, calls } = fixture();
  const viewer = {};
  await Promise.all([general.init(viewer), penndot.init(viewer)]);
  assert.equal(calls.filter(([event]) => event === 'init').length, 1);
  assert.equal(penndot.name, 'PennDOT Traffic Cams');
  assert.equal(general.getStats().count, 12);
  assert.equal(penndot.getStats().count, 28);
  general.enable();
  assert.deepEqual(general.getDetectableObjects(), ['general']);
  assert.deepEqual(penndot.getDetectableObjects(), []);
  penndot.enable();
  assert.equal(calls.filter(([event]) => event === 'enable').length, 1);
  general.disable();
  assert.equal(calls.filter(([event]) => event === 'disable').length, 0);
  assert.deepEqual(general.getDetectableObjects(), []);
  assert.deepEqual(penndot.getDetectableObjects(), ['penndot']);
  penndot.update();
  assert.equal(calls.filter(([event]) => event === 'update').length, 1);
  penndot.disable();
  assert.equal(calls.filter(([event]) => event === 'disable').length, 1);
  general.destroy(viewer);
  assert.equal(calls.filter(([event]) => event === 'destroy').length, 0);
  penndot.destroy(viewer);
  assert.equal(calls.filter(([event]) => event === 'destroy').length, 1);
});

test('the only initialized category releases the shared viewer on destruction', async () => {
  const { general, calls } = fixture();
  await general.init({});
  general.enable();
  general.destroy();
  assert.equal(calls.filter(([event]) => event === 'destroy').length, 1);
});

test('a failed shared initialization can retry without starting duplicate engines', async () => {
  let attempts = 0;
  const camera = {
    setCameraCategoryEnabled() {},
    async init() {
      if (++attempts === 1) throw Error('offline');
    },
  };
  const { general, penndot } = createCameraCategories(camera);
  await assert.rejects(general.init({}), /offline/);
  await Promise.all([general.init({}), penndot.init({})]);
  assert.equal(attempts, 2);
});
