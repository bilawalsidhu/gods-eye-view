import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindRelief } from './relief.js';

function fixture({ material = undefined, normals = true } = {}) {
  const materials = [];
  class Material {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      materials.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      assert.equal(this.destroyed, false);
      this.destroyed = true;
    }
  }
  let renders = 0;
  const globe = { material, terrainProvider: { hasVertexNormals: normals } };
  const scene = { globe, requestRender: () => renders++ };
  const viewer = { scene };
  const relief = createWindRelief({
    cesium: { Material },
    getViewer: () => viewer,
  });
  return { relief, globe, scene, viewer, materials, renders: () => renders };
}

test('relief acquires once and restores the exact prior empty material on clear', () => {
  for (const material of [null, undefined]) {
    const f = fixture({ material });
    f.globe.material = material;
    assert.equal(f.relief.attach(), true);
    assert.equal(f.relief.attach(), true);
    assert.equal(f.materials.length, 1);
    assert.equal(f.globe.material, f.materials[0]);
    assert.equal(f.relief.getDiagnostics().active, true);
    f.relief.clear();
    assert.equal(f.globe.material, material);
    assert.equal(f.materials[0].destroyed, true);
    assert.equal(f.renders(), 2);
    f.relief.clear();
    assert.equal(f.renders(), 2);
    assert.equal(f.relief.attach(), true);
    f.relief.destroy();
    assert.equal(f.materials[1].destroyed, true);
    assert.equal(f.relief.attach(), false);
  }
});

test('pre-existing and replacement material owners are never overwritten', () => {
  const other = { name: 'other-owner' };
  const f = fixture({ material: other });
  assert.equal(f.relief.attach(), false);
  assert.equal(f.globe.material, other);
  assert.equal(f.materials.length, 0);
  f.globe.material = undefined;
  assert.equal(f.relief.attach(), true);
  f.globe.material = other;
  assert.equal(f.relief.getDiagnostics().reason, 'Globe material replaced');
  f.relief.clear();
  assert.equal(f.globe.material, other);
  assert.equal(f.materials[0].destroyed, true);
  assert.equal(f.relief.attach(), false);
  f.relief.destroy();
  assert.equal(f.globe.material, other);
});

test('missing terrain normals uses curvature only and upgrades when normals exist', () => {
  const f = fixture({ normals: false });
  assert.equal(f.relief.attach(), true);
  assert.equal(f.relief.getDiagnostics().mode, 'globe curvature');
  const source = f.materials[0].options.fabric.source;
  assert.doesNotMatch(source, /normalEC|slope/);
  assert.match(source, /materialInput.positionToEyeEC/);
  assert.match(source, /czm_ellipsoidInverseRadii/);
  f.globe.terrainProvider.hasVertexNormals = true;
  assert.equal(f.relief.attach(), true);
  assert.equal(f.materials[0].destroyed, true);
  assert.equal(f.relief.getDiagnostics().mode, 'terrain relief');
  assert.match(f.materials[1].options.fabric.source, /materialInput.normalEC/);
  f.relief.destroy();
  assert.equal(f.globe.material, undefined);
});

test('moving to a new viewer releases the old globe and owns only the new one', () => {
  const f = fixture();
  f.relief.attach();
  const old = f.globe;
  const next = { material: null, terrainProvider: { hasVertexNormals: true } };
  f.viewer.scene = { globe: next, requestRender() {} };
  assert.equal(f.relief.attach(), true);
  assert.equal(old.material, undefined);
  assert.equal(f.materials[0].destroyed, true);
  assert.equal(next.material, f.materials[1]);
  f.relief.destroy();
  assert.equal(next.material, null);
});
