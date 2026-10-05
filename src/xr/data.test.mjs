import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpatialData, feedLabel } from './data.js';

const row = { id: 'one', lat: 45, lon: -90, layer: 'earthquakes' };
const settled = () => new Promise(resolve => setImmediate(resolve));
test('failed refresh retains the last valid snapshot with an explicit stale label', async () => {
  let fail = false;
  const data = createSpatialData({ loaders: { earthquakes: async () => { if (fail) throw new Error('Offline'); return { records: [row], source: 'USGS' }; } } });
  data.toggle('earthquakes'); await settled();
  assert.equal(data.states.earthquakes.status, 'current'); fail = true;
  await data.refresh('earthquakes');
  assert.equal(data.states.earthquakes.status, 'stale'); assert.deepEqual(data.states.earthquakes.records, [row]);
  assert.match(feedLabel(data.states.earthquakes), /Last snapshot.*Offline/); data.destroy();
});
test('disabled and destroyed layers ignore late responses from non-abortable loaders', async () => {
  const resolvers = [];
  const data = createSpatialData({ loaders: { earthquakes: () => new Promise(resolve => resolvers.push(resolve)) } });
  data.toggle('earthquakes'); data.toggle('earthquakes'); data.toggle('earthquakes');
  resolvers[0]({ records: [{ ...row, id: 'old' }] }); await settled();
  assert.equal(data.states.earthquakes.records.length, 0);
  resolvers[1]({ records: [row] }); await settled(); assert.deepEqual(data.states.earthquakes.records, [row]);
  void data.refresh('earthquakes'); data.destroy(); resolvers[2]({ records: [] }); await settled();
  assert.deepEqual(data.states.earthquakes.records, [row]);
});
test('failed providers are retried at their polling interval rather than every tick', async () => {
  let now = 1000, calls = 0;
  const data = createSpatialData({ now: () => now, loaders: { earthquakes: async () => { calls++; throw new Error('Unavailable'); } } });
  data.toggle('earthquakes'); await settled();
  now += 5000; data.tick(); await settled(); assert.equal(calls, 1);
  now += 120000; data.tick(); await settled(); assert.equal(calls, 2); data.destroy();
});
