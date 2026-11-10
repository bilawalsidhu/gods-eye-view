import { createFakeEngine } from '../testing/fakeEngine.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Color,
  Group,
  RGBADepthPacking,
  ShaderLib,
  SRGBColorSpace,
  Vector3,
} from 'three';
import * as Cesium from 'cesium';
import { createNavaraMeshes } from './meshes.js';
import { createCctvMeshes } from '../../layers/cctv/render/meshes.js';
import { viewshedColors } from '../../data/cctvViewshed.js';

function harness() {
  const scene = new Group();
  const handles = new Set();
  let requests = 0;
  let fail = false;
  let failedGeometryDisposals = 0;
  const view = {
    forceUpdate: () => requests++,
    toneMappingExposure: 1,
  };
  const overlay = {
    ctx: null,
    add(object) {
      if (fail) {
        object.children[0].geometry.addEventListener(
          'dispose',
          () => failedGeometryDisposals++,
        );
        throw new Error('overlay failed');
      }
      scene.add(object);
      handles.add(object);
    },
    remove(object) {
      scene.remove(object);
      handles.delete(object);
    },
  };
  const pickers = new Set();
  const engine = createFakeEngine({ kind: 'navara' });
  engine.render.request = () => requests++;
  engine.camera.pickRay = () => null;
  engine.fake.script('pickPosition', undefined);
  engine.picker.registerMeshPicker = (pick) => {
    pickers.add(pick);
    return () => pickers.delete(pick);
  };
  const port = createNavaraMeshes(view, {
    overlay,
    camera: engine.camera,
    picker: engine.picker,
  });
  engine.meshes = port.meshes;
  const owner = createCctvMeshes(engine);
  return {
    owner,
    port,
    view,
    overlay,
    drawn: () => scene.children.at(-1)?.children[0],
    engine,
    scene,
    handles,
    pickers,
    requests: () => requests,
    failedGeometryDisposals: () => failedGeometryDisposals,
    fail: () => (fail = true),
  };
}

const shape = { halfW: 80, halfH: 45 };
const positions = { capCenter: { x: 6378137, y: 1234, z: 5678 } };
const identity = { x: 0, y: 0, z: 0, w: 1 };
const canvas = () => ({ width: 8, height: 8, tagName: 'CANVAS' });

test('solid and textured overlay meshes keep authored colours through landscape exposure changes', () => {
  const h = harness();
  for (const image of [null, canvas()]) {
    const handle = h.engine.meshes.createMesh({
      id: image ? 'textured' : 'solid',
      positions: [6378137, 0, 0, 6378137, 10, 0, 6378137, 0, 10],
      indices: [0, 1, 2],
      uv: [0, 0, 1, 0, 0, 1],
      image,
    });
    const mesh = h.drawn();
    assert.equal(mesh.parent.parent, h.scene);
    assert.equal(mesh.material.toneMapped, false);
    assert.equal(mesh.material.transparent, true);
    assert.equal(mesh.material.depthWrite, false);
    if (image) assert.equal(mesh.material.map.colorSpace, SRGBColorSpace);
    for (const color of [
      [0, 1, 0, 1],
      [0.25, 0.5, 0.75, 0.4],
    ]) {
      handle.update({ color });
      const expected = new Color().setRGB(...color.slice(0, 3), SRGBColorSpace);
      for (const exposure of [1, 10, 1]) {
        h.view.toneMappingExposure = exposure;
        mesh.onBeforeRender({});
        assert.deepEqual(mesh.material.color, expected);
        assert.equal(mesh.material.opacity, color[3]);
      }
    }
    handle.destroy();
    assert.equal(h.scene.children.length, 0);
  }
  h.port.destroy();
});

test('overlay meshes bind late and replaced scene depth and honour depth-test updates', () => {
  const h = harness();
  const plane = h.owner.createPlane(
    'depth',
    h.owner.createMaterial(canvas()),
    shape,
    positions,
    identity,
  );
  const mesh = h.drawn();
  const shader = {
    uniforms: {},
    fragmentShader: ShaderLib.basic.fragmentShader,
  };
  mesh.material.onBeforeCompile(shader, null);
  assert.match(shader.fragmentShader, /packedDepthOccluded/);
  const renderer = { getRenderTarget: () => ({ width: 640, height: 360 }) };
  const { tGevSceneDepth, uGevSceneDepthOn, uGevTargetSize } = shader.uniforms;
  mesh.onBeforeRender(renderer);
  assert.equal(uGevSceneDepthOn.value, 0);
  const mrt = { depthBuffer: {}, depthBufferPacking: RGBADepthPacking };
  h.overlay.ctx = { findEffect: (key) => (key === 'mrt' ? mrt : null) };
  mesh.onBeforeRender(renderer);
  assert.equal(tGevSceneDepth.value, mrt.depthBuffer);
  assert.equal(uGevSceneDepthOn.value, 1);
  assert.deepEqual(uGevTargetSize.value.toArray(), [640, 360]);
  plane.mesh.update({ depthTest: 'always' });
  mesh.onBeforeRender(renderer);
  assert.equal(uGevSceneDepthOn.value, 0);
  assert.equal(mesh.material.depthTest, false);
  plane.mesh.update({ depthTest: 'normal' });
  mrt.depthBuffer = {};
  mesh.onBeforeRender({ getDrawingBufferSize: (size) => size.set(1280, 720) });
  assert.equal(tGevSceneDepth.value, mrt.depthBuffer);
  assert.equal(uGevSceneDepthOn.value, 1);
  assert.equal(mesh.material.depthTest, true);
  assert.deepEqual(uGevTargetSize.value.toArray(), [1280, 720]);
  h.owner.destroy();
  h.port.destroy();
  assert.equal(h.scene.children.length, 0);
});

test('Navara CCTV plane preserves native rotated geometry, UVs and metre precision', (t) => {
  const h = harness();
  t.after(() => {
    h.owner.destroy();
    h.port.destroy();
  });
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
  const drawn = h.drawn();
  drawn.updateWorldMatrix(true, true);
  const attribute = drawn.geometry.getAttribute('position');
  const uv = drawn.geometry.getAttribute('uv');
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
      .applyMatrix4(drawn.matrixWorld);
    assert.ok(Cesium.Cartesian3.distance(native, actual) < 0.00001);
    assert.equal(uv.getX(i), (x + 1) / 2);
    assert.equal(uv.getY(i), (y + 1) / 2);
  }
  assert.equal(plane.show, false);
  assert.equal(plane.id, 'cctv-a-plane');
  plane.show = true;
  assert.equal(drawn.parent.visible, true);
  assert.equal(drawn.material.opacity, 0.95);
  assert.equal(drawn.material.depthWrite, false);
});

test('world mesh picks test both faces, visibility, depth and retirement', () => {
  const h = harness();
  const plane = h.owner.createPlane(
    'a',
    h.owner.createMaterial(canvas()),
    shape,
    positions,
    identity,
  );
  plane.show = true;
  const [pick] = h.pickers;
  let ray = {
    origin: { ...positions.capCenter, z: 5800 },
    direction: { x: 0, y: 0, z: -1 },
  };
  h.engine.camera.pickRay = () => ray;
  assert.equal(pick({})[0].depth, 122);
  assert.deepEqual(pick({})[0].result, { id: plane.id, owner: plane.id });
  ray = {
    origin: { ...positions.capCenter, z: 5500 },
    direction: { x: 0, y: 0, z: 1 },
  };
  assert.equal(pick({})[0].depth, 178);
  ray.origin.x += 81;
  assert.deepEqual(pick({}), []);
  ray.origin.x -= 81;
  // A depth read that answers with the camera itself hides nothing; the
  // globe stands in for the surface.
  h.engine.picker.pickPosition = () => ({ ...ray.origin });
  h.engine.picker.pickGlobe = () => ({ ...positions.capCenter, z: 6000 });
  assert.equal(pick({})[0].depth, 178);
  h.engine.picker.pickGlobe = () => ({ ...positions.capCenter, z: 5550 });
  assert.deepEqual(pick({}), [], 'a nearer globe still hides it');
  h.engine.picker.pickPosition = () => ({ ...positions.capCenter, z: 5550 });
  assert.deepEqual(pick({}), [], 'a nearer wall hides the mesh');
  plane.mesh.update({ depthTest: 'always' });
  assert.equal(pick({}).length, 1);
  plane.show = false;
  assert.deepEqual(pick({}), []);
  h.owner.destroy();
  h.port.destroy();
  assert.equal(h.pickers.size, 0);
  assert.equal(h.handles.size, 0);
});

test('world meshes release replaced images and video callbacks exactly once', () => {
  const h = harness();
  const first = canvas();
  const material = h.owner.createMaterial(first);
  const plane = h.owner.createPlane('a', material, shape, positions, identity);
  const drawn = h.drawn();
  let disposed = 0;
  drawn.material.map.addEventListener('dispose', () => disposed++);
  const version = drawn.material.map.version;
  material.setImage(first);
  assert.ok(drawn.material.map.version > version);
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
  assert.equal(disposed, 1);
  assert.equal(drawn.material.map.isVideoTexture, true);
  material.setImage(canvas());
  assert.equal(cancelled, 1);
  let finalDisposed = 0;
  drawn.material.map.addEventListener('dispose', () => finalDisposed++);
  plane.destroy();
  plane.destroy();
  assert.equal(finalDisposed, 1, 'the mesh owns its texture');
  material.dispose();
  const requests = h.requests();
  material.setImage(video);
  assert.equal(h.requests(), requests);
  h.owner.destroy();
  h.port.destroy();
  assert.equal(finalDisposed, 1);
});

test('world mesh overlay failure releases geometry and rejects later creates after teardown', () => {
  const h = harness();
  h.fail();
  assert.throws(
    () =>
      h.owner.createPlane(
        'a',
        h.owner.createMaterial(canvas()),
        shape,
        positions,
        identity,
      ),
    /overlay failed/,
  );
  assert.equal(h.failedGeometryDisposals(), 1);
  assert.equal(h.handles.size, 0);
  assert.deepEqual(h.port.meshes.list(), []);
  h.owner.destroy();
  h.port.destroy();
  assert.throws(() => h.owner.createMaterial(null), /destroyed/);
});

test('world volume preserves world vertices and releases geometry and material', () => {
  const h = harness();
  const mount = positions.capCenter;
  const p = (x, y, z) => ({ x: mount.x + x, y: mount.y + y, z: mount.z + z });
  h.owner.createVolume(
    {
      mount,
      tl: p(-5, 5, 100),
      tr: p(5, 5, 100),
      br: p(5, -5, 100),
      bl: p(-5, -5, 100),
    },
    viewshedColors(30).fill,
  );
  const mesh = h.drawn();
  mesh.updateWorldMatrix(true, true);
  assert.equal(mesh.geometry.index.count, 18);
  assert.equal(mesh.geometry.getAttribute('position').count, 5);
  const first = new Vector3()
    .fromBufferAttribute(mesh.geometry.getAttribute('position'), 0)
    .applyMatrix4(mesh.matrixWorld);
  assert.equal(first.x, mount.x);
  let geometryReleases = 0,
    materialReleases = 0;
  mesh.geometry.addEventListener('dispose', () => geometryReleases++);
  mesh.material.addEventListener('dispose', () => materialReleases++);
  h.owner.destroy();
  h.port.destroy();
  h.port.destroy();
  assert.equal(geometryReleases, 1);
  assert.equal(materialReleases, 1);
  assert.equal(h.handles.size, 0);
});

test('world mesh picks retain the nearest shown triangle among several meshes', () => {
  const h = harness();
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
  h.engine.camera.pickRay = () => ({
    origin: { ...positions.capCenter, z: 5800 },
    direction: { x: 0, y: 0, z: -1 },
  });
  const nearest = () =>
    [...h.pickers]
      .flatMap((pick) => pick({}))
      .sort((a, b) => a.depth - b.depth)[0];
  assert.equal(nearest().result.id, near.id);
  assert.equal(nearest().depth, 100);
  assert.equal(h.owner.planeFromPick({ id: near.id, owner: 'sibling' }), null);
  near.show = false;
  assert.equal(nearest().result.id, far.id);
  far.destroy();
  assert.equal(nearest(), undefined);
  h.owner.destroy();
  h.port.destroy();
});
