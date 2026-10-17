import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplicationRequestServices } from './requests.js';

test('independent compatible endpoints receive normalized requests without changing global fetch', async () => {
  const requests = [];
  const original = globalThis.fetch;
  const services = createApplicationRequestServices({
    endpoints: { regional: '/custom/region', terrain: '/custom/floors', summary: '/custom/summary' },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return Response.json({ results: [{ ellipsoid: 10 }], summary: 'fixture' });
    },
  });
  await services.regional.getBrief(30, -97);
  assert.match(requests[0].url, /^\/custom\/region\?latitude=30.00000&longitude=-97.00000$/);
  assert.deepEqual(await services.terrain.getHeights([{ lat: 30, lon: -97 }]), [{ ellipsoid: 10 }]);
  const result = await services.summary.summarize({ place: 'fixture' });
  assert.equal(result.data.summary, 'fixture');
  assert.equal(requests[2].init.body, '{"place":"fixture"}');
  assert.equal(requests[2].init.redirect, 'error');
  assert.equal(globalThis.fetch, original);
});

test('lifetime cancellation discards a late response body even from an uncooperative transport', async () => {
  const lifetime = new AbortController();
  let finish;
  const services = createApplicationRequestServices({ signal: lifetime.signal,
    fetchImpl: async () => ({ ok: true, status: 200, json: () => new Promise(resolve => { finish = resolve; }) }),
  });
  const pending = services.weather.getConditions(30, -97);
  while (!finish) await Promise.resolve();
  lifetime.abort();
  finish({ weather: { temperatureC: 10 } });
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(services.regional.getBrief(30, -97), { name: 'AbortError' });
});

test('boundary throttle status survives empty or invalid error bodies', async () => {
  for (const status of [429, 503]) {
    const services = createApplicationRequestServices({ fetchImpl: async () => new Response('unavailable', { status, headers: { 'Retry-After': '5' } }) });
    assert.deepEqual(await services.boundaries.query('fixture'), { rateLimited: true, retryAfterMs: 5000 });
  }
});

/** A transport whose status probe behaves as told; queries answer with no elements. */
function probeTransport(status) {
  const seen = [];
  const fetchImpl = (url, init = {}) => {
    seen.push(`${init.method || 'GET'} ${url}`);
    if (!String(url).endsWith('/status')) return Promise.resolve(Response.json({ elements: [] }));
    return status(init);
  };
  return { seen, fetchImpl };
}
const stalled = (init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));

test('a stalled capability probe times out and queries proceed; no re-probe during backoff', async () => {
  const { seen, fetchImpl } = probeTransport(stalled);
  const services = createApplicationRequestServices({ fetchImpl, boundaryProbe: { timeoutMs: 20, retryMs: 60_000 } });
  const started = Date.now();
  assert.deepEqual(await services.boundaries.query('fixture'), []);
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(await services.boundaries.query('fixture'), []);
  assert.deepEqual(seen, ['GET /api/overpass/status', 'POST /api/overpass', 'POST /api/overpass']);
});

test('a caller cancelled while the probe is pending stops waiting at once', async () => {
  const { seen, fetchImpl } = probeTransport(stalled);
  const services = createApplicationRequestServices({ fetchImpl, boundaryProbe: { timeoutMs: 60_000, retryMs: 60_000 } });
  const caller = new AbortController();
  const pending = services.boundaries.query('fixture', { signal: caller.signal });
  setTimeout(() => caller.abort(), 10);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(seen, ['GET /api/overpass/status']);
});

test('a failed probe is retried after its backoff, not on every query', async () => {
  let failures = 1;
  const { seen, fetchImpl } = probeTransport(async () => {
    if (failures-- > 0) throw new TypeError('network');
    return Response.json({ configured: false });
  });
  const services = createApplicationRequestServices({ fetchImpl, boundaryProbe: { timeoutMs: 1000, retryMs: 30 } });
  assert.deepEqual(await services.boundaries.query('fixture'), []);
  assert.deepEqual(await services.boundaries.query('fixture'), []);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await services.boundaries.query('fixture')).code, 'OVERPASS_NOT_CONFIGURED');
  assert.equal((await services.boundaries.query('fixture')).code, 'OVERPASS_NOT_CONFIGURED');
  assert.deepEqual(seen, [
    'GET /api/overpass/status',
    'POST /api/overpass',
    'POST /api/overpass',
    'GET /api/overpass/status',
  ]);
});
