import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaceSearch, createGoogleGeocoder, createPhotonGeocoder } from './index.js';
import { createStandalonePlaceSearch } from '../standalone/placeSearch.js';
import { photonExtentToBounds } from '../keylessGeocoder.js';
const feature = { geometry: { type: 'Point', coordinates: [105.85, 21.03] }, properties: { name: 'Hà Nội', type: 'city' } };
const hit = () => Response.json({ features: [feature] });

test('malformed successful Photon responses remain retryable', async () => {
  for (const malformed of [{ error: 'temporary failure' }, { features: {} }, { features: [{ geometry: { coordinates: [null, 1] } }] }]) {
    let calls = 0;
    const provider = createPhotonGeocoder({ fetchImpl: async () => ++calls === 1 ? Response.json(malformed) : hit() });
    assert.deepEqual(await provider.geocode('Hanoi'), { place: null, answered: false });
    assert.equal((await provider.geocode('Hanoi')).place.name, 'Hà Nội');
    assert.equal(calls, 2);
  }
});

test('standalone geocoding falls back after Google connection, JSON and refusal failures', async () => {
  for (const fail of [() => { throw new Error('offline'); }, () => new Response('invalid json'), () => Response.json({ status: 'REQUEST_DENIED' })]) {
    const urls = [];
    const service = createStandalonePlaceSearch({ resolveApiKey: () => 'fixture', fetchImpl: async (url) => {
      urls.push(url); return url.includes('maps.googleapis.com') ? fail() : hit();
    } });
    const result = await service.geocode('Hanoi');
    assert.equal(result.place.name, 'Hà Nội');
    assert.equal(result.fallbackUsed, true);
    assert.equal(urls.length, 2);
  }
});

test('a keyless service does not issue any Google request', async () => {
  const service = createStandalonePlaceSearch({ fetchImpl: async (url) => {
    assert.equal(new URL(url).hostname, 'photon.komoot.io'); return hit();
  } });
  assert.equal((await service.geocode('Hanoi')).place.lat, 21.03);
});

test('cancellation before lookup makes no request', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const provider = createPhotonGeocoder({ fetchImpl: async () => { calls++; return hit(); } });
  await assert.rejects(provider.geocode('Hanoi', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('cancellation stops Photon retries and does not cache a late response', async () => {
  const controller = new AbortController();
  let calls = 0;
  const provider = createPhotonGeocoder({ fetchImpl: async () => {
    calls++; if (calls === 1) controller.abort(); return hit();
  } });
  await assert.rejects(provider.geocode('Hanoi', { bias: '1,1|2,2', signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
  assert.equal((await provider.geocode('Hanoi')).place.name, 'Hà Nội');
  assert.equal(calls, 2);
});

test('a Google request cancelled by its caller never starts the fallback', async () => {
  const controller = new AbortController(); let fallbackCalls = 0;
  const service = createPlaceSearch({ providers: [
    createGoogleGeocoder({ request: async () => { controller.abort(); return Response.json({ status: 'ZERO_RESULTS', results: [] }); } }),
    { geocode: async () => { fallbackCalls++; return { place: null, answered: true }; } },
  ] });
  await assert.rejects(service.geocode('missing', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(fallbackCalls, 0);
});

test('service lifetime cancellation also rejects cache hits', async () => {
  const controller = new AbortController();
  const service = createPlaceSearch({ signal: controller.signal, providers: [createPhotonGeocoder({ fetchImpl: async () => hit() })] });
  assert.ok((await service.geocode('Hanoi')).place);
  controller.abort();
  await assert.rejects(service.geocode('Hanoi'), { name: 'AbortError' });
});

test('one cancelled caller cannot cancel another caller of the same service', async () => {
  const controller = new AbortController();
  const service = createPlaceSearch({ providers: [{ async geocode(_query, { signal }) {
    await new Promise((resolve) => setImmediate(resolve)); signal.throwIfAborted();
    return { place: { lat: 1, lng: 2 }, answered: true };
  } }] });
  const first = service.geocode('same', { signal: controller.signal });
  const second = service.geocode('same');
  controller.abort();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal((await second).place.lat, 1);
});

test('definitive misses expire while outage outcomes are never cached', async () => {
  let now = 0, calls = 0, answered = true;
  const service = createPlaceSearch({ now: () => now, providers: [{ async geocode() { calls++; return { place: null, answered }; } }] });
  await service.geocode('miss'); await service.geocode('miss'); assert.equal(calls, 1);
  now = 30_001; answered = false;
  await service.geocode('miss'); await service.geocode('miss'); assert.equal(calls, 3);
});

test('wrapped and nonnumeric Photon bounds are omitted', () => {
  assert.equal(photonExtentToBounds([170, 10, -170, -10]), null);
  assert.equal(photonExtentToBounds([null, 10, 20, -10]), null);
});
