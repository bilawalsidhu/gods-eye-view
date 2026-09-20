// src/data/meshFloorSamplerRegime.test.mjs — regime switch + sampling rationing.
//
// The map-stack listener in meshFloorSampler.js is registered at MODULE LOAD,
// so it only exists when `window` is defined before the module is first
// imported. meshFloorSampler.test.mjs loads the module browser-shaped but
// windowless (as its docblock documents), so the listener can never fire there.
// This file installs the window host FIRST, then imports the module — the same
// order the bundle gets — and pins the regime contract plus the two rationing
// edges that decide whether a probe is worth a synchronous pick render.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

const realWindow = globalThis.window;
globalThis.window = new EventTarget();
const { sampleMeshFloorCells } = await import('./meshFloorSampler.js');
const {
  cachedMeshFloor,
  meshFloorPreferred,
  setMeshFloorPreferred,
  _clearMeshFloorCellsForTest,
} = await import('./groundFloor.js');

test.after(() => {
  globalThis.window = realWindow;
  setMeshFloorPreferred(true);
});

/** A scene the sampler accepts: low camera, one visible tileset reporting
 *  tilesLoaded, and a `sampleHeight` under the test's control. */
function readyScene(sampleHeight, { tileset = undefined } = {}) {
  const loadedTileset = tileset ?? (() => {
    const ts = Object.create(Cesium.Cesium3DTileset.prototype);
    Object.defineProperty(ts, 'tilesLoaded', { value: true, configurable: true });
    Object.defineProperty(ts, 'show', { value: true, configurable: true });
    return ts;
  })();
  return {
    sampleHeight,
    camera: { positionCartographic: { height: 900 } },
    primitives: { length: 1, get: () => loadedTileset },
  };
}

function resetSampler() {
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
}

test('the map-stack change event retargets the mesh-floor preference', () => {
  assert.equal(meshFloorPreferred(), true, 'the boot default is the photoreal stack');
  window.dispatchEvent(new CustomEvent('gev:map-stack-changed', { detail: { activeId: 'bing' } }));
  assert.equal(meshFloorPreferred(), false, 'a globe stack floors on the DEM, not the mesh');
  window.dispatchEvent(new CustomEvent('gev:map-stack-changed', { detail: { activeId: 'photoreal' } }));
  assert.equal(meshFloorPreferred(), true, 'returning to photoreal re-enables mesh sampling');

  const before = meshFloorPreferred();
  window.dispatchEvent(new CustomEvent('gev:map-stack-changed'));
  assert.equal(meshFloorPreferred(), before, 'a payload-less dispatch does not flip the regime');
});

test('a scene whose primitive walk throws mid-teardown samples nothing', () => {
  resetSampler();
  let probes = 0;
  const cell = { lat: 41.2, lon: -97.4 };
  const scene = {
    sampleHeight: () => { probes += 1; return 138.0; },
    camera: { positionCartographic: { height: 900 } },
    primitives: {
      length: 1,
      get: () => { throw new Error('primitive collection torn down'); },
    },
  };
  assert.doesNotThrow(() => sampleMeshFloorCells(scene, [cell], { viewerLat: cell.lat, viewerLon: cell.lon }));
  assert.equal(probes, 0, 'a torn-down scene reports not-loaded and bails before probing');
  assert.equal(cachedMeshFloor(cell.lat, cell.lon), null, 'and nothing latches');
});

test('cells outside the viewer-proximity cap are never probed', () => {
  resetSampler();
  let probes = 0;
  const scene = readyScene(() => { probes += 1; return 138.0; });
  const here = { lat: 41.2, lon: -97.4 };
  const far = { lat: 41.6, lon: -97.4 }; // ~44 km north of the viewer subpoint

  sampleMeshFloorCells(scene, [far], { viewerLat: here.lat, viewerLon: here.lon });
  assert.equal(probes, 0, 'tiles are not streamed 44 km out: the probe would be a guaranteed miss');
  assert.equal(cachedMeshFloor(far.lat, far.lon), null, 'and the far cell does not latch');

  sampleMeshFloorCells(scene, [here], { viewerLat: here.lat, viewerLon: here.lon });
  assert.equal(probes, 1, 'the near cell is still worth its one-shot probe');

  sampleMeshFloorCells(scene, [{ lat: 41.9, lon: -97.4 }], {});
  assert.equal(probes, 2, 'with no viewer subpoint supplied there is nothing to ration against');
});
