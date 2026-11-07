// The CCTV meshes seam: what an engine without a backend keeps, and the
// Navara backend the Navara mode passes in.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeEngine } from '../../../globe/testing/fakeEngine.js';
import { viewshedColors } from '../../../data/cctvViewshed.js';
import { createCctvMeshes } from './meshes.js';

const shape = { halfW: 8, halfH: 4.5 };
const positions = {
  mount: { x: 6378137, y: 0, z: 0 },
  tl: { x: 6378147, y: -1, z: 1 },
  tr: { x: 6378147, y: 1, z: 1 },
  br: { x: 6378147, y: 1, z: -1 },
  bl: { x: 6378147, y: -1, z: -1 },
  capCenter: { x: 6378147, y: 0, z: 0 },
};
const identity = { x: 0, y: 0, z: 0, w: 1 };

/** A backend that records what it is asked to draw. */
function recordingBackend(calls) {
  const native = (kind, args) => {
    const object = {
      kind,
      args,
      show: false,
      destroy: () => calls.push(['destroy', kind]),
    };
    calls.push(['create', kind, object]);
    return object;
  };
  return {
    createMaterial: (image) => ({
      ...native('material', [image]),
      setImage: (image) => calls.push(['image', image]),
      dispose: () => calls.push(['dispose', 'material']),
    }),
    createPlane: (...args) => native('plane', args),
    updatePlane: (plane, ...args) => calls.push(['update', ...args]),
    createVolume: (...args) => native('volume', args),
    planeFromPick: (picked) => picked.native,
    drawnBy: (object) => object,
    destroy: () => calls.push(['destroy', 'backend']),
  };
}

test('an engine without a backend keeps the handles and draws nothing', () => {
  const engine = createFakeEngine();
  const meshes = createCctvMeshes(engine);
  const material = meshes.createMaterial(null);
  const plane = meshes.createPlane('a', material, shape, positions, identity);
  assert.equal(plane.id, 'cctv-a-plane');
  assert.equal(plane.show, false);
  plane.show = true;
  assert.equal(plane.show, true);
  assert.equal(meshes.planeFromPick({ id: plane.id }), null);
  assert.equal(meshes.drawnBy(plane), undefined);
  assert.equal(
    meshes.obstructionRay(positions.mount, positions.tl, 10, []),
    undefined,
  );
  assert.throws(
    () => meshes.createPlane('b', { image: null }, shape, positions, identity),
    /not owned/,
  );
  meshes.destroy();
  assert.equal(plane.show, false);
  assert.equal(material.disposed, true);
  assert.throws(() => meshes.createMaterial(null), /destroyed/);
});

test('the Navara backend the Navara mode passes in draws the meshes', () => {
  const engine = createFakeEngine({ kind: 'navara' });
  const navara = { view: {}, MeshDesc: class {} };
  engine.extensions = { navara };
  const calls = [];
  let given;
  const meshes = createCctvMeshes(engine, {
    navaraMeshes(target, extension) {
      given = { target, extension };
      return recordingBackend(calls);
    },
  });
  assert.equal(given.target, engine);
  assert.equal(given.extension, navara);
  const material = meshes.createMaterial('canvas');
  material.setImage('video');
  const plane = meshes.createPlane('a', material, shape, positions, identity);
  const volume = meshes.createVolume(positions, viewshedColors(4).fill);
  const created = calls.filter(([type]) => type === 'create');
  assert.deepEqual(
    created.map(([, kind]) => kind),
    ['material', 'plane', 'volume'],
  );
  assert.deepEqual(calls[1], ['image', 'video']);
  const [, , drawnPlane] = created[1];
  assert.equal(drawnPlane.args[1], material.native, 'its drawn material');
  plane.show = true;
  assert.equal(drawnPlane.show, true);
  assert.equal(meshes.planeFromPick({ native: drawnPlane }), plane);
  plane.show = false;
  assert.equal(meshes.planeFromPick({ native: drawnPlane }), null);
  meshes.updatePlane(plane, shape, positions, identity);
  assert.deepEqual(calls.at(-1), ['update', shape, positions, identity]);
  assert.equal(meshes.drawnBy(volume), created[2][2]);
  meshes.destroy();
  meshes.destroy();
  assert.deepEqual(calls.slice(-4), [
    ['destroy', 'plane'],
    ['destroy', 'volume'],
    ['dispose', 'material'],
    ['destroy', 'backend'],
  ]);
});

test('a Navara engine without the backend draws nothing', () => {
  const engine = createFakeEngine({ kind: 'navara' });
  engine.extensions = { navara: {} };
  const meshes = createCctvMeshes(engine);
  const volume = meshes.createVolume(positions, viewshedColors(4).fill);
  assert.equal(meshes.drawnBy(volume), undefined);
  meshes.destroy();
});
