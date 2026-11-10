// The CCTV layer's draw sets: lines written only as they change, dashed for
// an estimated bearing, the depth-fail colour passed as it is; the sets made
// again on another viewer and let go on dispose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDrawSets } from './drawSets.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';

const line = (id, fields = {}) => ({
  id,
  cameraId: 'cam',
  role: 'edge',
  positions: [
    { x: 1, y: 2, z: 3 },
    { x: 4, y: 5, z: 6 },
  ],
  widthPx: 1.2,
  color: [0.1, 0.2, 0.3, 0.4],
  dashed: false,
  depthFailColor: null,
  show: true,
  ...fields,
});

test('lines are written as they change, and drawn as their handles say', () => {
  const viewer = {};
  const { draw, unbind } = bindFakeDraw(viewer);
  const drawSets = createDrawSets({ state: { _viewer: viewer } });
  try {
    const a = line('cctv-cam-ray-tl');
    const b = line('cctv-cam-cap', { role: 'cap' });
    drawSets.writeLines([a, b]);
    const coverage = draw.find('cctv:');
    assert.equal(coverage.kind, 'lines');
    assert.equal(coverage.writes, 1);
    assert.deepEqual(coverage.items.get(a.id), {
      id: a.id,
      positions: a.positions,
      widthPx: 1.2,
      mode: 'geodesic',
      style: { kind: 'solid', color: a.color },
      depthFail: null,
      meta: { cameraId: 'cam' },
      show: true,
    });

    drawSets.writeLines([a, b]);
    assert.equal(coverage.writes, 1, 'unchanged handles write nothing');

    b.dashed = true;
    b.depthFailColor = [1, 1, 1, 0.2];
    drawSets.writeLines([a, b]);
    assert.equal(coverage.writes, 2);
    const cap = coverage.items.get(b.id);
    assert.deepEqual(cap.style, {
      kind: 'dash',
      color: b.color,
      length: 16,
      pattern16: 255,
    });
    assert.deepEqual(cap.depthFail, { kind: 'solid', color: [1, 1, 1, 0.2] });

    assert.equal(drawSets.roleOfSet(coverage.spec.id), 'coverage');
    assert.equal(drawSets.roleOfSet('other:1:lines'), null);

    drawSets.clearLines();
    assert.equal(coverage.items.size, 0);
    drawSets.writeLines([a]);
    assert.ok(coverage.items.has(a.id), 'a cleared line is written again');
  } finally {
    unbind();
  }
});

test('another viewer gets sets of its own; dispose lets them go', () => {
  const first = {};
  const second = {};
  const one = bindFakeDraw(first);
  const two = bindFakeDraw(second);
  const state = { _viewer: first };
  const drawSets = createDrawSets({ state });
  try {
    const a = line('cctv-cam-ray-tl');
    drawSets.writeLines([a]);
    drawSets.writeVolume({ id: 'cctv-cam-viewshed' });
    const old = one.draw.find('cctv:');
    assert.equal(drawSets.volumeWritesForTest(), 1);

    state._viewer = second;
    assert.deepEqual(drawSets.pickableSetIds(), [], 'none made yet');
    drawSets.writeLines([a]);
    assert.ok(old.disposed, 'the old viewer’s sets are let go');
    const now = two.draw.find('cctv:');
    assert.ok(now.items.has(a.id), 'the line is written anew');
    const [coverage, plane] = drawSets.pickableSetIds();
    assert.equal(two.draw.set(coverage).kind, 'lines');
    assert.equal(two.draw.set(plane).kind, 'quads');
    assert.equal(drawSets.roleOfSet(plane), 'plane');

    drawSets.dispose();
    assert.ok(
      [...two.draw.sets.values()].every((set) => set.disposed),
      'every set is let go',
    );
    assert.equal(drawSets.roleOfSet(coverage), null);
  } finally {
    one.unbind();
    two.unbind();
  }
});

test('a renderer without meshes or quads still draws the lines', () => {
  const viewer = {};
  const { draw, unbind } = bindFakeDraw(viewer);
  delete draw.meshes;
  delete draw.quads;
  const drawSets = createDrawSets({ state: { _viewer: viewer } });
  try {
    drawSets.writeLines([line('cctv-cam-ray-tl')]);
    const coverage = draw.find('cctv:');
    assert.equal(coverage.items.size, 1);
    // No viewshed volumes and no monitor plane: their writes do nothing.
    drawSets.writeVolume({ id: 'cctv-cam-viewshed' });
    drawSets.removeVolume('cctv-cam-viewshed');
    const plane = { id: 'cctv-cam-plane', cameraId: 'cam', show: true };
    drawSets.writePlane(plane);
    drawSets.removePlane(plane);
    assert.equal(drawSets.volumeWritesForTest(), 0);
    assert.deepEqual(drawSets.pickableSetIds(), [coverage.spec.id]);
    assert.equal(drawSets.roleOfSet(coverage.spec.id), 'coverage');
    drawSets.dispose();
  } finally {
    unbind();
  }
});
