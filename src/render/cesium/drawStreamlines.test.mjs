import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BoundingSphere,
  Cartesian3,
  Ellipsoid,
  Event,
  Intersect,
  Occluder,
  PerspectiveFrustum,
} from 'cesium';
import { createWindStreamlines, windGridOf } from './drawStreamlines.js';
import { createCesiumFields } from './drawFields.js';
import { bakeWindStreamlines } from '../../layers/wind/streamlines.js';

const grid = () => ({
  nx: 4,
  ny: 3,
  lo1: -180,
  la1: 90,
  dx: 90,
  dy: 90,
  u: new Float32Array(12).fill(15),
  v: new Float32Array(12),
});
// The grid above as a field spec: 4 columns wrapping the globe, 3 rows.
const SPEC = Object.freeze({
  kind: 'windStreamlines',
  id: 'wind',
  u: new Float32Array(12).fill(15),
  v: new Float32Array(12),
  width: 4,
  height: 3,
  rectangle: { west: -180, south: -90, east: 180, north: 90 },
  pathBudget: 7200,
  steps: 16,
  style: { color: '#80c9e6', widthPx: 2.4 },
  heightM: 12000,
});

function harness() {
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
  const frames = [];
  const preRender = new Event();
  const postRender = new Event();
  let renders = 0;
  const scene = {
    preRender,
    postRender,
    requestRender() {
      renders += 1;
    },
    get renders() {
      return renders;
    },
    globe: { show: false },
    camera: {
      positionWC: Cartesian3.fromDegrees(0, 0, 1e7),
      positionCartographic: { height: 1e7 },
      directionWC: new Cartesian3(-1, 0, 0),
      upWC: new Cartesian3(0, 0, 1),
      frustum: { computeCullingVolume: () => volume },
    },
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
    frames,
    make: (patch = {}) =>
      createWindStreamlines({
        scene,
        cesium: C,
        spec: { ...SPEC, ...patch },
        requestFrame: (cb) => {
          frames.push(cb);
          return frames.length;
        },
        cancelFrame: (id) => {
          frames[id - 1] = null;
        },
      }),
    /** One render: the frame events around it. */
    render() {
      preRender.raiseEvent();
      postRender.raiseEvent();
    },
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

test('the spec reads back as the wind grid it came from', () => {
  const { u, v, ...rest } = windGridOf(SPEC);
  const { u: gu, v: gv, ...want } = grid();
  assert.deepEqual(rest, want);
  assert.deepEqual([...u], [...gu]);
  const regional = windGridOf({
    ...SPEC,
    rectangle: { west: -100, south: 20, east: -70, north: 50 },
  });
  assert.equal(regional.dx, 10, 'a regional grid does not wrap');
  assert.equal(regional.dy, 15);
  const across = windGridOf({
    ...SPEC,
    rectangle: { west: 170, south: 20, east: -170, north: 50 },
  });
  assert.equal(across.lo1, 170);
  assert.equal(across.dx, 20 / 3, 'across the antimeridian it runs east');
});

test('streamlines build native cells; the highlight moves without rebuilding', () => {
  const h = harness();
  const field = h.make();
  assert.equal(h.members.size, 72);
  const batch = [...h.members][0];
  assert.equal(batch.allowPicking, false);
  assert.equal(batch.asynchronous, true);
  assert.ok(batch.appearance.vertexShaderSource.includes('v_windFacing = dot'));
  assert.ok(
    batch.appearance.vertexShaderSource.includes(
      'czm_batchTable_windSeed(batchId)',
    ),
  );
  const { uniforms, source } = batch.appearance.material;
  assert.ok(source.includes('smoothstep(0.0, 0.065, v_windFacing)'));
  assert.ok(source.includes('mix(baseColor.rgb'));
  assert.equal(
    h.builds(),
    0,
    'expanded geometry is deferred to Cesium workers',
  );
  const diagnostics = field.diagnostics();
  assert.ok(diagnostics.pathCount > 7000 && diagnostics.pathCount <= 7200);
  assert.ok(diagnostics.vertexCount > 0);
  assert.equal(diagnostics.cellCount, 72);
  const instances = [...h.members].flatMap((p) => p.geometryInstances);
  const baked = bakeWindStreamlines(grid());
  assert.equal(instances.length, baked.length);
  const bySeed = new Map(
    instances.map((i) => [i.attributes.windSeed.value[0], i]),
  );
  for (const path of baked)
    assert.deepEqual(
      bySeed.get(path.seed).geometry.positions,
      path.coordinates.map(([lon, lat]) =>
        Cartesian3.fromDegrees(lon, lat, 12000),
      ),
    );
  for (const instance of instances) assert.equal(instance.geometry.width, 2.4);
  for (const cell of h.members) {
    assert.equal(cell.appearance.material, batch.appearance.material);
    assert.equal(cell.compressVertices, false);
    assert.equal(cell.releaseGeometryInstances, true);
  }
  assert.equal(uniforms.ghostAlpha, 0.25);
  assert.equal(uniforms.heightFade, 1);
  assert.ok(Math.abs(uniforms.tipSpeed - 0.16) < 1e-12);
  // A render culls the cells and starts the highlight on the page's frames.
  h.render();
  assert.equal(h.frames.length, 1);
  h.frames.at(-1)(1000);
  const first = uniforms.phaseTime;
  assert.ok(first > 0);
  const asked = h.scene.renders;
  h.frames.at(-1)(1010);
  assert.equal(uniforms.phaseTime, first, 'at most 30 steps a second');
  assert.equal(h.scene.renders, asked, 'and no frame drawn between them');
  h.frames.at(-1)(1040);
  assert.ok(Math.abs(uniforms.phaseTime - first - 0.04) < 1e-9);
  assert.equal(h.scene.renders, asked + 1);
  field.update({ paused: true });
  assert.equal(uniforms.ghostAlpha, 0.34, 'paused raises the ghost');
  const held = uniforms.phaseTime;
  assert.equal(h.frames.at(-1), null, 'paused stops the frames');
  field.update({ paused: false, alpha: 0.5, style: { speedFactor: 2 } });
  assert.equal(uniforms.heightFade, 0.5);
  assert.ok(Math.abs(uniforms.tipSpeed - 0.32) < 1e-12);
  assert.equal(uniforms.phaseTime, held);
  assert.equal(h.members.size, 72, 'style, alpha and pause never rebuild');
  field.dispose();
  assert.equal(h.members.size, 0);
  assert.equal(h.scene.preRender.numberOfListeners, 0);
  assert.equal(h.scene.postRender.numberOfListeners, 0);
});

test("streamlines tell 'drawn' once every cell is ready, never while hidden", () => {
  const h = harness();
  const field = h.make();
  let drawn = 0;
  field.on('drawn', () => (drawn += 1));
  const [batch] = h.members;
  batch.ready = false;
  h.render();
  h.render();
  assert.equal(drawn, 0, 'every cell must be ready');
  batch.ready = true;
  h.render();
  assert.equal(drawn, 1);
  h.render();
  assert.equal(drawn, 1);
  field.show = false;
  field.update({ alpha: 0.4 });
  h.render();
  h.render();
  assert.equal(drawn, 1, 'never while hidden');
  assert.equal(batch.show, false);
  field.show = true;
  h.render();
  h.render();
  assert.equal(drawn, 2, 'told once shown');
  field.update({ u: new Float32Array(12).fill(10) });
  assert.equal(batch.destroyed, true, 'a new grid traces again');
  h.render();
  h.render();
  assert.equal(drawn, 3);
  field.dispose();
});

test('a failed build is refused, holding nothing', () => {
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
  assert.throws(() => h.make(), /later cell failed/);
  assert.equal(h.members.size, 0);
  for (const batch of built) {
    assert.equal(batch.destroyed, true);
    assert.equal(batch.appearance.material.destroyed, true);
  }
  assert.equal(h.scene.preRender.numberOfListeners, 0);
});

test('a grid no path runs through is refused, holding nothing', () => {
  const h = harness();
  assert.throws(
    () => h.make({ u: new Float32Array(12), v: new Float32Array(12) }),
    /no wind streamlines/,
  );
  assert.equal(h.members.size, 0);
  assert.equal(h.scene.preRender.numberOfListeners, 0);
});

test('the Cesium fields draw wind streamlines under their id until disposed', () => {
  const h = harness();
  const fields = createCesiumFields({ scene: h.scene, cesium: h.C });
  const field = fields.field({ ...SPEC });
  assert.ok(h.members.size > 0);
  assert.equal(fields.has('wind'), true);
  assert.throws(() => fields.field({ ...SPEC }), /is live/);
  field.dispose();
  assert.equal(fields.has('wind'), false);
  assert.equal(h.members.size, 0);
  fields.field({ ...SPEC });
  fields.dispose();
  assert.equal(fields.has('wind'), false);
  assert.equal(h.members.size, 0);
});

test('a grid over part of the globe draws inside it, not wrapped', () => {
  const h = harness();
  const part = h.make({
    rectangle: { west: -100, south: -40, east: 80, north: 60 },
  });
  assert.ok(h.members.size > 0, 'drawn');
  part.dispose();
  const across = h.make({
    rectangle: { west: 0, south: -90, east: -0.000000000001, north: 90 },
  });
  assert.ok(h.members.size > 0, 'a rectangle across the antimeridian wraps');
  across.dispose();
});

test('paths over part of the globe seed and stay inside it', () => {
  const bounds = { west: 170, south: -20, east: 230, north: 30 };
  const field = {
    nx: 7,
    ny: 6,
    lo1: 170,
    la1: 30,
    dx: 10,
    dy: 10,
    u: new Float32Array(42).fill(40),
    v: new Float32Array(42).fill(5),
  };
  const paths = bakeWindStreamlines(field, { count: 400, bounds });
  assert.ok(paths.length > 100, `${paths.length} paths`);
  for (const path of paths)
    for (const [lon, lat] of path.coordinates) {
      assert.ok(lat >= bounds.south && lat <= bounds.north, `lat ${lat}`);
      const east = (((lon - bounds.west) % 360) + 360) % 360;
      assert.ok(east <= bounds.east - bounds.west, `lon ${lon}`);
    }
  // Without bounds, seeds fill the globe as they did.
  const global = bakeWindStreamlines(grid(), { count: 50 });
  assert.ok(global.some((p) => Math.abs(p.coordinates[0][1]) > 60));
});

test('a rebuild that fails draws nothing and is never told drawn', () => {
  const reported = [];
  const h = harness();
  const field = createWindStreamlines({
    scene: h.scene,
    cesium: h.C,
    spec: { ...SPEC },
    report: (error) => reported.push(error),
    requestFrame: () => 1,
    cancelFrame() {},
  });
  let drawn = 0;
  field.on('drawn', () => (drawn += 1));
  h.render();
  h.render();
  assert.equal(drawn, 1);
  const asked = h.scene.renders;
  field.update({ u: new Float32Array(12), v: new Float32Array(12) });
  assert.equal(reported.length, 1);
  assert.equal(h.members.size, 0);
  h.render();
  h.render();
  assert.equal(drawn, 1, 'nothing drawn is never told');
  assert.ok(h.scene.renders - asked <= 1, 'and asks no frames for it');
  field.dispose();
});

test('the highlight stops when hidden, transparent or out of view, and starts again', () => {
  const h = harness();
  const field = h.make();
  const live = () => h.frames.filter(Boolean).length;
  h.render();
  assert.equal(live(), 1);
  field.show = false;
  assert.equal(live(), 0, 'hidden');
  field.show = true;
  h.render();
  assert.equal(live(), 1);
  field.update({ alpha: 0 });
  assert.equal(live(), 0, 'transparent');
  field.update({ alpha: 1 });
  h.render();
  assert.equal(live(), 1);
  h.visibility.horizon = () => false;
  h.render();
  assert.equal(live(), 0, 'every cell behind the Earth');
  h.visibility.horizon = () => true;
  h.render();
  assert.equal(live(), 1, 'the next render in view starts it');
  field.dispose();
  assert.equal(live(), 0, 'dispose cancels the frame it asked for');
});

test('a hidden page stops the highlight; shown again, it starts afresh', () => {
  const listeners = new Set();
  const document = globalThis.document;
  const page = {
    hidden: false,
    addEventListener: (type, cb) => listeners.add(cb),
    removeEventListener: (type, cb) => listeners.delete(cb),
  };
  globalThis.document = page;
  try {
    const h = harness();
    const field = h.make();
    // Whether the frame asked for last is still pending.
    const pending = () => h.frames.at(-1) !== null;
    const { uniforms } = [...h.members][0].appearance.material;
    h.render();
    h.frames.at(-1)(1000);
    h.frames.at(-1)(1100);
    const before = uniforms.phaseTime;
    assert.ok(Math.abs(before - 1 / 60 - 0.1) < 1e-9, 'time passed moves it');
    h.frames.at(-1)(1400);
    assert.ok(
      Math.abs(uniforms.phaseTime - before - 0.3) < 1e-9,
      'a stall still moves it by the time passed',
    );
    page.hidden = true;
    for (const cb of listeners) cb();
    assert.equal(pending(), false, 'a hidden page asks no frames');
    page.hidden = false;
    for (const cb of listeners) cb();
    assert.equal(pending(), true);
    const shown = uniforms.phaseTime;
    h.frames.at(-1)(60_000);
    assert.ok(Math.abs(uniforms.phaseTime - shown - 1 / 60) < 1e-9);
    field.dispose();
    assert.equal(listeners.size, 0);
  } finally {
    globalThis.document = document;
  }
});

test('a scene not in 3D refuses streamlines', () => {
  const h = harness();
  h.C.SceneMode = { SCENE3D: 3 };
  h.scene.mode = 2;
  assert.throws(() => h.make(), /3D only/);
});

test('cell visibility combines horizon, frustum and alpha', () => {
  const h = harness();
  const field = h.make();
  const batches = [...h.members];
  h.visibility.horizon = (sphere) =>
    h.spheres.findIndex((s) => s.sphere === sphere) % 2 === 0;
  h.visibility.frustum = (sphere) =>
    h.spheres.findIndex((s) => s.sphere === sphere) % 3 === 0
      ? Intersect.INTERSECTING
      : Intersect.OUTSIDE;
  h.render();
  assert.equal(field.diagnostics().visibleCells, 12);
  for (let i = 0; i < batches.length; i++)
    assert.equal(batches[i].show, i % 6 === 0);
  assert.equal(h.visibility.horizonTests, 72);
  assert.equal(h.visibility.frustumTests, 36);
  field.update({ alpha: 0 });
  h.render();
  assert.equal(field.diagnostics().visibleCells, 0);
  for (const batch of batches) assert.equal(batch.show, false);
  assert.equal(h.visibility.horizonTests, 72, 'alpha 0 tests nothing');
  assert.equal(h.occluderBuilds(), 1, 'the occluder is reused');
  field.dispose();
});

test('real Cesium sphere culling hides the far hemisphere and a sky-facing view', () => {
  const h = harness();
  h.C.Occluder = Occluder;
  const field = h.make();
  const camera = h.scene.camera;
  camera.frustum = new PerspectiveFrustum({
    fov: Math.PI / 3,
    aspectRatio: 1.5,
    near: 1,
    far: 5e7,
  });
  h.render();
  const facing = field.diagnostics().visibleCells;
  assert.ok(facing > 0 && facing < 72);
  for (let i = 0; i < h.spheres.length; i++)
    if (h.spheres[i].sphere.center.x < -5e6)
      assert.equal([...h.members][i].show, false);
  camera.directionWC.x = 1;
  h.render();
  assert.equal(field.diagnostics().visibleCells, 0);
  field.dispose();
});
