import test from 'node:test';
import assert from 'node:assert/strict';
import { createSatelliteSource } from './source.js';
import { createSatellitesLayer } from './index.js';

test('satellite sources confine catalog groups and reject a cancelled body', async () => {
  const controller = new AbortController();
  let requests = 0;
  const source = createSatelliteSource({
    fetchImpl: async (url) => {
      requests++;
      assert.equal(url, '/api/celestrak/stations');
      return {
        ok: true,
        status: 200,
        text: async () => {
          controller.abort();
          return 'late catalog';
        },
      };
    },
  });
  await assert.rejects(
    source.readGroup('../active'),
    /Unknown satellite group/,
  );
  assert.equal(requests, 0);
  await assert.rejects(
    source.readGroup('stations', { signal: controller.signal }),
    { name: 'AbortError' },
  );
});

test('satellite sources carry the proxy provider status alongside the body, and null for a legacy proxy', async () => {
  const fetchedAt = '2026-09-18T12:00:00.000Z';
  const responses = {
    '/api/celestrak/stations': {
      ok: true,
      status: 200,
      headers: new Headers({
        'x-provider-status': 'stale',
        'x-provider-source': 'CelesTrak (bundled snapshot)',
        'x-provider-fetched-at': fetchedAt,
        'x-provider-age-sec': '3600',
        'x-provider-error': 'CelesTrak HTTP 403',
        'x-provider-count': '20',
      }),
      text: async () => 'ISS\n1 25544U fixture\n2 25544 fixture',
    },
    '/api/celestrak/visual': {
      ok: true,
      status: 200,
      text: async () => 'legacy body',
    },
    '/api/celestrak/geo': {
      ok: false,
      status: 503,
      headers: new Headers({ 'x-provider-status': 'unavailable' }),
      text: async () =>
        JSON.stringify({
          error: 'CelesTrak unreachable — no cached TLEs',
          provider: {
            status: 'unavailable',
            source: 'CelesTrak',
            error: 'CelesTrak unreachable — no cached TLEs',
          },
        }),
    },
    '/api/celestrak/galileo': { ok: false, status: 502 },
  };
  const source = createSatelliteSource({
    fetchImpl: async (url) => responses[url],
  });
  const stale = await source.readGroup('stations');
  assert.equal(stale.ok, true);
  assert.equal(stale.text, 'ISS\n1 25544U fixture\n2 25544 fixture');
  assert.deepEqual(stale.provider, {
    status: 'stale',
    source: 'CelesTrak (bundled snapshot)',
    fetchedAtMs: Date.parse(fetchedAt),
    ageSec: 3600,
    error: 'CelesTrak HTTP 403',
    count: 20,
  });
  assert.equal(stale.error, 'CelesTrak HTTP 403');
  const legacy = await source.readGroup('visual');
  assert.equal(legacy.ok, true);
  assert.equal(legacy.text, 'legacy body');
  assert.equal(legacy.provider, null);
  assert.equal(legacy.error, null);
  const down = await source.readGroup('geo');
  assert.equal(down.ok, false);
  assert.equal(down.status, 503);
  assert.equal(down.text, '');
  assert.equal(down.provider.status, 'unavailable');
  assert.equal(down.error, 'CelesTrak unreachable — no cached TLEs');
  // A bare failed response (no headers, no body reader) stays a plain failure.
  const bare = await source.readGroup('galileo');
  assert.deepEqual(bare, {
    ok: false,
    status: 502,
    text: '',
    provider: null,
    error: null,
  });
});

test('satellite factories keep control state separate and construct without requests', () => {
  const source = {
    readGroup() {
      assert.fail('construction fetched a catalog');
    },
  };
  const services = Object.fromEntries(
    [
      'picking',
      'focus',
      'readout',
      'overlays',
      'context',
      'render',
      'layerState',
    ].map((key) => [key, {}]),
  );
  services.layerState.isExplicitLayerStateOrigin = () => false;
  const first = createSatellitesLayer({ source, services });
  const second = createSatellitesLayer({ source, services });
  first.setParams({ showPoints: false });
  assert.equal(first.getParams().showPoints, false);
  assert.equal(second.getParams().showPoints, true);
  assert.notEqual(first.getStats(), second.getStats());
});
