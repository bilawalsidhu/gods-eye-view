import assert from 'node:assert/strict';
import test from 'node:test';
import { createSpeedCameraSource } from './source.js';

const BOX = { south: -27.7, west: 152.8, north: -27.2, east: 153.3 };

function jsonResponse(elements, extra = {}) {
  return {
    ok: true,
    headers: { get: (name) => (name === 'x-overpass-cache' ? 'MISS' : null) },
    json: async () => ({ version: 0.6, elements, ...extra }),
  };
}

test('fetch resolves normalized, deduplicated camera records', async () => {
  const calls = [];
  const source = createSpeedCameraSource({
    fetchImpl: async (url, init) => {
      calls.push({ url, body: init.body });
      return jsonResponse([
        {
          type: 'node',
          id: 21475863,
          lat: -27.5973715,
          lon: 152.8353603,
          tags: { highway: 'speed_camera', maxspeed: '100' },
        },
        {
          type: 'node',
          id: 21475863,
          lat: -27.5973715,
          lon: 152.8353603,
          tags: { highway: 'speed_camera', maxspeed: '100' },
        },
        {
          type: 'node',
          id: 7,
          lat: -27.5,
          lon: 152.9,
          tags: { highway: 'surveillance' },
        },
      ]);
    },
  });
  const snapshot = await source.fetch(BOX, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/overpass');
  const query = decodeURIComponent(calls[0].body);
  assert.match(query, /node\["highway"="speed_camera"\]/);
  assert.match(query, /out body 1500;/);
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].id, 'speed-camera:21475863');
  assert.equal(snapshot.records[0].maxspeedKph, 100);
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.saturated, false);
});

test('fetch rejects unbounded and malformed boxes', async () => {
  const source = createSpeedCameraSource({
    fetchImpl: async () => {
      throw new Error('must not be called');
    },
  });
  await assert.rejects(source.fetch(null), TypeError);
  await assert.rejects(
    source.fetch({ south: -90, west: -180, north: 90, east: 180 }),
    TypeError,
  );
  await assert.rejects(
    source.fetch({ south: 'x', west: 0, north: 1, east: 2 }),
    TypeError,
  );
});

test('fetch maps HTTP failures to honest error states', async () => {
  for (const [status, message] of [
    [429, 'Overpass rate-limited'],
    [504, 'Overpass timed out'],
    [500, 'Overpass temporarily unavailable'],
  ]) {
    const source = createSpeedCameraSource({
      fetchImpl: async () => ({
        ok: false,
        status,
        body: { cancel: async () => {} },
      }),
    });
    await assert.rejects(source.fetch(BOX), { message });
  }
});

test('fetch rejects incomplete payloads instead of showing empty maps', async () => {
  const source = createSpeedCameraSource({
    fetchImpl: async () => jsonResponse([], { remark: 'runtime error: timed out' }),
  });
  await assert.rejects(
    source.fetch(BOX),
    { message: 'Overpass returned an incomplete camera response' },
  );
  const malformed = createSpeedCameraSource({
    fetchImpl: async () => jsonResponse(undefined),
  });
  await assert.rejects(
    malformed.fetch(BOX),
    { message: 'Overpass returned an incomplete camera response' },
  );
});

test('fetch reports saturation and stale provenance', async () => {
  const elements = Array.from({ length: 1500 }, (_, i) => ({
    type: 'node',
    id: 1000 + i,
    lat: -27.5 + i * 0.0001,
    lon: 152.9,
    tags: { highway: 'speed_camera' },
  }));
  const source = createSpeedCameraSource({
    fetchImpl: async () => ({
      ok: true,
      headers: { get: () => 'STALE' },
      json: async () => ({ version: 0.6, elements }),
    }),
  });
  const snapshot = await source.fetch(BOX, undefined);
  assert.equal(snapshot.saturated, true);
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.records.length, 1500);
});

test('fetch honors abort signals mid-flight', async () => {
  const controller = new AbortController();
  const source = createSpeedCameraSource({
    fetchImpl: (url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
  });
  const pending = source.fetch(BOX, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('source carries OpenStreetMap attribution', () => {
  const source = createSpeedCameraSource();
  assert.equal(source.attribution.text, '© OpenStreetMap contributors');
  assert.equal(source.label, 'OpenStreetMap · community mapped');
});
