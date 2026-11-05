import test from 'node:test';
import assert from 'node:assert/strict';
import { AIRCRAFT_ENVIRONMENT_MAP_OPTIONS } from './aircraftModelLighting.js';

test('the shared option turns the dynamic environment map off', () => {
  assert.deepEqual({ ...AIRCRAFT_ENVIRONMENT_MAP_OPTIONS }, { enabled: false });
  assert.ok(Object.isFrozen(AIRCRAFT_ENVIRONMENT_MAP_OPTIONS));
});
