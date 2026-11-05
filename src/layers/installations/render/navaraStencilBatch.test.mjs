import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AlwaysStencilFunc,
  BackSide,
  FrontSide,
  KeepStencilOp,
  IncrementWrapStencilOp,
  DecrementWrapStencilOp,
  NotEqualStencilFunc,
  ZeroStencilOp,
  BufferGeometry,
  Mesh,
  MeshLambertMaterial,
  Group,
} from 'three';
import { batchStencilDraws } from './navaraStencilBatch.js';

const keys = [
  'side',
  'colorWrite',
  'depthWrite',
  'depthTest',
  'stencilWrite',
  'stencilFunc',
  'stencilRef',
  'stencilFuncMask',
  'stencilWriteMask',
  'stencilFail',
  'stencilZFail',
  'stencilZPass',
];
const snapshot = (m) => Object.fromEntries(keys.map((k) => [k, m[k]]));
class Drape extends Mesh {
  enabled() {
    return this.visible;
  }
  process(render) {
    if (!this.enabled()) return;
    const m = this.material,
      saved = snapshot(m);
    try {
      Object.assign(m, {
        side: BackSide,
        colorWrite: false,
        depthWrite: false,
        depthTest: true,
        stencilWrite: true,
        stencilFunc: AlwaysStencilFunc,
        stencilFail: KeepStencilOp,
        stencilZFail: IncrementWrapStencilOp,
        stencilZPass: KeepStencilOp,
      });
      render();
      m.side = FrontSide;
      m.stencilZFail = DecrementWrapStencilOp;
      render();
      Object.assign(m, {
        side: BackSide,
        colorWrite: true,
        depthTest: false,
        stencilFunc: NotEqualStencilFunc,
        stencilFail: ZeroStencilOp,
        stencilZFail: ZeroStencilOp,
        stencilZPass: ZeroStencilOp,
      });
      render();
    } finally {
      Object.assign(m, saved);
    }
  }
}
function fixture() {
  const material = new MeshLambertMaterial({
    color: 0x74aaff,
    opacity: 0.85,
    transparent: true,
  });
  material.defines = { NVR_TEST: 1 };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.shared = { value: 123 };
  };
  material.customProgramCacheKey = () => 'native-drape';
  return new Drape(new BufferGeometry(), material);
}

test('three native stencil states render in one submission with the same geometry, transforms and shader hooks', () => {
  const mesh = fixture(),
    material = mesh.material,
    expected = [];
  mesh.process(() => expected.push(snapshot(material)));
  mesh.position.set(100, 200, 300);
  mesh.layers.set(2);
  batchStencilDraws(mesh);
  let calls = 0;
  mesh.process(() => {
    calls++;
    assert.equal(mesh.material.visible, false);
    mesh.updateMatrixWorld(true);
    assert.deepEqual(
      mesh.children.map((m) => snapshot(m.material)),
      expected,
    );
    for (const [i, stage] of mesh.children.entries()) {
      assert.equal(stage.renderOrder, i);
      assert.equal(stage.geometry, mesh.geometry);
      assert.deepEqual(stage.matrixWorld.elements, mesh.matrixWorld.elements);
      assert.equal(stage.layers.mask, mesh.layers.mask);
      assert.equal(stage.material.onBeforeCompile, material.onBeforeCompile);
      assert.equal(
        stage.material.customProgramCacheKey(),
        material.customProgramCacheKey(),
      );
      assert.deepEqual(stage.material.defines, material.defines);
    }
  });
  assert.equal(calls, 1);
  assert.equal(mesh.material, material);
  assert.equal(mesh.children.length, 0);
  mesh.geometry.dispose();
  material.dispose();
});

test('stages track replaced batch geometry, shader versions and live colour/opacity without recompiling steady frames', () => {
  const mesh = batchStencilDraws(fixture()),
    source = mesh.material;
  let previous, versions;
  mesh.process(() => {
    previous = mesh.children.slice();
    versions = previous.map((s) => s.material.version);
  });
  const old = mesh.geometry;
  mesh.geometry = new BufferGeometry();
  old.dispose();
  source.color.setHex(0xffcc00);
  source.opacity = 0.22;
  source.stencilRef = 2;
  source.stencilFuncMask = 0x0f;
  source.stencilWriteMask = 0x0f;
  mesh.process(() => {
    assert.deepEqual(mesh.children, previous);
    assert.deepEqual(
      mesh.children.map((s) => s.material.version),
      versions,
    );
    for (const s of mesh.children) {
      assert.equal(s.geometry, mesh.geometry);
      assert.equal(s.material.color, source.color);
      assert.equal(s.material.opacity, 0.22);
      assert.equal(s.material.stencilRef, 2);
      assert.equal(s.material.stencilFuncMask, 0x0f);
      assert.equal(s.material.stencilWriteMask, 0x0f);
    }
  });
  source.defines.NVR_NORMAL = 1;
  source.needsUpdate = true;
  mesh.process(() => {
    for (const [i, s] of mesh.children.entries()) {
      assert.equal(s.material.defines.NVR_NORMAL, 1);
      assert.ok(s.material.version > versions[i]);
    }
  });
  mesh.geometry.dispose();
  source.dispose();
});

test('render exceptions restore original ownership and stencil state; material disposal releases only owned resources', () => {
  const mesh = batchStencilDraws(fixture()),
    source = mesh.material,
    saved = snapshot(source);
  let disposed = 0,
    geometryDisposed = 0;
  mesh.geometry.addEventListener('dispose', () => geometryDisposed++);
  assert.throws(
    () =>
      mesh.process(() => {
        mesh.material.addEventListener('dispose', () => disposed++);
        for (const s of mesh.children)
          s.material.addEventListener('dispose', () => disposed++);
        throw new Error('draw failure');
      }),
    /draw failure/,
  );
  assert.equal(mesh.material, source);
  assert.equal(mesh.children.length, 0);
  assert.deepEqual(snapshot(source), saved);
  source.dispose();
  assert.equal(disposed, 4);
  assert.equal(geometryDisposed, 0);
  mesh.process(() => assert.fail('disposed owner must not allocate or draw'));
  source.dispose();
  assert.equal(disposed, 4);
  mesh.geometry.dispose();
});

test('hidden meshes allocate nothing; meshes with children keep native behavior', () => {
  const mesh = batchStencilDraws(fixture());
  mesh.visible = false;
  mesh.process(() => assert.fail('hidden draw'));
  assert.equal(mesh.children.length, 0);
  mesh.visible = true;
  const child = new Group();
  mesh.add(child);
  let calls = 0;
  mesh.process(() => {
    calls++;
    assert.deepEqual(mesh.children, [child]);
  });
  assert.equal(calls, 3);
  mesh.material.dispose();
  mesh.geometry.dispose();
});
