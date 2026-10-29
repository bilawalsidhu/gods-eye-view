import assert from 'node:assert/strict';
import test from 'node:test';
import { Group, Vector3 } from 'three';
import * as Cesium from 'cesium';
import { createCctvNavaraMeshes } from './navaraMeshes.js';
import { viewshedColors } from '../../../data/cctvViewshed.js';

function harness() {
  const scene = new Group();
  const kinds = new Map();
  const handles = new Set();
  const lines = new Set();
  let requests = 0;
  let fail = false;
  let failedGeometryDisposals = 0;
  class MeshDesc {
    onDestroy() {}
  }
  const view = {
    registerMesh: (kind, desc) => kinds.set(kind, desc),
    addMesh(config) {
      if (fail) {
        config.gevCctvMesh.group.children[0].geometry.addEventListener(
          'dispose',
          () => failedGeometryDisposals++,
        );
        throw new Error('descriptor failed');
      }
      const kind = Object.keys(config)[0];
      const desc = new (kinds.get(kind))(view, {}, config);
      assert.equal(desc.getPassKey(), 'transparent');
      const object = desc.createMesh();
      scene.add(object);
      const handle = {
        delete() {
          handles.delete(handle);
          scene.remove(object);
          desc.onDestroy();
        },
      };
      handles.add(handle);
      return handle;
    },
  };
  const engine = {
    render: { request: () => requests++ },
    lines: {
      createLine(options) {
        const line = {
          options,
          setPositions: (value) => (line.positions = value),
          show: (value) => (line.visible = value),
          destroy: () => lines.delete(line),
        };
        lines.add(line);
        return line;
      },
    },
  };
  const owner = createCctvNavaraMeshes(engine, { view, MeshDesc });
  return {
    owner,
    scene,
    handles,
    lines,
    requests: () => requests,
    failedGeometryDisposals: () => failedGeometryDisposals,
    fail: () => (fail = true),
  };
}

const shape = { halfW: 80, halfH: 45 };
const positions = { capCenter: { x: 6378137, y: 1234, z: 5678 } };
const identity = { x: 0, y: 0, z: 0, w: 1 };
const canvas = () => ({ width: 8, height: 8, tagName: 'CANVAS' });

test('Navara CCTV plane preserves native rotated geometry, UVs and metre precision', (t) => {
  const h = harness();
  t.after(() => h.owner.destroy());
  const q = Cesium.Quaternion.fromAxisAngle(
    Cesium.Cartesian3.normalize(
      new Cesium.Cartesian3(1, 2, 3),
      new Cesium.Cartesian3(),
    ),
    0.75,
  );
  const material = h.owner.createMaterial(canvas());
  const plane = h.owner.createPlane('a', material, shape, positions, q);
  const matrix = Cesium.Matrix3.fromQuaternion(q);
  plane.group.updateWorldMatrix(true, true);
  const attribute = plane.mesh.geometry.getAttribute('position');
  const uv = plane.mesh.geometry.getAttribute('uv');
  for (const [i, [x, y]] of [
    [-1, 1],
    [1, 1],
    [-1, -1],
    [1, -1],
  ].entries()) {
    const native = Cesium.Matrix3.multiplyByVector(
      matrix,
      new Cesium.Cartesian3(x * shape.halfW, y * shape.halfH, 0),
      new Cesium.Cartesian3(),
    );
    Cesium.Cartesian3.add(native, positions.capCenter, native);
    const actual = new Vector3()
      .fromBufferAttribute(attribute, i)
      .applyMatrix4(plane.mesh.matrixWorld);
    assert.ok(Cesium.Cartesian3.distance(native, actual) < 0.00001);
    assert.equal(uv.getX(i), (x + 1) / 2);
    assert.equal(uv.getY(i), (y + 1) / 2);
  }
  assert.equal(plane.show, false);
  assert.equal(plane.outline.visible, false);
  plane.show = true;
  assert.equal(plane.outline.visible, true);
  assert.equal(material.material.opacity, 0.95);
  assert.equal(material.material.depthWrite, false);
});

test('Navara CCTV picks actual visible plane triangles from either side, nearest first', (t) => {
  const h = harness();
  t.after(() => h.owner.destroy());
  const make = (id, z) => {
    const plane = h.owner.createPlane(
      id,
      h.owner.createMaterial(canvas()),
      shape,
      { capCenter: { ...positions.capCenter, z } },
      identity,
    );
    plane.show = true;
    return plane;
  };
  const far = make('far', 5600);
  const near = make('near', 5700);
  const ray = {
    origin: { ...positions.capCenter, z: 5800 },
    direction: { x: 0, y: 0, z: -1 },
  };
  assert.equal(h.owner.pickPlane(ray).plane, near);
  assert.equal(h.owner.pickPlane(ray).distance, 100);
  near.show = false;
  assert.equal(h.owner.pickPlane(ray).plane, far);
  assert.equal(
    h.owner.pickPlane({
      ...ray,
      origin: { ...ray.origin, x: ray.origin.x + 81 },
    }),
    undefined,
  );
  assert.equal(
    h.owner.pickPlane({
      origin: { ...ray.origin, z: 5500 },
      direction: { x: 0, y: 0, z: 1 },
    }).plane,
    far,
  );
  far.destroy();
  assert.equal(h.owner.pickPlane(ray), undefined);
});

test('Navara CCTV releases replaced video textures and ignores retired image updates', () => {
  const h = harness();
  const first = canvas();
  const material = h.owner.createMaterial(first);
  let firstDisposed = 0;
  material.texture.addEventListener('dispose', () => firstDisposed++);
  const version = material.texture.version;
  material.setImage(first);
  assert.ok(material.texture.version > version);
  let cancelled = 0;
  const video = {
    tagName: 'VIDEO',
    requestVideoFrameCallback: () => 17,
    cancelVideoFrameCallback: (id) => {
      assert.equal(id, 17);
      cancelled++;
    },
  };
  material.setImage(video);
  assert.equal(firstDisposed, 1);
  assert.equal(material.texture.isVideoTexture, true);
  material.setImage(canvas());
  assert.equal(cancelled, 1);
  let finalDisposed = 0;
  material.texture.addEventListener('dispose', () => finalDisposed++);
  const plane = h.owner.createPlane('a', material, shape, positions, identity);
  plane.destroy();
  plane.destroy();
  const requests = h.requests();
  material.setImage(video);
  assert.equal(h.requests(), requests);
  assert.equal(finalDisposed, 1);
  assert.equal(h.handles.size, 0);
  assert.equal(h.lines.size, 0);
  h.owner.destroy();
  h.owner.destroy();
  assert.equal(finalDisposed, 1);
});

test('Navara CCTV rolls back a failed descriptor and rejects new resources after destroy', () => {
  const h = harness();
  const material = h.owner.createMaterial(canvas());
  let releases = 0;
  material.material.addEventListener('dispose', () => releases++);
  h.fail();
  assert.throws(
    () => h.owner.createPlane('a', material, shape, positions, identity),
    /descriptor failed/,
  );
  assert.equal(releases, 1);
  assert.equal(h.failedGeometryDisposals(), 1);
  assert.equal(h.handles.size, 0);
  assert.equal(h.lines.size, 0);
  h.owner.destroy();
  assert.throws(() => h.owner.createMaterial(canvas()), /destroyed/);
});

test('Navara CCTV volume preserves native world vertices and releases geometry/material', () => {
  const h = harness();
  const mount = positions.capCenter;
  const p = (x, y, z) => ({ x: mount.x + x, y: mount.y + y, z: mount.z + z });
  const volume = h.owner.createVolume(
    {
      mount,
      tl: p(-5, 5, 100),
      tr: p(5, 5, 100),
      br: p(5, -5, 100),
      bl: p(-5, -5, 100),
    },
    viewshedColors(30).fill,
  );
  assert.equal(volume.mesh.geometry.index.count, 18);
  assert.equal(volume.mesh.geometry.getAttribute('position').count, 5);
  assert.equal(volume.mesh.matrix.elements[12], mount.x);
  let geometryReleases = 0,
    materialReleases = 0;
  volume.mesh.geometry.addEventListener('dispose', () => geometryReleases++);
  volume.mesh.material.addEventListener('dispose', () => materialReleases++);
  h.owner.destroy();
  h.owner.destroy();
  assert.equal(geometryReleases, 1);
  assert.equal(materialReleases, 1);
  assert.equal(h.handles.size, 0);
});
