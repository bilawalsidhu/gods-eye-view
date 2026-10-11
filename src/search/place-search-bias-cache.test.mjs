import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaceSearch } from './placeSearch.js';
test('different geographic bounds cannot share a cached place', async () => {
  let calls = 0;
  const service = createPlaceSearch({
    providers: [
      {
        async geocode(query, { bias }) {
          calls++;
          return {
            place: { name: `${query}:${bias.west}`, lat: 0, lng: bias.west },
            answered: true,
          };
        },
      },
    ],
  });
  const west = { west: -120, east: -100, north: 45, south: 30 };
  const east = { west: -80, east: -60, north: 45, south: 30 };
  assert.equal(
    (await service.geocode('Springfield', { bias: west })).place.lng,
    -120,
  );
  assert.equal(
    (await service.geocode('Springfield', { bias: east })).place.lng,
    -80,
  );
  assert.equal(
    (await service.geocode('springfield', { bias: { ...west } })).place.lng,
    -120,
  );
  assert.equal(calls, 2);
});
