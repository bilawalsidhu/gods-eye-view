import assert from 'node:assert/strict';
import test from 'node:test';
import { alongLength, lengthFraction } from './polyline.js';

const p = (x) => ({ x, y: 0, z: 0 });

test('alongLength finds where a fraction of a polyline’s length ends', () => {
  assert.deepEqual(alongLength([p(0), p(1), p(4)], 0.5), {
    index: 1,
    t: 1 / 3,
  });
  assert.deepEqual(alongLength([p(0), p(1), p(4)], 1), { index: 1, t: 1 });
  assert.deepEqual(alongLength([p(0), p(1), p(4)], 0.25), { index: 0, t: 1 });
});

test('alongLength has nothing to say without a length or a fraction in (0, 1]', () => {
  assert.equal(alongLength([p(0), p(1)], 0), null);
  assert.equal(alongLength([p(0), p(1)], 1.5), null);
  assert.equal(alongLength([p(0), p(0)], 0.5), null);
  assert.equal(alongLength([p(0)], 0.5), null);
});

test('lengthFraction is alongLength the other way round', () => {
  const line = [p(0), p(1), p(4)];
  assert.equal(lengthFraction(line, 1, 1 / 3), 0.5);
  assert.equal(lengthFraction(line, 0, 1), 0.25);
  assert.equal(lengthFraction(line, 1, 1), 1);
  assert.equal(lengthFraction(line, 0, 0), 0);
  assert.equal(lengthFraction([p(0), p(0)], 0, 0.5), 0);
});
