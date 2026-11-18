import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWindGpuRendering,
  streamlineSeeds,
  windHeightFade,
  windStreamlineSpec,
} from './gpuRendering.js';
import {
  WIND_DISPLAY_HEIGHT_METERS,
  WIND_NARROW_PATH_LIMIT,
  WIND_PATH_LIMIT,
  WIND_PATH_STEPS,
  bakeWindStreamlines,
  measureLineCoverage,
} from './streamlines.js';
import {
  OCEAN_FIELD_SPEC,
  WIND_FIELD_SPEC,
  fieldSeedBudget,
} from './fieldSpec.js';

const wind = () => ({
  nx: 4,
  ny: 3,
  lo1: -180,
  la1: 90,
  dx: 90,
  dy: 90,
  u: new Float32Array(12).fill(15),
  v: new Float32Array(12),
});

// A draw port whose fields record what they were asked, a camera at
// `height` and a canvas `width` wide.
function harness({
  width = 1000,
  height = 2_000_000,
  refuse = null,
  spec,
} = {}) {
  const fields = [];
  const camera = { height };
  const viewer = { canvas: { clientWidth: width } };
  const draw = {
    field(spec) {
      if (refuse) throw refuse;
      const listeners = [];
      const handle = {
        spec,
        updates: [],
        disposed: false,
        show: true,
        update(patch) {
          this.updates.push(patch);
        },
        on(event, cb) {
          assert.equal(event, 'drawn');
          listeners.push(cb);
          return () => {};
        },
        dispose() {
          assert.equal(this.disposed, false, 'disposed once');
          this.disposed = true;
        },
        tell: () => listeners.forEach((cb) => cb()),
      };
      fields.push(handle);
      return handle;
    },
  };
  const frames = [];
  const owner = createWindGpuRendering({
    getViewer: () => viewer,
    drawOf: () => draw,
    cameraOf: () => ({ pose: () => ({ height: camera.height }) }),
    frameOf: () => ({ requestRender: (reason) => frames.push(reason) }),
    spec,
  });
  return { owner, fields, camera, viewer, draw, frames };
}

test('the fade by camera height is none below 15 km and full from 60 km', () => {
  assert.equal(windHeightFade(10_000), 0);
  assert.equal(windHeightFade(15_000), 0);
  assert.equal(windHeightFade(37_500), 0.5);
  assert.equal(windHeightFade(60_000), 1);
  assert.equal(windHeightFade(2e7), 1);
});

test('a wind grid becomes a windStreamlines spec over the rectangle its samples span', () => {
  const field = wind();
  const spec = windStreamlineSpec(field, {
    id: 'w',
    pathBudget: 100,
    alpha: 0.5,
    paused: true,
  });
  assert.equal(spec.kind, 'windStreamlines');
  assert.deepEqual(spec.rectangle, {
    west: -180,
    south: -90,
    east: 180,
    north: 90,
  });
  assert.equal(spec.width, 4);
  assert.equal(spec.height, 3);
  assert.equal(spec.steps, WIND_PATH_STEPS);
  assert.equal(spec.heightM, WIND_DISPLAY_HEIGHT_METERS);
  assert.equal(spec.alpha, 0.5);
  assert.equal(spec.paused, true);
  assert.equal(spec.u, field.u);
  assert.equal(spec.v, field.v);
  const regional = windStreamlineSpec(
    { ...field, nx: 4, ny: 4, lo1: -100, la1: 50, dx: 10, dy: 10 },
    { id: 'r', pathBudget: 1 },
  );
  assert.deepEqual(
    regional.rectangle,
    { west: -100, south: 20, east: -70, north: 50 },
    'a regional grid spans its samples and does not wrap',
  );
});

test('streamlines draw through the port, faded by height, paused and ready once drawn', () => {
  const h = harness({ height: 37_500 });
  assert.equal(h.owner.supported(), true);
  assert.equal(h.owner.setField(wind()), true);
  const [field] = h.fields;
  assert.equal(field.spec.pathBudget, WIND_PATH_LIMIT);
  assert.equal(field.spec.alpha, 0.5);
  assert.equal(field.spec.paused, false);
  assert.equal(h.owner.getDiagnostics().ready, false);
  assert.equal(h.owner.getDiagnostics().mode, 'gpu-streamlines');
  assert.equal(h.owner.getParticleCount(), WIND_PATH_LIMIT);
  field.tell();
  assert.equal(h.owner.getDiagnostics().ready, true);
  assert.deepEqual(h.frames, ['wind'], 'a still scene draws the ready state');
  assert.equal(h.owner.updateVisibility(), true);
  assert.deepEqual(field.updates, [], 'an unchanged fade asks nothing');
  h.camera.height = 10_000;
  assert.equal(h.owner.updateVisibility(), false, 'nothing draws low down');
  assert.deepEqual(field.updates, [{ alpha: 0 }]);
  assert.equal(h.owner.getDiagnostics().heightFade, 0);
  h.camera.height = 100_000;
  assert.equal(h.owner.updateVisibility(), true);
  h.owner.setOptions({ paused: true });
  h.owner.setOptions({ paused: true });
  h.owner.setOptions({ overlay: 'speed' });
  assert.deepEqual(field.updates, [
    { alpha: 0 },
    { alpha: 1 },
    { paused: true },
  ]);
  h.owner.setField(wind());
  assert.equal(field.disposed, true, 'a new grid replaces the field');
  assert.equal(h.fields[1].spec.paused, true, 'and keeps the pause');
  assert.notEqual(h.fields[1].spec.id, field.spec.id);
  h.owner.clear();
  assert.equal(h.fields[1].disposed, true);
  assert.equal(h.owner.getParticleCount(), 0);
  assert.equal(h.owner.getDiagnostics().ready, false);
  h.owner.destroy();
  assert.equal(h.owner.supported(), false);
  assert.equal(h.owner.setField(wind()), false);
});

test('narrow canvases use a lower bounded path budget', () => {
  const h = harness({ width: 600 });
  assert.equal(h.owner.setField(wind()), true);
  assert.equal(h.fields[0].spec.pathBudget, WIND_NARROW_PATH_LIMIT);
});

test('a refused or missing field falls back to the canvas', () => {
  const refused = harness({ refuse: new TypeError('no streamlines here') });
  assert.equal(refused.owner.setField(wind()), false);
  assert.equal(refused.owner.getDiagnostics().error, 'no streamlines here');
  assert.equal(refused.owner.getParticleCount(), 0);
  const none = createWindGpuRendering({
    getViewer: () => ({}),
    drawOf: () => ({}),
    cameraOf: () => null,
  });
  assert.equal(none.supported(), false);
  assert.equal(none.setField(wind()), false);
  const absent = createWindGpuRendering({ getViewer: () => null });
  assert.equal(absent.supported(), false);
});

// A 10 x 10 lattice over 30..39 N, 75..66 W at 0.4 m/s east.
const oceanBox = () => ({
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
});

test('the wind spec names no ramp, no-data, step or calm cutoff: its field is unchanged', () => {
  const spec = windStreamlineSpec(wind(), { id: 'w', pathBudget: 100 });
  assert.deepEqual(Object.keys(spec.style).sort(), ['color', 'widthPx']);
  for (const key of ['noData', 'stepSeconds', 'calmMs'])
    assert.equal(key in spec, false, `${key} is the tracer's default`);
  const h = harness();
  h.owner.setField(wind());
  const diagnostics = h.owner.getDiagnostics();
  assert.equal(diagnostics.speedScale, 1);
  assert.equal(diagnostics.stepSeconds, 1800);
  assert.equal(diagnostics.lineCoverage, null);
});

test('ocean spec scales the step by (E1), sends its ramp and keeps the field box', () => {
  const h = harness({ spec: OCEAN_FIELD_SPEC });
  assert.equal(h.owner.setField(oceanBox()), true);
  const diagnostics = h.owner.getDiagnostics();
  assert.equal(diagnostics.speedScale, 5.836 / 0.4);
  assert.equal(diagnostics.stepSeconds, 1800 * (5.836 / 0.4));
  const { spec } = h.fields[0];
  assert.equal(spec.stepSeconds, 1800 * (5.836 / 0.4));
  assert.equal(spec.calmMs, 0.02);
  assert.equal(spec.noData, -9999);
  assert.deepEqual(spec.rectangle, {
    west: -75,
    south: 30,
    east: -66,
    north: 39,
  });
  // The ramp saturates at max(0.2, 1.25 x p95) = 1 m/s.
  assert.deepEqual(spec.style.ramp, {
    stops: [...OCEAN_FIELD_SPEC.ramp],
    maxMs: 1,
    gamma: 0.55,
  });
});

test('display height and height-fade thresholds come from the field spec', () => {
  assert.equal(WIND_FIELD_SPEC.displayHeightMeters, 12000);
  assert.equal(WIND_FIELD_SPEC.fadeLowMeters, 15000);
  assert.equal(WIND_FIELD_SPEC.fadeHighMeters, 60000);
  assert.equal(OCEAN_FIELD_SPEC.displayHeightMeters, 100);
  assert.equal(OCEAN_FIELD_SPEC.fadeLowMeters, 300);
  assert.equal(OCEAN_FIELD_SPEC.fadeHighMeters, 1200);
  // 1000 m up is (1000 - 300) / 900 of the way from low to high.
  assert.ok(
    Math.abs(windHeightFade(1000, OCEAN_FIELD_SPEC) - 700 / 900) < 1e-12,
  );
  const h = harness({ spec: OCEAN_FIELD_SPEC, height: 1000 });
  assert.equal(h.owner.setField(oceanBox()), true);
  assert.equal(h.fields[0].spec.heightM, 100);
  assert.ok(Math.abs(h.fields[0].spec.alpha - 700 / 900) < 1e-12);
  assert.equal(h.owner.getDiagnostics().displayHeightMeters, 100);
  h.camera.height = 200;
  assert.equal(h.owner.updateVisibility(), false, 'below the ocean fade');
  assert.equal(h.owner.getDiagnostics().heightFade, 0);
});

test('ocean spec seeds the globe at globeSeedScale times the wind budget', () => {
  const h = harness({ spec: OCEAN_FIELD_SPEC });
  // The served global manifest carries the lattice extent as its bbox.
  const globe = {
    ...wind(),
    periodic: true,
    bbox: { latMin: -90, latMax: 90, lonMin: -180, lonMax: 180 },
    speed: { medianMs: 0.2, p95Ms: 0.5 },
  };
  assert.equal(h.owner.setField(globe), true);
  assert.equal(h.fields[0].spec.pathBudget, 2 * WIND_PATH_LIMIT);
  assert.equal(h.owner.getDiagnostics().seedCount, 2 * WIND_PATH_LIMIT);
  assert.equal(h.owner.getDiagnostics().lineCoverage, null);
  const narrow = harness({ spec: OCEAN_FIELD_SPEC, width: 600 });
  narrow.owner.setField(globe);
  assert.equal(narrow.fields[0].spec.pathBudget, 2 * WIND_NARROW_PATH_LIMIT);
});

test('ocean spec seeds a box from its line coverage and reports the realized coverage', () => {
  const h = harness({ spec: OCEAN_FIELD_SPEC });
  const ocean = {
    nx: 97,
    ny: 81,
    lo1: -82,
    la1: 45,
    dx: 0.25,
    dy: 0.25,
    u: new Float32Array(97 * 81).fill(0.4),
    v: new Float32Array(97 * 81),
    periodic: false,
    noData: -9999,
    bbox: { latMin: 25, latMax: 45, lonMin: -82, lonMax: -58 },
    speed: { medianMs: 0.4, p95Ms: 0.8, validCells: 7857, totalCells: 7857 },
  };
  assert.equal(h.owner.setField(ocean), true);
  const d = h.owner.getDiagnostics();
  const seeds = fieldSeedBudget(OCEAN_FIELD_SPEC, ocean, 7200);
  assert.equal(d.seedCount, seeds);
  assert.equal(h.fields[0].spec.pathBudget, seeds);
  assert.ok(
    seeds < 1000,
    `coverage budget is far below the wind limit, got ${seeds}`,
  );
  // Uniform 0.4 m/s: every step is 0.4 x 1800 x (5.836 / 0.4) m = 0.0945 deg,
  // 32 steps per path over a 24 deg span; paths seeded near the east and
  // west edges stop at the edge, so the realized coverage falls short of
  // every seed running its full length.
  const perPath = (32 * (0.4 * 1800 * (5.836 / 0.4))) / 111195;
  const full = (seeds * perPath) / 24;
  assert.ok(
    d.lineCoverage > 0.75 * full && d.lineCoverage <= full + 1e-9,
    `lineCoverage ${d.lineCoverage} vs full-length ${full}`,
  );
  // The coverage is that of the paths the renderer will trace.
  const { spec } = h.fields[0];
  const traced = bakeWindStreamlines(
    { ...ocean },
    {
      count: spec.pathBudget,
      maxCount: spec.pathBudget,
      stepSeconds: spec.stepSeconds,
      calmCutoffMs: spec.calmMs,
      bounds: spec.rectangle,
    },
  );
  assert.equal(d.lineCoverage, measureLineCoverage(traced, 24));
  assert.deepEqual(streamlineSeeds(ocean, OCEAN_FIELD_SPEC, 7200), {
    seeds,
    lineCoverage: d.lineCoverage,
  });
});

test('a box whose paths stop early is reseeded until it holds the spec coverage', () => {
  const h = harness({ spec: OCEAN_FIELD_SPEC });
  // Northward flow with a no-data row every other degree: every path ends
  // within a degree of its seed, a third of the median path length the
  // budget assumes, so the first pass lands well under the coverage.
  const nx = 97;
  const ny = 81;
  const u = new Float32Array(nx * ny);
  const v = new Float32Array(nx * ny).fill(0.4);
  let valid = 0;
  for (let row = 0; row < ny; row++) {
    const noData = Math.floor(row / 4) % 2 === 1;
    for (let col = 0; col < nx; col++) {
      if (noData) {
        u[row * nx + col] = -9999;
        v[row * nx + col] = -9999;
      } else valid++;
    }
  }
  const ocean = {
    nx,
    ny,
    lo1: -82,
    la1: 45,
    dx: 0.25,
    dy: 0.25,
    u,
    v,
    periodic: false,
    noData: -9999,
    bbox: { latMin: 25, latMax: 45, lonMin: -82, lonMax: -58 },
    speed: {
      medianMs: 0.4,
      p95Ms: 0.8,
      validCells: valid,
      totalCells: nx * ny,
    },
  };
  assert.equal(h.owner.setField(ocean), true);
  const d = h.owner.getDiagnostics();
  const firstPass = fieldSeedBudget(OCEAN_FIELD_SPEC, ocean, 7200);
  assert.ok(
    d.seedCount > firstPass,
    `reseeded past ${firstPass}, got ${d.seedCount}`,
  );
  assert.ok(d.seedCount <= 7200);
  assert.equal(h.fields[0].spec.pathBudget, d.seedCount);
  assert.ok(
    d.lineCoverage >= 0.85 * OCEAN_FIELD_SPEC.boxLineCoverage,
    `coverage ${d.lineCoverage} vs target ${OCEAN_FIELD_SPEC.boxLineCoverage}`,
  );
});

test("readyMs is stamped once, when the renderer says the field is drawn", () => {
  const h = harness();
  h.owner.setField(wind());
  const pending = h.owner.getDiagnostics();
  assert.equal(pending.ready, false);
  assert.equal(pending.readyMs, null, 'not drawn: no stamp');
  h.fields[0].tell();
  const done = h.owner.getDiagnostics();
  assert.equal(done.ready, true);
  assert.ok(Number.isFinite(done.readyMs), 'drawn: stamped');
  assert.ok(done.readyMs >= done.buildMs, 'ready follows the build');
  h.fields[0].tell();
  assert.equal(h.owner.getDiagnostics().readyMs, done.readyMs, 'stamped once');
  h.owner.setField(wind());
  assert.equal(
    h.owner.getDiagnostics().readyMs,
    null,
    'a new field resets the stamp until it is drawn',
  );
  h.fields[0].tell();
  assert.equal(
    h.owner.getDiagnostics().readyMs,
    null,
    'a replaced field is not the one waited for',
  );
  h.fields[1].tell();
  assert.ok(Number.isFinite(h.owner.getDiagnostics().readyMs));
  h.owner.clear();
  assert.equal(h.owner.getDiagnostics().readyMs, null);
});
