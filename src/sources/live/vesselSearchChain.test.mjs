import test from 'node:test';
import assert from 'node:assert/strict';
import { createAisStreamSource } from './standalone.js';

const ARCHIVED_PAYLOAD = {
  query: 'OI MARU',
  matches: [],
  archived: [
    { mmsi: '636018600', name: 'OI MARU', imo: '9749922', archived: true,
      lat: -28.2769, lon: 153.8037, lastFixEpoch: 1789812000 },
  ],
  searched: 'server cache + history',
};

function source(payload) {
  return createAisStreamSource({
    fetchImpl: async () =>
      new Response(JSON.stringify(payload), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    origin: () => 'http://localhost:4173',
  });
}

test('archived-only search results reach the client', async () => {
  const out = await source(ARCHIVED_PAYLOAD).searchVessels('OI MARU');
  assert.equal(out.length, 1, 'dropping these sends a real ship name to the geocoder');
  assert.equal(out[0].name, 'OI MARU');
  assert.equal(out[0].archived, true);
});

test('live matches rank ahead of archived ones', async () => {
  const out = await source({
    matches: [{ mmsi: '1', name: 'LIVE SHIP', lat: 1, lon: 2 }],
    archived: [{ mmsi: '2', name: 'OLD SHIP', archived: true, lat: 3, lon: 4 }],
  }).searchVessels('SHIP');
  assert.equal(out[0].name, 'LIVE SHIP');
  assert.equal(out.length, 2);
});

test('a short query never reaches the network', async () => {
  let called = false;
  const src = createAisStreamSource({
    fetchImpl: async () => { called = true; return new Response('{}'); },
    origin: () => 'http://localhost:4173',
  });
  assert.deepEqual(await src.searchVessels('a'), []);
  assert.equal(called, false);
});
