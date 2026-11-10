// A CCTV layer that was initialized and then switched off must stay hidden
// across an engine switch: detachRenderer() + attachRenderer() on the new
// engine while _enabled is false must not draw the camera markers. The active
// camera is left for an obstruction probe on the new engine's surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../geo/index.js';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import { loadLayerRenderers } from '../../app/layers/renderers.js';
import cctvLayer, { _setCctvCoverageStateForTest } from '../../data/cctv.js';

await loadLayerRenderers('cesium');

test('disabled CCTV markers stay hidden after an engine switch', () => {
  const first = createFakeEngine({
    width: 1280,
    height: 800,
    altitude: 50_000,
  });
  const second = createFakeEngine({
    width: 1280,
    height: 800,
    altitude: 50_000,
  });
  const position = geo.cartesian3.fromDegrees(0, 0, 10);
  const record = {
    camera: { id: 'cam-1', lat: 0, lon: 0, feedType: 'image' },
    position,
    coverageEntities: [],
    activationDone: true,
  };
  _setCctvCoverageStateForTest({
    engine: first,
    records: [record],
    activeCameraId: 'cam-1',
    enabled: false,
  });
  try {
    cctvLayer.detachRenderer();
    cctvLayer.attachRenderer({ engine: second });
    second.fake.frames(2);
    const set = second.fake.moverSet('cctv');
    assert.ok(set, 'marker set exists');
    assert.equal(
      record.activationDone,
      false,
      'the new surface needs an activation probe',
    );
    assert.equal(record.surfaceProbePending, true);
    assert.equal(set.store.count ?? set.count ?? 1, 1);
    assert.equal(
      set.store.shows[0],
      0,
      'marker of the disabled layer is hidden',
    );
  } finally {
    try {
      cctvLayer.detachRenderer();
    } catch {}
    _setCctvCoverageStateForTest({ enabled: false });
    first.destroy();
    second.destroy();
  }
});
