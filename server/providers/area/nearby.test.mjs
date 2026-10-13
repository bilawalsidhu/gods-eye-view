import test from 'node:test';
import assert from 'node:assert/strict';
import { createNearbySearch } from './nearby.js';

test('nearby acquisition reads only selected parameters, shares one actual service sample, and preserves failure', async () => {
  const hits = { air: 0, services: 0, housing: 0, seismic: 0 };
  const providers = Object.fromEntries(
    Object.keys(hits).map((metric) => [
      metric,
      async () => {
        hits[metric]++;
        return metric === 'services'
          ? { status: 'available', complete: true, pois: [] }
          : { status: 'unavailable', reason: 'Not covered' };
      },
    ]),
  );
  const result = await createNearbySearch(providers)(
    { lat: 0, lon: 0 },
    { metrics: ['air', 'services'], radius: 500 },
  );
  assert.equal(result.candidates.length, 9);
  assert.deepEqual(hits, { air: 9, services: 1, housing: 0, seismic: 0 });
  assert.ok(
    result.candidates.every(
      (row) => row.observations.air.status === 'unavailable',
    ),
  );
});
