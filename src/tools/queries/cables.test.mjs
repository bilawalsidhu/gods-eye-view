import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog, coreTools } from '../index.js';
import { createApiFetch } from '../../../server/mcp/services.js';
import { createBundledCableSource } from '../../layers/submarineCables/bundledSource.js';

const cables = {
  async fetch() {
    return {
      cables: {
        features: [
          {
            properties: { id: 'marea', name: 'MAREA' },
            geometry: {
              type: 'MultiLineString',
              coordinates: [
                [
                  [-76, 36.8],
                  [-40, 40],
                  [-2.9, 43.4],
                ],
              ],
            },
          },
          {
            properties: { id: 'unity', name: 'Unity' },
            geometry: {
              type: 'LineString',
              coordinates: [
                [-118, 34],
                [139, 35],
              ],
            },
          },
        ],
      },
      landingPoints: {
        features: [
          {
            properties: { id: 'vb', name: 'Virginia Beach, VA, United States' },
            geometry: { type: 'Point', coordinates: [-75.98, 36.85] },
          },
          {
            properties: { id: 'bilbao', name: 'Bilbao, Spain' },
            geometry: { type: 'Point', coordinates: [-2.93, 43.26] },
          },
        ],
      },
    };
  },
};

test('cables are found by area and name, with landing points and attribution', async () => {
  const catalog = composeCatalog({ tools: coreTools, services: { cables } });
  const virginia = await catalog.call('find_submarine_cables', {
    area: { lat: 36.85, lon: -75.98, radius_km: 50 },
  });
  assert.equal(
    virginia.summary,
    '1 submarine cable in 50 km around 36.850, -75.980, with 1 landing point.',
  );
  assert.deepEqual(virginia.data.rows, [{ id: 'marea', name: 'MAREA' }]);
  assert.equal(
    virginia.data.landing_points.rows[0].name,
    'Virginia Beach, VA, United States',
  );
  assert.match(virginia.data.attribution, /TeleGeography.*CC BY-NC-SA 3\.0/);
  const named = await catalog.call('find_submarine_cables', { name: 'uni' });
  assert.equal(named.summary, '1 submarine cable matching "uni".');
  assert.equal(named.data.landing_points, null);
  await assert.rejects(
    catalog.call('find_submarine_cables', {}),
    /area, a name or both/,
  );
  // Areas a cable crosses between vertices, including at the antimeridian.
  const atlantic = await catalog.call('find_submarine_cables', {
    area: { bbox: [-30, 40, -20, 43] },
  });
  assert.deepEqual(
    atlantic.data.rows.map((row) => row.id),
    ['marea'],
  );
  const pacific = await catalog.call('find_submarine_cables', {
    area: { bbox: [179, 34, -179, 35.5] },
  });
  assert.deepEqual(
    pacific.data.rows.map((row) => row.id),
    ['unity'],
  );
});

test('the local fetch serves bundled data files and nothing outside them', async () => {
  const fetchImpl = createApiFetch({
    apiBase: 'http://127.0.0.1:1',
    fetchImpl: async () => assert.fail('no network'),
  });
  const { cables: collection, landingPoints } = await createBundledCableSource({
    fetchImpl,
  }).fetch();
  assert.ok(collection.features.length > 500);
  assert.ok(landingPoints.features.length > 1000);
  const outside = await fetchImpl(
    new URL('../../../package.json', import.meta.url).href,
  );
  assert.equal(outside.status, 404);
  const missing = await fetchImpl(
    new URL('../../data/local_data/missing.json', import.meta.url).href,
  );
  assert.equal(missing.status, 404);
});
