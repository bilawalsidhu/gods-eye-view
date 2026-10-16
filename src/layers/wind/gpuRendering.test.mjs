import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindGpuRendering } from './gpuRendering.js';
import {
  BoundingSphere,
  Cartesian3,
  Ellipsoid,
  Intersect,
  Occluder,
  PerspectiveFrustum,
} from 'cesium';
import { bakeWindStreamlines } from './streamlines.js';

function harness({ width = 1000 } = {}) {
  const members = new Set();
  let geometryBuilds = 0;
  const spheres = [];
  const visibility = {
    horizon: () => true,
    frustum: () => Intersect.INSIDE,
    horizonTests: 0,
    frustumTests: 0,
  };
  let occluderBuilds = 0;
  class Material {
    constructor(options) {
      this.uniforms = options.fabric.uniforms;
      this.source = options.fabric.source;
    }
    destroy() {
      assert.ok(!this.destroyed, 'owned resource destroyed once');
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
      assert.ok(!this.destroyed, 'owned resource destroyed once');
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
    Cartesian3,
    Ellipsoid,
    Intersect,
    BoundingSphere: class extends BoundingSphere {
      static fromPoints(points) {
        const sphere = BoundingSphere.fromPoints(points);
        spheres.push({ sphere, points });
        return sphere;
      }
    },
    Occluder: class {
      constructor(sphere, cameraPosition) {
        occluderBuilds++;
        this.cameraPosition = cameraPosition;
      }
      isBoundingSphereVisible(sphere) {
        visibility.horizonTests++;
        return visibility.horizon(sphere, this.cameraPosition);
      }
    },
    ArcType: { NONE: 0 },
  };
  const volume = {
    computeVisibility(sphere) {
      visibility.frustumTests++;
      return visibility.frustum(sphere);
    },
  };
  const scene = {
    globe: { show: false },
    camera: {
      positionWC: Cartesian3.fromDegrees(0, 0, 1e7),
      positionCartographic: { height: 1e7 },
      directionWC: new Cartesian3(-1, 0, 0),
      upWC: new Cartesian3(0, 0, 1),
      frustum: { computeCullingVolume: () => volume },
    },
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
    spheres,
    visibility,
    occluderBuilds: () => occluderBuilds,
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

test('GPU owner builds regional native batches; ticks update uniforms without rebuilding geometry', () => {
  const h = harness();
  assert.equal(h.owner.setField(field()), true);
  assert.equal(h.members.size, 72);
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
  assert.ok(
    diagnostics.pathCount > 7000,
    'desktop retains the requested doubled global density',
  );
  assert.ok(diagnostics.vertexCount > 0);
  assert.ok(
    diagnostics.vertexCount <= 7200 * 128,
    'expanded geometry remains bounded',
  );
  assert.equal(diagnostics.ready, true);
  assert.equal(diagnostics.displayHeightMeters, 12000);
  assert.equal(diagnostics.cellCount, 72);
  assert.equal(h.spheres.length, 72);
  assert.equal(new Set([...h.members].map((p) => p.appearance)).size, 72);
  for (const cell of h.members) {
    assert.equal(cell.appearance.material, batch.appearance.material);
    assert.equal(cell.appearance.material.uniforms.phaseTime, 9);
    assert.equal(cell.appearance.material.uniforms.ghostAlpha, 0.25);
    assert.equal(cell.compressVertices, false);
    assert.equal(cell.releaseGeometryInstances, true);
  }
  batch.ready = false;
  assert.equal(
    h.owner.getDiagnostics().ready,
    false,
    'every cell must be ready',
  );
  batch.ready = true;
  const instances = [...h.members].flatMap((p) => p.geometryInstances);
  const baked = bakeWindStreamlines(field());
  assert.equal(instances.length, baked.length);
  const bySeed = new Map(
    instances.map((i) => [i.attributes.windSeed.value[0], i]),
  );
  for (const path of baked) {
    assert.deepEqual(
      bySeed.get(path.seed).geometry.positions,
      path.coordinates.map(([lon, lat]) =>
        Cartesian3.fromDegrees(lon, lat, 12000),
      ),
    );
  }
  for (const { sphere, points } of h.spheres) {
    assert.deepEqual(sphere, BoundingSphere.fromPoints(points));
    for (const point of points)
      assert.ok(
        Cartesian3.distance(point, sphere.center) <= sphere.radius + 1e-6,
      );
  }
  for (const instance of instances) {
    assert.ok(instance.geometry instanceof h.C.PolylineGeometry);
    assert.equal(instance.geometry.width, 2.4);
    assert.equal(instance.attributes.windSeed.componentsPerAttribute, 1);
    assert.ok(Number.isInteger(instance.attributes.windSeed.value[0]));
  }
});

test('replacement, clear and destroy dispose every owned cell and the shared material', () => {
  const h = harness();
  const assertDisposed = (batches) => {
    assert.equal(batches.length, 72);
    for (const batch of batches) {
      assert.equal(batch.destroyed, true);
      assert.equal(batch.appearance.material.destroyed, true);
    }
  };
  h.owner.setField(field());
  const first = [...h.members];
  h.owner.setField(field());
  assertDisposed(first);
  const second = [...h.members];
  h.owner.clear();
  assertDisposed(second);
  assert.equal(h.members.size, 0);
  assert.equal(h.owner.getParticleCount(), 0);
  assert.equal(h.owner.getDiagnostics().ready, false);
  h.owner.setField(field());
  const third = [...h.members];
  h.owner.destroy();
  assertDisposed(third);
  assert.equal(h.members.size, 0);
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

test('cell visibility combines horizon, frustum and height with shared fade uniforms', () => {
  const h = harness();
  h.owner.setField(field());
  const batches = [...h.members];
  const camera = h.scene.camera;
  h.visibility.horizon = (sphere) =>
    h.spheres.findIndex((s) => s.sphere === sphere) % 2 === 0;
  h.visibility.frustum = (sphere) =>
    h.spheres.findIndex((s) => s.sphere === sphere) % 3 === 0
      ? Intersect.INTERSECTING
      : Intersect.OUTSIDE;
  assert.equal(h.owner.updateVisibility(camera), true);
  assert.equal(h.owner.getDiagnostics().visibleCells, 12);
  let vertices = 0;
  for (let i = 0; i < batches.length; i++) {
    assert.equal(batches[i].show, i % 6 === 0);
    if (batches[i].show)
      vertices += batches[i].geometryInstances.reduce(
        (sum, p) => sum + p.geometry.positions.length * 4 - 4,
        0,
      );
  }
  assert.equal(h.owner.getDiagnostics().visibleVertexCount, vertices);
  assert.equal(h.visibility.horizonTests, 72);
  assert.equal(h.visibility.frustumTests, 36);
  for (const [height, fade] of [
    [60000, 1],
    [37500, 0.5],
    [15000, 0],
    [1200, 0],
  ]) {
    camera.positionCartographic.height = height;
    assert.equal(h.owner.updateVisibility(camera), fade > 0);
    assert.equal(h.owner.getDiagnostics().heightFade, fade);
    for (const batch of batches) {
      assert.equal(batch.appearance.material.uniforms.heightFade, fade);
      assert.match(batch.appearance.material.source, /horizon \* heightFade/);
      if (!fade) assert.equal(batch.show, false);
    }
  }
  assert.equal(h.owner.getDiagnostics().visibleVertexCount, 0);
  assert.equal(h.owner.getDiagnostics().visibleCells, 0);
  assert.equal(
    h.visibility.horizonTests,
    216,
    'zero fade skips all sphere tests',
  );
  assert.equal(h.visibility.frustumTests, 108);
  assert.equal(
    h.occluderBuilds(),
    1,
    'occluder is reused across camera updates',
  );
});

test('real Cesium sphere culling hides far hemisphere with globe hidden and rejects a sky-facing view', () => {
  const h = harness();
  h.C.Occluder = Occluder;
  h.owner.setField(field());
  const camera = h.scene.camera;
  camera.frustum = new PerspectiveFrustum({
    fov: Math.PI / 3,
    aspectRatio: 1.5,
    near: 1,
    far: 5e7,
  });
  assert.equal(h.owner.updateVisibility(camera), true);
  const facingEarth = h.owner.getDiagnostics();
  assert.ok(facingEarth.visibleCells > 0 && facingEarth.visibleCells < 72);
  for (let i = 0; i < h.spheres.length; i++) {
    const sphere = h.spheres[i].sphere;
    if (sphere.center.x < -5e6) assert.equal([...h.members][i].show, false);
  }
  camera.directionWC.x = 1;
  assert.equal(h.owner.updateVisibility(camera), false);
  assert.equal(h.owner.getDiagnostics().visibleCells, 0);
  camera.positionWC = Cartesian3.fromDegrees(180, 0, 1e7);
  assert.equal(
    h.owner.updateVisibility(camera),
    true,
    'camera position updates the owned horizon test',
  );
  h.owner.destroy();
});

test('a failed later cell build releases already installed cells and shared material', () => {
  const h = harness();
  const NativePrimitive = h.C.Primitive;
  const built = [];
  h.C.Primitive = class extends NativePrimitive {
    constructor(options) {
      if (built.length === 2) throw new Error('later cell failed');
      super(options);
      built.push(this);
    }
  };
  assert.equal(h.owner.setField(field()), false);
  assert.equal(h.members.size, 0);
  assert.equal(built.length, 2);
  for (const batch of built) {
    assert.equal(batch.destroyed, true);
    assert.equal(batch.appearance.material.destroyed, true);
  }
  assert.match(h.owner.getDiagnostics().error, /later cell failed/);
});

test('wind spec reproduces the shipped bake and shader; ramp uniforms are white', async () => {
  const h = harness();
  h.owner.setField(field());
  const batch = [...h.members][0];
  assert.ok(
    batch.appearance.vertexShaderSource.includes(
      'czm_batchTable_fieldSpeed(batchId)',
    ),
  );
  assert.ok(
    batch.appearance.vertexShaderSource.includes('out float v_fieldSpeed;'),
  );
  assert.ok(
    batch.appearance.material.source.includes(
      'fieldRamp(pow(v_fieldSpeed, rampGamma))',
    ),
  );
  const uniforms = batch.appearance.material.uniforms;
  for (let i = 0; i < 5; i++)
    assert.deepEqual(
      [
        uniforms[`rampStop${i}`].x,
        uniforms[`rampStop${i}`].y,
        uniforms[`rampStop${i}`].z,
      ],
      [1, 1, 1],
    );
  assert.equal(uniforms.rampGamma, 1);
  const diagnostics = h.owner.getDiagnostics();
  assert.equal(diagnostics.speedScale, 1);
  assert.equal(diagnostics.stepSeconds, 1800);
  for (const instance of [...h.members].flatMap((p) => p.geometryInstances)) {
    assert.equal(instance.attributes.fieldSpeed.componentsPerAttribute, 1);
    assert.ok(
      Math.abs(instance.attributes.fieldSpeed.value[0] - 15 / 30) < 1e-12,
    );
  }
});

test('ocean spec scales the step by (E1), colours paths by speed and seeds inside the bbox', async () => {
  const { OCEAN_FIELD_SPEC, rampStopVectors } = await import('./fieldSpec.js');
  const h = harness();
  const owner = createWindGpuRendering({
    cesium: h.C,
    getViewer: () => ({ scene: h.scene }),
    spec: OCEAN_FIELD_SPEC,
  });
  const ocean = {
    nx: 10,
    ny: 10,
    lo1: -75,
    la1: 39,
    dx: 1,
    dy: 1,
    u: new Float32Array(100).fill(0.4),
    v: new Float32Array(100),
    periodic: false,
    noData: -9999,
    bbox: { latMin: 30, latMax: 39, lonMin: -75, lonMax: -66 },
    speed: { medianMs: 0.4, p95Ms: 0.8 },
  };
  assert.equal(owner.setField(ocean), true);
  const diagnostics = owner.getDiagnostics();
  assert.equal(diagnostics.speedScale, 5.836 / 0.4);
  assert.equal(diagnostics.stepSeconds, 1800 * (5.836 / 0.4));
  const batches = [...h.members];
  assert.ok(batches.length > 0);
  const batch = batches[0];
  const stops = rampStopVectors(OCEAN_FIELD_SPEC.ramp);
  const stop4 = batch.appearance.material.uniforms.rampStop4;
  assert.deepEqual([stop4.x, stop4.y, stop4.z], stops[4]);
  assert.equal(batch.appearance.material.uniforms.rampGamma, 0.55);
  for (const instance of batches.flatMap((p) => p.geometryInstances)) {
    assert.ok(Math.abs(instance.attributes.fieldSpeed.value[0] - 0.4 / 1) < 1e-6);
    for (const position of instance.geometry.positions) {
      const carto = Ellipsoid.WGS84.cartesianToCartographic(position);
      const lon = (carto.longitude * 180) / Math.PI;
      const lat = (carto.latitude * 180) / Math.PI;
      assert.ok(
        lon >= -75.001 && lon <= -65.999 && lat >= 29.999 && lat <= 39.001,
        `${lon}, ${lat}`,
      );
    }
  }
  owner.destroy();
});
