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

for (const [name, make] of [['fake', () => ({ engine: createFakeEngine() })]]) {
  test(`CCTV mesh ownership, live image and geometry updates (${name})`, (t) => {
    const h = make();
    t.after(() => h.engine.destroy());
    const meshes = createCctvMeshes(h.engine);
    const material = meshes.createMaterial(null);
    const plane = meshes.createPlane('a', material, shape, positions, identity);
    const volume = meshes.createVolume(positions, viewshedColors(4).fill);
    assert.deepEqual(h.engine.meshes.list(), ['cctv-a-plane', volume.mesh.id]);
    assert.equal(plane.show, false);
    plane.show = true;
    assert.equal(
      meshes.planeFromPick({ id: plane.id, owner: plane.id }),
      plane,
    );
    plane.show = false;
    assert.equal(meshes.planeFromPick({ id: plane.id }), null);
    assert.equal(meshes.drawnBy(plane), plane.mesh);
    assert.equal(meshes.drawnBy(volume), volume.mesh);
    const image = {};
    image.width = image.height = 8;
    material.setImage(image);
    const moved = {
      ...positions,
      capCenter: { ...positions.capCenter, x: positions.capCenter.x + 3 },
    };
    meshes.updatePlane(plane, shape, moved, identity);
    const state = h.engine.fake.mesh(plane.id);
    assert.equal(state.positions[0], moved.capCenter.x - shape.halfW);
    assert.equal(state.image, image);
    assert.throws(
      () => meshes.createPlane('b', {}, shape, positions, identity),
      /not owned/,
    );
    meshes.destroy();
    meshes.destroy();
    assert.equal(plane.show, false);
    assert.equal(material.disposed, true);
    assert.deepEqual(h.engine.meshes.list(), []);
    material.setImage(null);
    assert.throws(() => meshes.createMaterial(null), /destroyed/);
  });
}
