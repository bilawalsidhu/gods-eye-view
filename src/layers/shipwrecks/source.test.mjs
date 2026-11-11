import test from 'node:test';
import assert from 'node:assert/strict';
import { createShipwrecksSource } from './source.js';

const respond = (payload) =>
  createShipwrecksSource({ fetchImpl: async () => Response.json(payload) });

test('the snapshot keeps valid source ages and drops malformed ones', async () => {
  const record = { id: 'a', source: 'emodnet', lat: 50, lon: -1 };
  const good = await respond({
    records: [record],
    version: 'v',
    ages: { emodnet: 0, wikidata: 3600 },
    maxAgeMs: 604800000,
  }).getSnapshot();
  assert.deepEqual(good.ages, { emodnet: 0, wikidata: 3600 });
  assert.equal(good.maxAgeMs, 604800000);
  assert.equal(good.version, 'v');
  const bad = await respond({
    records: [record],
    ages: { emodnet: -5, wikidata: 'x' },
    maxAgeMs: Number.NaN,
  }).getSnapshot();
  assert.deepEqual(bad.ages, { emodnet: null, wikidata: null });
  assert.equal(bad.maxAgeMs, null);
  assert.equal(bad.version, null);
});
