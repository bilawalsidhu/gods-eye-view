// The wind display on the fake engine: its field as one imagery image,
// faded with the camera while streamlines draw, raised on 3D tiles; the
// flow is the backend's.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../../geo/index.js';
import { createFakeEngine } from '../../../globe/testing/fakeEngine.js';
import { WEATHER_SHELL_HEIGHTS } from '../../weather/shellRendering.js';
import { createWindDisplay, windFieldAlpha } from './display.js';

const snapshot = () => {
  const nx = 8;
  const ny = 5;
  return {
    model: 'gfs',
    grid: { nx, ny, lo1: 0, la1: 90, dx: 45, dy: 45 },
    u: Array.from({ length: nx * ny }, (_, i) => 5 + (i % 7)),
    v: Array.from({ length: nx * ny }, (_, i) => (i % 3) - 1),
  };
};
const canvasOf = (raster) => ({ width: raster.width, height: raster.height });
function flowStub() {
  const calls = [];
  const flow = {
    calls,
    attach: () => calls.push('attach'),
    setField: () => calls.push('setField'),
    setOptions: (options) => calls.push(['setOptions', options.overlay]),
    start: () => calls.push('start'),
    stop: () => calls.push('stop'),
    clear: () => calls.push('clear'),
    destroy: () => calls.push('destroy'),
    getParticleCount: () => 12,
    getDiagnostics: () => ({
      renderMode: 'gpu-streamlines',
      imageryError: null,
    }),
  };
  return flow;
}
const at = (engine, height) => {
  engine.camera.setView({
    destination: geo.cartesian3.fromDegrees(0, 0, height),
    orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
  });
  engine.fake.emit('frames.preRender');
};

test('the field fades below 1200 km while streamlines draw', () => {
  assert.equal(windFieldAlpha('speed', 2_000_000, true), 0.85);
  assert.equal(windFieldAlpha('temperature', 100_000, true), 0);
  assert.equal(windFieldAlpha('temperature', 100_000, false), 1);
  const middle = windFieldAlpha('speed', 489_898, true);
  assert.ok(Math.abs(middle - 0.85 / 2) < 0.01);
});

test('the field is one image layer over the globe, faded by height; the flow draws the paths', () => {
  const engine = createFakeEngine();
  const flow = flowStub();
  const display = createWindDisplay(engine, {
    flow: () => flow,
    createCanvas: canvasOf,
  });
  display.attach();
  display.setField(snapshot());
  display.start();
  assert.deepEqual(engine.fake.imageryLayers(), [], 'no overlay: no field');
  display.setOptions({ overlay: 'speed', paused: false });
  const [id] = engine.fake.imageryLayers();
  at(engine, 12_000_000);
  let field = engine.fake.imageryLayer(id);
  assert.equal(field.source.kind, 'image');
  assert.deepEqual(
    { ...field.source.rectangle },
    {
      west: -180,
      south: -90,
      east: 180,
      north: 90,
    },
  );
  assert.equal(field.raise, null);
  assert.equal(field.alpha, 0.85);
  assert.equal(field.shown, true);
  at(engine, 50_000);
  field = engine.fake.imageryLayer(id);
  assert.equal(field.alpha, 0);
  assert.equal(field.shown, false, 'low down the paths carry the wind');
  assert.equal(display.getParticleCount(), 12);
  assert.deepEqual(flow.calls.slice(0, 3), ['attach', 'setField', 'start']);
  display.destroy();
  assert.deepEqual(engine.fake.imageryLayers(), []);
  assert.equal(flow.calls.at(-1), 'destroy');
});

test('on 3D tiles the field is raised at the wind’s shell height; none: a status', () => {
  const engine = createFakeEngine();
  let surface = 'tiles';
  engine.imagery.surface = () => surface;
  let changes = 0;
  const display = createWindDisplay(engine, {
    createCanvas: canvasOf,
    onStatusChange: () => changes++,
  });
  display.attach();
  display.setOptions({ overlay: 'speed' });
  display.setField(snapshot());
  const [id] = engine.fake.imageryLayers();
  assert.equal(engine.fake.imageryLayer(id).raise, WEATHER_SHELL_HEIGHTS.wind);
  assert.equal(display.getDiagnostics().host, 'shell');
  surface = 'none';
  engine.fake.emit('frames.preRender');
  assert.deepEqual(engine.fake.imageryLayers(), []);
  assert.match(display.getDiagnostics().imageryError, /Hidden by this map/);
  assert.equal(changes, 1);
  surface = 'globe';
  engine.fake.emit('frames.preRender');
  assert.equal(engine.fake.imageryLayers().length, 1);
  assert.equal(display.getDiagnostics().host, 'globe');
  assert.equal(display.getDiagnostics().imageryError, null);
});
