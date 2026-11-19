import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWindGpuRendering,
  windHeightFade,
  windStreamlineSpec,
} from './gpuRendering.js';
import {
  WIND_DISPLAY_HEIGHT_METERS,
  WIND_NARROW_PATH_LIMIT,
  WIND_PATH_LIMIT,
  WIND_PATH_STEPS,
} from './streamlines.js';

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
function harness({ width = 1000, height = 2_000_000, refuse = null } = {}) {
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
