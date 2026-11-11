// The wind display on the fake and headless Cesium engines: its field as one imagery image,
// faded with the camera while streamlines draw, raised on 3D tiles; the
// flow is the backend's.
import assert from 'node:assert/strict';
import * as geo from '../../../geo/index.js';
import { imageryDisplayTests } from '../../../testSupport/imageryDisplayEngines.mjs';
const { test, createEngine } = imageryDisplayTests();
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
  const engine = createEngine();
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
  const engine = createEngine();
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

// A display whose field layer counts its alpha writes, over a flow stub that
// draws streamlines (`flowing`) or the canvas fallback.
function fieldHarness({ flowing = true, surface = null } = {}) {
  const engine = createEngine();
  if (surface) engine.imagery.surface = () => surface.value;
  const create = engine.imagery.createLayer.bind(engine.imagery);
  const counts = { writes: 0, canvases: 0 };
  engine.imagery.createLayer = (options) => {
    const layer = create(options);
    return {
      ...layer,
      setAlpha(value) {
        counts.writes++;
        layer.setAlpha(value);
      },
    };
  };
  const flow = flowStub();
  flow.getDiagnostics = () => ({
    renderMode: flowing ? 'gpu-streamlines' : 'canvas-fallback',
  });
  const display = createWindDisplay(engine, {
    flow: () => flow,
    createCanvas: (raster) => {
      counts.canvases++;
      return canvasOf(raster);
    },
  });
  const field = () => {
    const [id] = engine.fake.imageryLayers();
    return id ? engine.fake.imageryLayer(id) : undefined;
  };
  return { engine, display, flow, counts, field };
}
const withScalar = (kind, value) => ({
  ...snapshot(),
  scalar: {
    kind,
    units: kind === 'pressure' ? 'hPa' : '°C',
    values: new Float32Array(40).fill(value),
  },
});
const MIDPOINT = Math.sqrt(200_000 * 1_200_000);

test('the field builds once, survives frames and pause, replaces cleanly and releases on clear', () => {
  const { engine, display, counts, field } = fieldHarness();
  display.attach();
  display.setOptions({ overlay: 'speed' });
  display.setField(snapshot());
  display.start();
  assert.equal(engine.fake.imageryLayers().length, 1);
  assert.equal(counts.canvases, 1);
  assert.equal(field().source.image.width, 360);
  assert.equal(field().source.image.height, 181);
  engine.fake.frames(3);
  assert.equal(counts.canvases, 1, 'no texture generation from frames');
  display.setOptions({ paused: true });
  assert.equal(engine.fake.imageryLayers().length, 1);
  display.setOptions({ overlay: 'temperature' });
  assert.deepEqual(
    engine.fake.imageryLayers(),
    [],
    'unavailable scalar cannot display the previous field',
  );
  assert.match(display.getDiagnostics().imageryError, /unavailable/);
  display.setField(withScalar('temperature', 20));
  assert.equal(engine.fake.imageryLayers().length, 1);
  assert.equal(display.getDiagnostics().imageryError, null);
  display.clear();
  assert.deepEqual(engine.fake.imageryLayers(), []);
  display.destroy();
});

for (const overlay of ['speed', 'pressure', 'temperature']) {
  test(`${overlay} field fades with log camera height, skips small changes and follows height while paused`, () => {
    const { engine, display, counts, field } = fieldHarness();
    const base = overlay === 'temperature' ? 1 : 0.85;
    display.attach();
    display.setOptions({ overlay });
    display.setField(
      overlay === 'speed'
        ? snapshot()
        : withScalar(overlay, overlay === 'pressure' ? 1013 : 20),
    );
    display.start();
    at(engine, 17_368_000);
    assert.equal(field().alpha, base);
    assert.equal(field().shown, true);
    const writes = counts.writes;
    at(engine, 17_368_000);
    assert.equal(counts.writes, writes, 'unchanged height never writes alpha');
    at(engine, MIDPOINT);
    assert.ok(Math.abs(field().alpha - base / 2) < 1e-6, 'log midpoint');
    const midpoint = counts.writes;
    at(engine, MIDPOINT * 1.001);
    assert.equal(counts.writes, midpoint, 'sub-0.005 changes are skipped');
    at(engine, MIDPOINT * 1.03);
    assert.equal(counts.writes, midpoint + 1, 'larger changes write alpha');
    at(engine, 100_000);
    assert.equal(field().alpha, 0);
    assert.equal(field().shown, false);
    display.setOptions({ paused: true });
    at(engine, 1_200_000);
    assert.equal(field().alpha, base, 'a paused field still follows height');
    assert.equal(field().shown, true);
    assert.equal(counts.canvases, 1, 'height changes never rebuild it');
    display.destroy();
  });
}

test('without streamlines the field keeps its base alpha low down', () => {
  const { engine, display, field } = fieldHarness({ flowing: false });
  display.attach();
  display.setOptions({ overlay: 'speed' });
  display.setField(snapshot());
  at(engine, 1_200);
  assert.equal(field().alpha, 0.85);
  assert.equal(field().shown, true);
  display.destroy();
});

for (const overlay of ['speed', 'temperature']) {
  test(`${overlay} raised field fades in 0.1 steps; without streamlines it shows at street level`, () => {
    const surface = { value: 'tiles' };
    const base = overlay === 'temperature' ? 1 : 0.85;
    const field = overlay === 'speed' ? snapshot() : withScalar(overlay, 20);
    const h = fieldHarness({ surface });
    h.display.attach();
    h.display.setOptions({ overlay });
    h.display.setField(field);
    at(h.engine, MIDPOINT);
    assert.equal(h.field().raise, WEATHER_SHELL_HEIGHTS.wind);
    assert.equal(h.field().alpha, overlay === 'temperature' ? 0.5 : 0.4);
    const writes = h.counts.writes;
    at(h.engine, MIDPOINT * 1.01);
    assert.equal(h.counts.writes, writes, 'the same step writes nothing');
    at(h.engine, 100_000);
    assert.equal(h.field().alpha, 0);
    assert.equal(h.field().shown, false);
    at(h.engine, 1_200_000);
    assert.equal(h.field().alpha, overlay === 'temperature' ? 1 : 0.9);
    // Back on the globe: the smooth fade.
    surface.value = 'globe';
    at(h.engine, 1_200_000);
    assert.equal(h.field().raise, null);
    assert.equal(h.field().alpha, base);
    h.display.destroy();

    const fallback = fieldHarness({
      flowing: false,
      surface: { value: 'tiles' },
    });
    fallback.display.attach();
    fallback.display.setOptions({ overlay });
    fallback.display.setField(field);
    at(fallback.engine, 1_200);
    assert.equal(fallback.field().shown, true, 'no height gate on 3D tiles');
    assert.equal(fallback.field().alpha, Math.round(base * 10) / 10);
    at(fallback.engine, 1_500);
    assert.equal(fallback.counts.canvases, 1, 'camera changes keep the field');
    fallback.display.destroy();
  });
}

test('a field installed with no imagery surface reports hidden and installs on restore', () => {
  const surface = { value: 'none' };
  const { engine, display, counts } = fieldHarness({ surface });
  display.attach();
  display.setOptions({ overlay: 'speed' });
  display.setField(snapshot());
  assert.deepEqual(engine.fake.imageryLayers(), []);
  assert.equal(counts.canvases, 0);
  assert.equal(
    display.getDiagnostics().imageryError,
    'Hidden by this map source · choose a globe map',
  );
  surface.value = 'globe';
  display.rehome();
  assert.equal(engine.fake.imageryLayers().length, 1);
  assert.equal(display.getDiagnostics().imageryError, null);
  display.destroy();
});
