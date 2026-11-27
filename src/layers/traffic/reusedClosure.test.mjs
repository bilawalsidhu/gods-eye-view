import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from './state.js';
import { createModel } from './model.js';
import { createFlow } from './flow.js';
import { surfaceViewer } from '../../testSupport/fakeSceneSurface.mjs';
import '../../render/cesium/camera.js';

function harness() {
  const scene = { globe: { show: true, tilesLoaded: true, getHeight: () => 10 } };
  const state = createState({ services: {} });
  Object.assign(state, {
    _enabled: true,
    _liveMode: true,
    _loadGeneration: 1,
    _roadSource: 'OpenStreetMap',
    _viewer: surfaceViewer(scene),
    _activeFetchAbort: new AbortController(),
  });
  const parts = {
    rendering: {
      visibleRoadsForAltitude: (roads) => roads,
      renderRoadsForAltitude() {},
      removeHeatLines() {},
      rebuildHeatLines() {},
    },
  };
  const ctx = {
    state,
    services: {
      credits: { registerDynamicCredit() {} },
      ground: { cachedGroundFloor: () => 10, meshFloorPreferred: () => false },
      render: { holdContinuousRender() {}, releaseContinuousRender() {} },
    },
    parts,
    source: {},
  };
  parts.model = createModel(ctx);
  parts.model.recolorDotsInPlace = () => {};
  const flow = createFlow(ctx);
  return { state, model: parts.model, flow };
}

const records = () => [
  { type: 'primary', oneway: 1, coordinates: [[-73.984, 40.754], [-73.982, 40.755]] },
  { type: 'primary', oneway: 1, coordinates: [[-73.986, 40.756], [-73.984, 40.757]] },
];

test('a closure matched on a streamed tile does not drop the road from the snapshot that ends the pass', async () => {
  const h = harness();
  const data = { roads: records() };
  const parsedBySource = new WeakMap();
  const preview = h.model.parseRoads(data, null, parsedBySource);
  // What the preview paint's flow match (applyFlowToRoads) writes on an admitted road.
  preview[1].flow = { level: 0, closure: true };
  const final = h.model.parseRoads({ roads: data.roads, replace: true }, null, parsedBySource);
  const paint = h.flow.applyFlowThenRender(final, {}, 1, 250, 'Loaded full');
  await new Promise((resolve) => setTimeout(resolve, 50));
  // applyFlowToRoads(admitted) records the admitted set synchronously.
  const admitted = h.state._flowRoads || [];
  h.state._loadGeneration++;
  await paint.catch(() => {});
  assert.equal(admitted.length, 2, 'both roads reach flow matching and the render, as with a fresh parse');
  assert.ok(admitted.includes(final[1]), 'the road closed on the preview is matched again in the final paint');
});
