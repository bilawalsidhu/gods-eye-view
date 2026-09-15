import test from 'node:test';
import assert from 'node:assert/strict';
import { advectParticle, sampleWind, windColor } from './model.js';

const field = { u: Float32Array.from([1, 2, 3, 4]), v: Float32Array.from([5, 6, 7, 8]), nx: 2, ny: 2, lo1: 0, la1: 90, dx: 180, dy: 90 };

test('sampleWind interpolates, wraps, clamps, and rejects non-finite input', () => {
  assert.deepEqual(sampleWind(field, 0, 90), { u: 1, v: 5 });
  assert.deepEqual(sampleWind(field, 90, 45), { u: 2.5, v: 6.5 });
  assert.deepEqual(sampleWind(field, 359.99, 90), sampleWind(field, -0.01, 90));
  assert.deepEqual(sampleWind(field, 0, 100), { u: 1, v: 5 });
  assert.deepEqual(sampleWind(field, Infinity, 0), { u: 0, v: 0 });
});

test('advectParticle moves and constrains particles', () => {
  const particle = { lon: 179, lat: 88 };
  advectParticle(particle, { u: 10, v: 100 }, 3600);
  assert.ok(particle.lon < 0);
  assert.equal(particle.lat, 89);
});

test('windColor returns a monotonic ramp string', () => {
  assert.equal(typeof windColor(0), 'string');
  assert.notEqual(windColor(0), windColor(30));
});
