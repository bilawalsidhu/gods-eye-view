// A renderer failure can leave a chunk without a set when the layer is disabled.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createFirePerimetersLayer } from './index.js';
import { bindRenderer } from '../../render/rendererOf.js';
import { createStubRenderer } from '../../render/stub/index.js';

const HOUR = 3600000;
const AT = Date.UTC(2026, 7, 20, 12);
const square = (lon) => [
  [lon, 38],
  [lon + 0.01, 38],
  [lon + 0.01, 38.01],
  [lon, 38.01],
  [lon, 38],
];
const fire = {
  id: 'a',
  name: 'a',
  containedPct: 0,
  lastGrowthTime: null,
  anchor: { lon: -120, lat: 38 },
};
const piece = (id, lon) => ({
  id,
  fireId: 'a',
  born: AT - HOUR,
  polygons: [[square(lon)]],
  outline: [square(lon)],
});

test('disable and enable stay safe after an interrupted first read', async () => {
  const renderer = createStubRenderer();
  const viewer = {};
  bindRenderer(viewer, renderer);
  let released = 0;
  const layer = createFirePerimetersLayer({
    source: {
      getSnapshot: async () => ({
        at: AT,
        fetchedAt: AT,
        stale: false,
        revision: 'r',
        note: null,
        fires: [fire],
        pieces: [piece('ok', -120), piece('ok2', -119.9)],
      }),
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    inputFor: () => ({
      onClick() {
        return () => {
          released += 1;
        };
      },
    }),
    picking: {
      clickCard: () => null,
      resolvePickId: () => null,
      isOwnedByOtherLayer: () => false,
    },
  });
  // Refuse the first set after the layer has recorded its pieces.
  const shapes = renderer.draw.shapes.bind(renderer.draw);
  let refuse = true;
  renderer.draw.shapes = (spec) => {
    if (refuse) {
      refuse = false;
      throw new Error('no set');
    }
    return shapes(spec);
  };
  layer.init(viewer);
  layer.enable(viewer);
  assert.equal(await layer.update(), false);
  assert.doesNotThrow(() => layer.disable());
  assert.equal(released, 1, 'the click subscription is released');
  assert.doesNotThrow(() => layer.enable());
  layer.destroy();
});
