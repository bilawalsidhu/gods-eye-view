// The camera card reads its figures and source line from the Cameras layer
// itself (stores/entityCard.js cameraDetails → the layer's cameraDetails).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import cctvLayer, { _setCctvCoverageStateForTest } from './cctv.js';

test('the Cameras layer describes a camera it holds for its card', (t) => {
  t.after(() => _setCctvCoverageStateForTest({ enabled: false }));
  _setCctvCoverageStateForTest({
    records: [
      {
        camera: {
          id: 'atx-1',
          name: ' Lamar at 5th ',
          city: 'Austin',
          provider: 'TxDOT',
          credit: '',
          feedType: 'image',
          headingDeg: 90,
          fovDeg: 40,
          rangeM: Number.NaN,
          frameRefreshMs: 2_000,
        },
      },
    ],
  });
  assert.equal(typeof cctvLayer.cameraDetails, 'function');
  assert.deepEqual(cctvLayer.cameraDetails('atx-1'), {
    name: 'Lamar at 5th',
    city: 'Austin',
    provider: 'TxDOT',
    credit: null,
    feedType: 'image',
    browserOnly: false,
    headingDeg: 90,
    headingEstimated: false,
    fovDeg: 40,
    rangeM: null,
    // Never faster than the 10 s every card refresh keeps to.
    refreshMs: 10_000,
  });
  assert.equal(cctvLayer.cameraDetails('unknown'), null);
});

test('camera details flag a synthetic facing as estimated and keep manual or curated headings', (t) => {
  t.after(() => _setCctvCoverageStateForTest({ enabled: false }));
  const inferred = { headingDeg: 90, headingConfidence: 'low' };
  _setCctvCoverageStateForTest({
    records: [
      { camera: { ...inferred, id: 'synthetic' } },
      { camera: { ...inferred, id: 'manual', calSource: 'manual' } },
      { camera: { ...inferred, id: 'curated', poseSource: 'curated' } },
    ],
  });
  for (const id of ['synthetic', 'manual', 'curated']) {
    const details = cctvLayer.cameraDetails(id);
    assert.equal(details.headingDeg, 90, id);
    assert.equal(details.headingEstimated, id === 'synthetic', id);
  }
});

// A camera someone picks (Next or Previous, voice, a Data Layers row, a
// click on the globe) reaches Context as `{layerId: 'cctv', id}` only
// (entityContextBridge.js): the card is built from the layer's own record.
test('a picked camera opens a real card from the Cameras layer', async (t) => {
  const { createPinia } = await import('pinia');
  const { useEntityCardStore } = await import('../ui/stores/entityCard.js');
  t.after(() => _setCctvCoverageStateForTest({ enabled: false }));
  _setCctvCoverageStateForTest({
    records: [
      {
        camera: {
          id: 'atx-1',
          name: 'Lamar at 5th',
          city: 'Austin',
          provider: 'TxDOT',
          lat: 30.2685,
          lon: -97.7545,
          headingDeg: 90,
          frameRefreshMs: 2_000,
        },
      },
    ],
  });
  const cards = useEntityCardStore(createPinia());
  const cctv = {
    id: 'cctv',
    name: 'Cameras',
    enabled: true,
    module: cctvLayer,
  };
  cards.connect({
    dataManager: () => ({
      layers: new Map([['cctv', cctv]]),
      isEnabled: (id) => id === 'cctv',
      getAll: () => [cctv],
      subscribe: () => () => {},
    }),
    regionalBrief: async () => null,
    previews: () => null,
    canFollow: () => false,
  });
  t.after(() => cards.connect(null));
  assert.equal(cards.select({ layerId: 'cctv', id: 'atx-1' }), true);
  assert.equal(cards.card?.key, 'cctv:atx-1');
  assert.equal(cards.card?.title, 'Lamar at 5th');
  assert.equal(cards.card?.lat, 30.2685);
  assert.equal(cards.cameraDetails('atx-1')?.provider, 'TxDOT');
});
