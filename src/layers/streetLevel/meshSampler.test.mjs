import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { MESH_CELL_DEG, createMeshSampler } from './meshSampler.js';

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const RAD = Math.PI / 180;

/** A scene whose mesh is 100 m everywhere except where `holes` say. */
function fakeViewer({ holes = () => false } = {}) {
  const tileset = Object.create(Cesium.Cesium3DTileset.prototype);
  const overlay = { name: 'lines' };
  const probes = [];
  const scene = {
    sampleHeightSupported: true,
    primitives: {
      length: 2,
      get: (i) => [tileset, overlay][i],
    },
    sampleHeight(carto, exclude) {
      const lon = carto.longitude / RAD;
      const lat = carto.latitude / RAD;
      probes.push({ lon, lat, exclude });
      return holes(lon, lat) ? undefined : 100;
    },
  };
  return {
    probes,
    overlay,
    viewer: {
      scene,
      camera: {
        positionCartographic: { longitude: 10 * RAD, latitude: 50 * RAD },
      },
    },
  };
}

test('cells are probed once, nearest first, with overlays excluded', async () => {
  const { viewer, probes, overlay } = fakeViewer();
  const sampler = createMeshSampler({ getViewer: () => viewer });
  sampler.setEnabled(true);
  const heard = [];
  sampler.onSampled((batch) => heard.push(batch.length));
  sampler.request([
    [10.004, 50],
    [10.001, 50],
    [10.00101, 50.00001], // same ~11 m cell as the previous point
  ]);
  await settle(1000);
  assert.equal(probes.length, 2);
  assert.ok(probes[0].lon < probes[1].lon, 'nearest the camera first');
  assert.deepEqual(probes[0].exclude, [overlay], 'only tilesets are hit');
  assert.equal(sampler.meshAt(10.001, 50), 100);
  assert.equal(sampler.meshAt(10.00101, 50.00001), 100);
  assert.deepEqual(heard, [2]);
  sampler.request([[10.001, 50]]);
  await settle();
  assert.equal(probes.length, 2, 'a sampled cell is not probed again');
  sampler.destroy();
});

test('far cells are skipped, misses are not latched, and nothing runs while disabled', async () => {
  const { viewer, probes } = fakeViewer({ holes: (lon) => lon > 10.0049 });
  const sampler = createMeshSampler({ getViewer: () => viewer });
  sampler.request([[10.001, 50]]);
  await settle();
  assert.equal(probes.length, 0, 'disabled: nothing queued');
  sampler.setEnabled(true);
  sampler.request([
    [10.05, 50], // ~3.6 km away
    [10.005, 50], // a hole: tiles not streamed
  ]);
  await settle();
  assert.equal(probes.length, 1);
  assert.equal(sampler.meshAt(10.05, 50), undefined);
  assert.equal(sampler.meshAt(10.005, 50), undefined);
  assert.ok(Math.abs(probes[0].lon - 10.005) < MESH_CELL_DEG);
  sampler.destroy();
});
