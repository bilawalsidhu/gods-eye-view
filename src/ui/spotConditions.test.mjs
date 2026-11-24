import assert from 'node:assert/strict';
import test from 'node:test';
import { hazardsNear } from './spotConditions.js';

test('a wildfire is placed at its card anchor, not its first ring', async (t) => {
  // Two polygons: the larger one, far from the first, carries the anchor.
  const square = (lon, lat, size) => [
    [
      [lon, lat],
      [lon + size, lat],
      [lon + size, lat + size],
      [lon, lat + size],
      [lon, lat],
    ],
  ];
  t.mock.method(globalThis, 'fetch', async (url) =>
    String(url) === '/api/fire-perimeters'
      ? Response.json({
          rows: [
            {
              stableId: 'fire',
              name: 'Fixture Fire',
              acres: 1200,
              containedPct: 30,
              updatedTime: Date.now() - 3600000,
              polygons: [square(-110, 35, 0.01), square(-108, 35, 0.2)],
            },
          ],
        })
      : new Response('down', { status: 503 }),
  );
  const near = await hazardsNear(35.1, -107.9, 30, { force: true });
  const fires = near.filter(({ kind }) => kind === 'wildfire');
  assert.equal(fires.length, 1);
  assert.equal(fires[0].title, 'Fixture Fire');
  assert.ok(fires[0].distanceKm < 5, `${fires[0].distanceKm} km`);
});
