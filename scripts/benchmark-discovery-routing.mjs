import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { starterPack } from '../src/discovery/starterPack.js';
import { searchDiscovery } from '../src/discovery/model.js';
import {
  createDiscoveryLookup,
  routingFeatures,
  proposeDiscoveryRoute,
} from '../src/discovery/routing.js';

// Authored public-library fixtures. This is not a corpus of user searches.
const fixtures = [
  ['english-name', { query: 'Eiffel' }, ['Q243']],
  ['accent-alias', { query: 'Colisee' }, ['Q10285']],
  ['aircraft-family', { query: 'A320' }, ['Q6475']],
  ['aircraft-family-737', { query: 'Boeing 737' }, ['Q6387']],
  ['exact-source-id', { query: 'Q243' }, ['Q243']],
  [
    'earth-proximity',
    { center: { lat: 48.8583, lon: 2.2945 }, radiusKm: 1 },
    ['Q243'],
  ],
  ['moon-name', { body: 'moon', query: 'Tycho' }, ['Q631696']],
  ['mars-name', { body: 'mars', query: 'Olympus' }, ['Q520']],
  ['moon-mission', { body: 'moon', query: 'Tranquillitatis' }, ['Q732758']],
  ['missing-name', { query: 'authored-missing-example' }, []],
  ['wrong-body', { body: 'moon', query: 'Eiffel' }, []],
  ['mars-browse', { body: 'mars' }, ['Q520', 'Q621110']],
];
const sortedIds = (rows) => rows.map((row) => row.card.id).sort();
const median = (samples) =>
  samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)];
const time = (call, count = 200, prepare = () => {}) => {
  const samples = [];
  for (let i = 0; i < 30; i++) {
    prepare();
    call(i);
  }
  for (let i = 0; i < count; i++) {
    prepare();
    const start = performance.now();
    call(i);
    samples.push(performance.now() - start);
  }
  return median(samples);
};
const setupStart = performance.now();
const lookup = createDiscoveryLookup(starterPack);
const setupMs = performance.now() - setupStart;
const rows = [],
  requests = [];
for (const [name, scope, expected] of fixtures) {
  const baseline = searchDiscovery(starterPack.cards, scope);
  const indexed = lookup.lookup(scope, { observe: true });
  assert.deepEqual(
    sortedIds(baseline),
    [...expected].sort(),
    `${name}: reference expected IDs`,
  );
  assert.deepEqual(
    sortedIds(indexed.rows),
    [...expected].sort(),
    `${name}: indexed expected IDs`,
  );
  assert.deepEqual(
    indexed.rows,
    baseline,
    `${name}: reference order/distances`,
  );
  const referenceMedianMs = time(() =>
    searchDiscovery(starterPack.cards, scope),
  );
  const coldEngine = createDiscoveryLookup(starterPack, { maxCacheEntries: 1 });
  const coldMedianMs = time(
    () => coldEngine.lookup(scope),
    200,
    () => coldEngine.lookup({ query: 'cache-eviction-fixture' }),
  );
  const cachedMedianMs = time(() => lookup.lookup(scope));
  const features = routingFeatures(indexed.trace);
  rows.push({
    name,
    expectedIds: expected,
    passed: true,
    referenceMedianMs,
    coldMedianMs,
    cachedMedianMs,
    proposal: proposeDiscoveryRoute(features),
    apiCalls: 0,
    modelCalls: 0,
  });
  requests.push({ features });
}
const report = {
  format: 'gods-eye-view/discovery-routing-benchmark',
  version: 1,
  dataOrigin: 'authored_public_fixtures',
  policy: 'local-discovery/1',
  node: process.version,
  catalogCards: starterPack.cards.length,
  catalogSha256: createHash('sha256')
    .update(JSON.stringify(starterPack))
    .digest('hex'),
  fixtureCount: fixtures.length,
  passed: rows.length,
  setupMs,
  apiCalls: 0,
  modelCalls: 0,
  billedCostUSD: null,
  rows,
  limitations:
    'Lookup-only local CPU timing, 15 cards, 30 warmup and 200 measured samples per fixture. Cold cache eviction occurs outside the timed section; setup is separate. No DOM, production searches, model inference, calibration or monetary-savings measurement.',
};
const args = process.argv.slice(2);
if (args.length > 2)
  throw new Error(
    'Usage: benchmark-discovery-routing.mjs [report.json] [bridge-requests.json]',
  );
if (args[0]) await writeFile(args[0], JSON.stringify(report, null, 2) + '\n');
if (args[1])
  await writeFile(
    args[1],
    JSON.stringify(
      {
        format: 'gods-eye-view/parcimonia-discovery-requests',
        version: 1,
        dataOrigin: 'authored_public_fixtures',
        requests,
      },
      null,
      2,
    ) + '\n',
  );
console.log(JSON.stringify(report, null, 2));
