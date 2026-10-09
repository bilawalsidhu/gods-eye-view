import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALPINE_RESPONSE_LIMIT,
  createAlpineStationSource,
  readAlpineSnapshot,
} from './source.js';
import { SLF_NETWORK_ID, SMN_NETWORK_ID } from './networks.js';

const station = (overrides = {}) => ({
  networkId: SLF_NETWORK_ID,
  code: 'DAV2',
  label: 'Bärentälli',
  lat: 46.6988,
  lon: 9.8194,
  elevationM: 2558,
  region: 'GR',
  measuredAt: '2026-10-09T11:50:00.000Z',
  snowDepthCm: 42,
  ...overrides,
});

const networkState = (overrides = {}) => ({
  id: SLF_NETWORK_ID,
  label: 'SLF IMIS',
  name: 'WSL',
  country: 'CH',
  attribution: 'WSL',
  licence: 'CC BY 4.0',
  licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
  homepage: 'https://www.slf.ch/',
  parameters: ['snow'],
  cadenceMinutes: 30,
  status: 'ok',
  fetchedAt: '2026-10-09T11:55:00.000Z',
  stationCount: 1,
  ...overrides,
});

const envelope = (overrides = {}) => ({
  schemaVersion: 1,
  stations: [station()],
  networks: [networkState()],
  attribution: 'WSL (CC BY 4.0)',
  fetchedAt: '2026-10-09T11:55:00.000Z',
  stale: false,
  unavailable: false,
  reason: null,
  ...overrides,
});

function respond(payload, { ok = true, status = 200 } = {}) {
  const body = JSON.stringify(payload);
  return {
    ok,
    status,
    headers: { get: () => String(body.length) },
    async text() {
      return body;
    },
    async json() {
      return JSON.parse(body);
    },
    body: null,
  };
}

test('the envelope is normalized and the records re-validated', () => {
  const snapshot = readAlpineSnapshot(envelope());
  assert.equal(snapshot.stations.length, 1);
  assert.equal(snapshot.stations[0].id, `${SLF_NETWORK_ID}:DAV2`);
  assert.equal(snapshot.networks[0].status, 'ok');
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.unavailable, false);
  assert.match(snapshot.attribution, /CC BY 4\.0/);
});

test('an individually unusable station is dropped, not fatal', () => {
  // The browser must not be the only gate, but one bad record must never blank
  // the layer: a failed first update makes the lifecycle disable it.
  const snapshot = readAlpineSnapshot(
    envelope({
      stations: [
        station(),
        station({ code: 'BAD', lat: null }),
        station({ code: 'WORSE', networkId: 'invented' }),
        null,
      ],
    }),
  );
  assert.deepEqual(
    snapshot.stations.map((entry) => entry.code),
    ['DAV2'],
  );
});

test('only a payload that is not an envelope is rejected outright', () => {
  for (const payload of [
    null,
    'text',
    42,
    {},
    { stations: [] },
    { networks: [] },
    { stations: 'no', networks: [] },
    { stations: [], networks: 'no' },
  ])
    assert.throws(
      () => readAlpineSnapshot(payload),
      /Malformed Alpine station snapshot/,
      JSON.stringify(payload),
    );
});

test('an unknown network id or status is refused', () => {
  // These are the fields the card and the attribution read, so a value outside
  // the contract must not reach them.
  assert.throws(
    () => readAlpineSnapshot(envelope({ networks: [networkState({ id: 'nope' })] })),
    /Malformed/,
  );
  assert.throws(
    () => readAlpineSnapshot(envelope({ networks: [networkState({ status: 'fine' })] })),
    /Malformed/,
  );
  assert.throws(
    () => readAlpineSnapshot(envelope({ networks: [null] })),
    /Malformed/,
  );
  for (const status of ['ok', 'stale', 'unavailable'])
    assert.equal(
      readAlpineSnapshot(envelope({ networks: [networkState({ status })] }))
        .networks[0].status,
      status,
    );
});

test('missing optional envelope fields take safe defaults', () => {
  const snapshot = readAlpineSnapshot({
    stations: [],
    networks: [networkState({ label: 7, parameters: 'no', fetchedAt: 0 })],
  });
  assert.equal(snapshot.attribution, '');
  assert.equal(snapshot.fetchedAt, null);
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.unavailable, false);
  assert.equal(snapshot.reason, null);
  assert.equal(snapshot.networks[0].label, SLF_NETWORK_ID);
  assert.deepEqual(snapshot.networks[0].parameters, []);
  assert.equal(snapshot.networks[0].fetchedAt, null);
});

test('the source reads the same-origin route and honours an abort', async () => {
  const calls = [];
  const source = createAlpineStationSource({
    fetchImpl: (url, options) => {
      calls.push({ url, signal: options?.signal });
      return respond(envelope());
    },
  });
  const snapshot = await source.getSnapshot();
  assert.deepEqual(
    calls.map(({ url }) => url),
    ['/api/alpine-stations'],
  );
  assert.equal(snapshot.stations.length, 1);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => source.getSnapshot({ signal: controller.signal }));
  assert.equal(calls.length, 1, 'an aborted request never reaches the network');
});

test('a non-200 reply reports its status without relaying a body', async () => {
  const source = createAlpineStationSource({
    fetchImpl: () => respond({ error: 'upstream said something' }, { ok: false, status: 502 }),
  });
  await assert.rejects(() => source.getSnapshot(), /Alpine stations HTTP 502/);
});

test('an oversized body is refused rather than parsed', async () => {
  const source = createAlpineStationSource({
    fetchImpl: () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(ALPINE_RESPONSE_LIMIT + 1) },
      body: { cancel: async () => {} },
      async text() {
        throw new Error('must not read an oversized body');
      },
    }),
  });
  await assert.rejects(() => source.getSnapshot());
});

test('a multi-network envelope keeps every network it was given', () => {
  const snapshot = readAlpineSnapshot(
    envelope({
      stations: [station(), station({ networkId: SMN_NETWORK_ID, code: 'ZER' })],
      networks: [
        networkState(),
        networkState({ id: SMN_NETWORK_ID, status: 'unavailable', fetchedAt: null }),
      ],
      stale: true,
      reason: '1 of 2 networks unavailable',
    }),
  );
  assert.equal(snapshot.stations.length, 2);
  assert.deepEqual(
    snapshot.networks.map((network) => network.status),
    ['ok', 'unavailable'],
  );
  assert.equal(snapshot.stale, true);
  assert.match(snapshot.reason, /unavailable/);
});
