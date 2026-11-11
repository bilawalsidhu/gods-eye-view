import assert from 'node:assert/strict';
import test from 'node:test';
import { localAdsbQaDrawn } from './qaDrawn.js';
function setup() {
  const marker = {
    id: 'local-adsb:abc123',
    record: { icao: 'abc123' },
    position: { x: 6378137, y: 2, z: 3 },
    lastRotation: 0.7,
    modelOwnsVisual: false,
  };
  Object.defineProperty(marker, 'entity', {
    get() {
      throw new Error('A snapshot must not evaluate native callbacks');
    },
  });
  const matrix = new Float64Array(16);
  matrix[12] = 6378138;
  matrix[13] = 4;
  matrix[14] = 5;
  const model = {
    ready: true,
    show: true,
    computedScale: 12,
    modelMatrix: matrix,
  };
  const markers = new Map([[marker.id, marker]]),
    models = new Map([[marker.id, model]]);
  const options = {
    enabled: true,
    cameraPosition: { x: 6379137, y: 2, z: 3 },
    isVisible: () => true,
  };
  return { marker, matrix, markers, models, options };
}
test('local QA copies the drawn model and reads cached glyph rotation without callbacks', () => {
  const f = setup();
  const [row] = localAdsbQaDrawn(f.markers, f.models, f.options);
  assert.equal(row.id, 'abc123');
  assert.equal(row.rotation, 0.7);
  assert.equal(row.alpha, 1);
  assert.equal(row.model.computedScale, 12);
  assert.equal(row.model.ready, true);
  row.position.x = 0;
  row.model.matrix[12] = 0;
  row.model.position.x = 0;
  assert.equal(f.marker.position.x, 6378137);
  assert.equal(f.matrix[12], 6378138);
});
test('local QA respects disabled, horizon, model handoff and the two-million-metre glyph limit', () => {
  for (const change of [
    (f) => {
      f.options.enabled = false;
    },
    (f) => {
      f.options.isVisible = () => false;
    },
    (f) => {
      f.marker.modelOwnsVisual = true;
    },
    (f) => {
      f.options.cameraPosition.x += 2_000_000;
    },
  ]) {
    const f = setup();
    change(f);
    const [row] = localAdsbQaDrawn(f.markers, f.models, f.options);
    assert.equal(row.show, false);
    assert.equal(row.alpha, 0);
    assert.equal(row.model.ready, true);
  }
});
