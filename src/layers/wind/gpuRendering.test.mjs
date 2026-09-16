import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindGpuRendering } from './gpuRendering.js';

function harness({ width = 1000 } = {}) {
  const members = new Set();
  let geometryBuilds = 0;
  class Material {
    constructor(options) {
      this.uniforms = options.fabric.uniforms;
      this.source = options.fabric.source;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  class Appearance {
    static VERTEX_FORMAT = {};
    constructor(options) {
      Object.assign(this, options);
      this.vertexShaderSource ??=
        'in vec3 position3DHigh; in vec3 position3DLow; void main() { gl_Position = vec4(0.0); v_st.s = st.s; }';
    }
  }
  class Polyline {
    constructor(options) {
      Object.assign(this, options);
    }
    static createGeometry(options) {
      geometryBuilds++;
      const st = new Float32Array(options.positions.length * 2);
      for (let i = 0; i < options.positions.length; i++)
        st[i * 2] = i / (options.positions.length - 1);
      return { attributes: { st: { values: st } } };
    }
  }
  class Primitive {
    constructor(options) {
      Object.assign(this, options);
      this.ready = true;
    }
    destroy() {
      this.destroyed = true;
    }
    isDestroyed() {
      return Boolean(this.destroyed);
    }
  }
  const C = {
    ComponentDatatype: { FLOAT: 5126 },
    GeometryInstanceAttribute: class {
      constructor(options) {
        Object.assign(this, options);
      }
    },
    Material,
    PolylineMaterialAppearance: Appearance,
    PolylineGeometry: Polyline,
    Primitive,
    GeometryInstance: class {
      constructor(options) {
        Object.assign(this, options);
      }
    },
    Cartesian3: { fromDegrees: (...values) => values },
    ArcType: { NONE: 0 },
  };
  const scene = {
    canvas: { clientWidth: width },
    primitives: {
      add(item) {
        members.add(item);
      },
      remove(item) {
        const removed = members.delete(item);
        if (removed) item.destroy();
        return removed;
      },
    },
  };
  return {
    C,
    scene,
    members,
    builds: () => geometryBuilds,
    owner: createWindGpuRendering({ cesium: C, getViewer: () => ({ scene }) }),
  };
}
const field = () => ({
  nx: 4,
  ny: 3,
  lo1: -180,
  la1: 90,
  dx: 90,
  dy: 90,
  u: new Float32Array(12).fill(15),
  v: new Float32Array(12),
});

test('GPU owner builds one native batch; ticks update uniforms without rebuilding geometry', () => {
  const h = harness();
  assert.equal(h.owner.setField(field()), true);
  assert.equal(h.members.size, 1);
  const batch = [...h.members][0];
  assert.equal(batch.allowPicking, false);
  assert.equal(batch.asynchronous, true);
  assert.ok(batch.appearance.vertexShaderSource.includes('v_windFacing = dot'));
  assert.ok(
    batch.appearance.material.source.includes(
      'smoothstep(0.0, 0.065, v_windFacing)',
    ),
  );
  const builds = h.builds();
  assert.equal(builds, 0, 'expanded geometry is deferred to Cesium workers');
  assert.ok(
    batch.appearance.vertexShaderSource.includes(
      'czm_batchTable_windSeed(batchId)',
    ),
  );
  h.owner.tick(3);
  assert.equal(batch.appearance.material.uniforms.phaseTime, 3);
  h.owner.setOptions({ paused: true });
  h.owner.tick(8);
  assert.equal(batch.appearance.material.uniforms.phaseTime, 3);
  h.owner.setOptions({ paused: false });
  h.owner.tick(9);
  assert.equal(batch.appearance.material.uniforms.phaseTime, 9);
  assert.equal(h.builds(), builds);
  const diagnostics = h.owner.getDiagnostics();
  assert.ok(diagnostics.pathCount <= 7200);
  assert.ok(diagnostics.pathCount > 7000, 'desktop retains the requested doubled global density');
  assert.ok(diagnostics.vertexCount > 0);
  assert.ok(diagnostics.vertexCount <= 7200 * 128, 'expanded geometry remains bounded');
  assert.equal(diagnostics.ready, true);
  assert.equal(diagnostics.displayHeightMeters, 12000);
  const instances = batch.geometryInstances;
  for (const instance of instances) {
    assert.ok(instance.geometry instanceof h.C.PolylineGeometry);
    assert.equal(instance.geometry.width, 2.4);
    assert.equal(instance.attributes.windSeed.componentsPerAttribute, 1);
    assert.ok(Number.isInteger(instance.attributes.windSeed.value[0]));
  }
});

test('replacement, clear and destroy dispose the exact owned batch and material', () => {
  const h = harness();
  h.owner.setField(field());
  const old = [...h.members][0];
  h.owner.setField(field());
  assert.equal(old.destroyed, true);
  assert.equal(old.appearance.material.destroyed, true);
  assert.equal(h.members.size, 1);
  h.owner.clear();
  assert.equal(h.members.size, 0);
  assert.equal(h.owner.getParticleCount(), 0);
  h.owner.destroy();
  assert.equal(h.owner.supported(), false);
  assert.equal(h.owner.setField(field()), false);
});

test('unsupported or failed geometry cleanly requests the existing fallback', () => {
  const missing = createWindGpuRendering({
    cesium: {},
    getViewer: () => ({ scene: {} }),
  });
  assert.equal(missing.setField(field()), false);
  const h = harness();
  h.C.PolylineGeometry = class {
    constructor() {
      throw new Error('test build failure');
    }
  };
  assert.equal(h.owner.setField(field()), false);
  assert.equal(h.members.size, 0);
  assert.match(h.owner.getDiagnostics().error, /test build failure/);
});

test('narrow canvases use a lower bounded path budget', () => {
  const h = harness({ width: 390 });
  assert.equal(h.owner.setField(field()), true);
  assert.ok(h.owner.getParticleCount() <= 1200);
  assert.ok(h.owner.getParticleCount() > 1000);
});
