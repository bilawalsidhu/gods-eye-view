import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCloudClient,
  validateSavedView,
  placeFromCloud,
  unwrap,
} from './cloud.js';
import {
  normalizeFacilities,
  fetchFacilities,
} from '../../../supabase/functions/import-durban/normalize.mjs';

test('cloud configuration rejects secret keys and unexpected hosts', () => {
  assert.equal(createCloudClient({}), null);
  for (const [url, key] of [
    ['https://example.com', 'sb_publishable_test'],
    ['https://example.supabase.co', 'sb_secret_test'],
  ])
    assert.throws(() =>
      createCloudClient({
        VITE_SUPABASE_URL: url,
        VITE_SUPABASE_PUBLISHABLE_KEY: key,
      }),
    );
});
test('saved cameras reject nonfinite, underground and out-of-range positions', () => {
  const view = {
    latitude: -29.85,
    longitude: 31.02,
    height: 18000,
    heading: 0,
    pitch: -Math.PI / 2,
    roll: 0,
  };
  assert.ok(validateSavedView(view));
  for (const patch of [
    { latitude: 91 },
    { longitude: Infinity },
    { height: 0 },
    { pitch: NaN },
    { roll: 8 },
  ])
    assert.ok(!validateSavedView({ ...view, ...patch }));
});
test('cloud records preserve provenance and distinguish unreviewed data', async () => {
  const place = placeFromCloud(
    {
      source_id: 'osm',
      source_url: 'https://www.openstreetmap.org/node/1',
      observed_at: '2000-01-01',
    },
    [
      {
        id: 'osm',
        name: 'OpenStreetMap',
        licence: 'ODbL',
        stale_after_days: 30,
      },
    ],
  );
  assert.equal(place.source, 'OpenStreetMap');
  assert.equal(place.licence, 'ODbL');
  assert.equal(place.reviewed, 'Not reviewed');
  assert.equal(place.stale, true);
  await assert.rejects(
    unwrap(Promise.resolve({ error: Error('denied') })),
    /denied/,
  );
});
test('facility imports reject incomplete responses and filter duplicates and out-of-area records', () => {
  const good = {
    type: 'node',
    id: 1,
    lat: -29.85,
    lon: 31.02,
    tags: { name: 'Sample clinic', amenity: 'clinic' },
  };
  const rows = normalizeFacilities({
    elements: [
      good,
      good,
      { ...good, id: 2, lat: 0 },
      { ...good, id: 3, tags: { name: 'Cafe', amenity: 'cafe' } },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, 'Health');
  assert.equal(rows[0].source_url, 'https://www.openstreetmap.org/node/1');
  assert.throws(() => normalizeFacilities({ elements: [], remark: 'timeout' }));
});
test('provider failures retry only three times with bounded backoff', async () => {
  let calls = 0;
  const delays = [];
  await assert.rejects(
    fetchFacilities(
      async () => {
        calls++;
        return { ok: false, status: 503 };
      },
      async (ms) => delays.push(ms),
    ),
    /503/,
  );
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1000, 2000]);
});
