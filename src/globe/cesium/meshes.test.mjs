import test from 'node:test';
import assert from 'node:assert/strict';
import { createCesiumMoversEngine } from '../../testSupport/cesiumMoversEngine.mjs';

const triangles = {
  id: 'mesh',
  positions: [6378137, 0, 0, 6378137, 20, 0, 6378137, 0, 20],
  indices: [0, 1, 2],
};

test('Cesium meshes draw indexed triangles and restyle without rebuilding', (t) => {
  const h = createCesiumMoversEngine();
  t.after(() => h.engine.destroy());
  const mesh = h.engine.meshes.createMesh({ ...triangles, pickId: 'feature' });
  const first = h.primitive(mesh.id);
  assert.deepEqual(
    [...first.geometryInstances.geometry.attributes.position.values],
    triangles.positions,
  );
  assert.equal(
    first.geometryInstances.geometry.attributes.normal.values.length,
    9,
  );
  assert.equal(first.allowPicking, true);
  assert.equal(first.asynchronous, false);
  assert.equal(first.appearance.renderState.cull.enabled, false);
  assert.equal(first.appearance.renderState.depthMask, false);
  mesh.update({ color: [1, 0, 0, 0.2], show: false });
  assert.equal(h.primitive(mesh.id), first);
  assert.equal(first.appearance.material.uniforms.color.alpha, 0.2);
  assert.equal(first.show, false);
  mesh.update({ depthTest: 'always', show: true, pickId: 'replacement' });
  const second = h.primitive(mesh.id);
  assert.notEqual(second, first);
  assert.equal(first.isDestroyed(), true);
  assert.equal(second.appearance.renderState.depthTest.enabled, false);
  h.viewer.scene.pick = () => ({ primitive: second, id: 'replacement' });
  assert.equal(h.engine.picker.pick({ x: 1, y: 1 }).id, 'replacement');
  assert.equal(h.engine.picker.pick({ x: 1, y: 1 }).owner, mesh.id);
  mesh.destroy();
  mesh.destroy();
  assert.equal(second.isDestroyed(), true);
  assert.equal(h.primitive(mesh.id), undefined);
});

test('Cesium mesh image refresh invalidates a reused canvas and releases frame listeners', (t) => {
  let requests = 0;
  const h = createCesiumMoversEngine({
    engineOptions: { requestRender: () => requests++ },
  });
  t.after(() => h.engine.destroy());
  const frame = h.viewer.scene.postRender;
  const before = frame.numberOfListeners;
  const canvas = new HTMLCanvasElement();
  canvas.width = canvas.height = 8;
  const mesh = h.engine.meshes.createMesh({
    ...triangles,
    uv: [0, 0, 1, 0, 0, 1],
    image: canvas,
  });
  const material = h.primitive(mesh.id).appearance.material;
  material._texturePaths.image = canvas;
  mesh.update({ image: canvas });
  assert.equal(material._texturePaths.image, undefined);
  assert.equal(material.uniforms.image, canvas);
  assert.equal(frame.numberOfListeners, before + 1);
  h.primitive(mesh.id)._ready = true;
  material._textures.image = { destroy() {} };
  material._texturePaths.image = canvas;
  material._loadedImages.push({ id: 'image', image: canvas });
  const pending = requests;
  h.frame();
  assert.ok(requests > pending, 'a queued upload requests another frame');
  material._loadedImages.length = 0;
  const uploaded = requests;
  h.frame();
  assert.equal(requests, uploaded, 'an uploaded still image can stop drawing');
  mesh.destroy();
  assert.equal(frame.numberOfListeners, before);
  assert.equal(material.isDestroyed(), true);
});

test('ray obstruction hides excluded mesh and line handles and restores them on a failed query', (t) => {
  const h = createCesiumMoversEngine();
  t.after(() => h.engine.destroy());
  const mesh = h.engine.meshes.createMesh(triangles);
  const primitive = h.primitive(mesh.id);
  const line = h.engine.lines.createLine({
    id: 'line',
    pickId: 'line',
    widthPx: 2,
    color: [1, 1, 1, 1],
  });
  line.setPositions([
    { x: 6378137, y: 0, z: 0 },
    { x: 6378137, y: 20, z: 0 },
  ]);
  const root = [...Array(h.viewer.scene.primitives.length)].map((_, i) =>
    h.viewer.scene.primitives.get(i),
  );
  const slot = root
    .flatMap((r) => [...Array(r.length)].map((_, i) => r.get(i)))
    .find((p) => p.get?.(0)?.gevLine === 'line');
  h.viewer.scene.pickFromRay = () => {
    assert.equal(primitive.show, false);
    assert.equal(slot.show, false);
    throw new Error('ray failed');
  };
  assert.throws(
    () =>
      h.engine.surface.raycast({
        origin: { x: 6378137, y: 0, z: 0 },
        direction: { x: 1, y: 0, z: 0 },
        far: 100,
        exclude: [mesh, line],
      }),
    /ray failed/,
  );
  assert.equal(primitive.show, true);
  assert.equal(slot.show, true);
});
