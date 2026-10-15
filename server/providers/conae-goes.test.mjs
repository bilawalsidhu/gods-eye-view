import test from 'node:test';
import assert from 'node:assert/strict';
import { createConaeGoesSource } from './conae-goes.js';

const START = Date.parse('2026-10-15T04:00:00Z');
const payload = () => ({
  type: 'FeatureCollection', totalFeatures: 1,
  features: [{
    type: 'Feature', geometry: { type: 'Point', coordinates: [-60, -30] },
    properties: { 'Fecha_Local_UTC-3': '2026-10-15 00:50:00', Satelite: 'GOES19', Fire_Radiative_Power: 12 },
  }],
});

test('CONAE requests are fixed, bounded, coalesced and cached independently', async () => {
  let now = START, calls = 0, release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const source = createConaeGoesSource({
    now: () => now,
    fetchImpl: async (raw, options) => {
      calls++;
      const url = new URL(raw);
      assert.equal(url.origin, 'https://geoservicios.conae.gov.ar');
      assert.equal(url.pathname, '/geoserver/FocosDeCalor/wfs');
      assert.equal(url.searchParams.get('typeName'), 'FocosDeCalor:FocosGOES_24hs');
      assert.equal(url.searchParams.get('srsName'), 'EPSG:4326');
      assert.equal(url.searchParams.get('maxFeatures'), '50001');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      await blocked;
      return Response.json(payload());
    },
  });
  assert.equal(source.getStatus().fetchedAt, null);
  assert.equal(calls, 0);
  const requests = [source.getSnapshot(), source.getSnapshot()];
  release();
  const [a, b] = await Promise.all(requests);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  assert.equal(a.fires.length, 1);
  now += 9 * 60_000;
  assert.equal((await source.getSnapshot()).fetchedAt, START);
  assert.equal(calls, 1);
  now += 60_000;
  await source.getSnapshot();
  assert.equal(calls, 2);
});

test('failure backoff protects cold and stale caches, filtering expired observations', async () => {
  let now = START, calls = 0, fail = true;
  const source = createConaeGoesSource({
    now: () => now,
    fetchImpl: async () => {
      calls++;
      if (fail) throw new Error('offline');
      return Response.json(payload());
    },
  });
  await assert.rejects(source.getSnapshot(), /unavailable/);
  await assert.rejects(source.getSnapshot(), /unavailable/);
  assert.equal(calls, 1);
  now += 60_000;
  fail = false;
  await source.getSnapshot();
  fail = true;
  now += 10 * 60_000;
  const stale = await source.getSnapshot();
  assert.equal(stale.stale, true);
  assert.equal(stale.sources[0].ok, false);
  assert.equal(stale.fires.length, 1);
  await source.getSnapshot();
  assert.equal(calls, 3);
  now += 25 * 60 * 60_000;
  assert.equal((await source.getSnapshot()).fires.length, 0);
  assert.equal(source.getStatus().unavailable, true);
});

test('HTTP, invalid JSON, partial collections and oversized bodies cannot masquerade as empty data', async () => {
  for (const response of [
    new Response('offline', { status: 503 }),
    new Response('<ServiceException/>'),
    Response.json({ type: 'FeatureCollection', features: [], totalFeatures: 12 }),
    new Response('{}', { headers: { 'content-length': String(33 * 1024 * 1024) } }),
    new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(33 * 1024 * 1024));
        controller.close();
      },
    })),
  ]) {
    const source = createConaeGoesSource({ now: () => START, fetchImpl: async () => response });
    await assert.rejects(source.getSnapshot(), /unavailable/);
    assert.equal(source.getStatus().fetchedAt, null);
  }
  const source = createConaeGoesSource({ now: () => START, fetchImpl: async () => Response.json({ type: 'FeatureCollection', features: [] }) });
  assert.deepEqual((await source.getSnapshot()).fires, []);
  assert.equal(source.getStatus().unavailable, false);
});
