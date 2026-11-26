import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindLayer } from './index.js';

const rendering = () =>
  Object.fromEntries(
    [
      'attach',
      'start',
      'stop',
      'clear',
      'destroy',
      'setField',
      'setOptions',
      'getDiagnostics',
    ].map((name) => [name, () => undefined]),
  );

test('getValueAt reads the loaded field at a point, null while off or empty', async () => {
  const field = {
    model: 'gfs',
    // A uniform 10 m/s wind blowing from the north.
    grid: { nx: 4, ny: 3, lo1: 0, la1: 90, dx: 90, dy: 90 },
    u: new Float32Array(12).fill(0),
    v: new Float32Array(12).fill(-10),
    cycle: { runIso: '2026-09-14T12:00:00Z', validIso: '2026-09-14T18:00:00Z' },
  };
  const layer = createWindLayer({
    feed: { getSnapshot: async () => field },
    createRendering: rendering,
  });
  layer.init({ container: {} });
  assert.equal(layer.getValueAt(30, -97), null, 'off');
  layer.enable();
  assert.equal(layer.getValueAt(30, -97), null, 'nothing loaded');
  await layer.update();
  const reading = layer.getValueAt(30.27, -97.74);
  assert.match(reading.value, /^36[.,]0\s?km\/h from N$/);
  assert.equal(reading.at, Date.parse('2026-09-14T18:00:00Z'));
  assert.match(reading.detail, /GFS forecast · 2026-09-14 18:00 UTC/);
  assert.equal(layer.getValueAt(Number.NaN, 0), null);
  layer.setParams({ units: 'm/s' });
  assert.match(layer.getValueAt(30.27, -97.74).value, /^10[.,]0\s?m\/s/);
  layer.disable();
  assert.equal(layer.getValueAt(30.27, -97.74), null);
  layer.destroy();
});

test('getValueAt says calm under a still field and null when unavailable', async () => {
  let snapshot = {
    grid: { nx: 2, ny: 2, lo1: 0, la1: 90, dx: 180, dy: 180 },
    u: new Float32Array(4),
    v: new Float32Array(4),
    cycle: {},
  };
  const layer = createWindLayer({
    feed: { getSnapshot: async () => snapshot },
    createRendering: rendering,
  });
  layer.init({ container: {} });
  layer.enable();
  await layer.update();
  const calm = layer.getValueAt(0, 0);
  assert.match(calm.value, /· calm$/);
  assert.equal('at' in calm, false);
  snapshot = { unavailable: true, reason: 'Wind upstream unavailable' };
  await layer.update();
  assert.equal(layer.getValueAt(0, 0), null);
  layer.destroy();
});
