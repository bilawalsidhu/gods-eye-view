import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateParams,
  fetchWithRetry,
  parseJson,
  provenance,
  failure,
  missingAuth,
  isoUtc,
  normalizeBbox,
  COMPLETENESS_VALUES,
} from './_shared.js';

const LICENSE = { name: 'L', url: 'https://l', attribution: 'A' };

describe('server/sources/_shared.js — validateParams', () => {
  const spec = {
    lat: { type: 'number', required: true, min: -90, max: 90 },
    limit: { type: 'integer', min: 1, max: 100, default: 10 },
    live: { type: 'boolean' },
    profile: { type: 'enum', values: ['drive', 'walk'] },
    ids: { type: 'csv', values: ['a', 'b'], max: 2 },
    since: { type: 'iso-date' },
    q: { type: 'string', maxLength: 5 },
  };

  test('applies defaults, coerces numbers/booleans/csv and keeps ISO dates', () => {
    const r = validateParams(
      {
        lat: '24.4',
        live: 'true',
        profile: 'walk',
        ids: 'a,b',
        since: '2026-09-18T00:00:00Z',
        q: 'abc',
      },
      spec,
    );
    assert.equal(r.ok, true);
    assert.deepEqual(r.params, {
      lat: 24.4,
      limit: 10,
      live: true,
      profile: 'walk',
      ids: ['a', 'b'],
      since: '2026-09-18T00:00:00Z',
      q: 'abc',
    });
  });

  test('rejects unknown, missing, out-of-range, bad enum, bad csv, bad date, long string — always 400 with param', () => {
    assert.deepEqual(
      validateParams({ lat: 1, nope: 1 }, spec).error.code,
      'unknown_param',
    );
    assert.deepEqual(
      validateParams({}, spec),
      failure(400, 'missing_param', 'parameter "lat" is required', 'lat'),
    );
    assert.equal(validateParams({ lat: 91 }, spec).error.code, 'invalid_param');
    assert.equal(validateParams({ lat: 'x' }, spec).error.param, 'lat');
    assert.equal(
      validateParams({ lat: 1, limit: 1.5 }, spec).error.code,
      'invalid_param',
    );
    assert.equal(
      validateParams({ lat: 1, live: 'maybe' }, spec).error.code,
      'invalid_param',
    );
    assert.equal(
      validateParams({ lat: 1, profile: 'fly' }, spec).error.code,
      'invalid_param',
    );
    assert.equal(
      validateParams({ lat: 1, ids: 'a,c' }, spec).error.code,
      'invalid_param',
    );
    assert.equal(
      validateParams({ lat: 1, ids: 'a,b,a' }, spec).error.code,
      'invalid_param',
    );
    assert.equal(
      validateParams({ lat: 1, since: 'yesterday' }, spec).error.code,
      'invalid_param',
    );
    assert.equal(
      validateParams({ lat: 1, q: 'toolong' }, spec).error.code,
      'invalid_param',
    );
    for (const r of [
      validateParams({ lat: 91 }, spec),
      validateParams({ lat: 1, nope: 1 }, spec),
    ]) {
      assert.equal(r.ok, false);
      assert.equal(r.status, 400);
      assert.equal(typeof r.error.message, 'string');
    }
  });
});

describe('server/sources/_shared.js — fetchWithRetry', () => {
  const okResponse = () => new Response('{"a":1}', { status: 200 });

  test('returns the response on 2xx without retrying', async () => {
    let calls = 0;
    const r = await fetchWithRetry('https://x', {
      fetchImpl: async () => (calls++, okResponse()),
    });
    assert.equal(r.ok, true);
    assert.equal(calls, 1);
  });

  test('retries exactly once on 5xx then succeeds', async () => {
    let calls = 0;
    const r = await fetchWithRetry('https://x', {
      fetchImpl: async () =>
        calls++ === 0 ? new Response('down', { status: 503 }) : okResponse(),
    });
    assert.equal(r.ok, true);
    assert.equal(calls, 2);
  });

  test('5xx twice → 502 upstream_unavailable after exactly two attempts', async () => {
    let calls = 0;
    const r = await fetchWithRetry('https://x', {
      fetchImpl: async () => (calls++, new Response('down', { status: 502 })),
      provider: 'P',
    });
    assert.deepEqual(
      r,
      failure(502, 'upstream_unavailable', 'P answered HTTP 502'),
    );
    assert.equal(calls, 2);
  });

  test('429 → rate_limited immediately, no retry, retry_after surfaced', async () => {
    let calls = 0;
    const r = await fetchWithRetry('https://x', {
      fetchImpl: async () => (
        calls++,
        new Response('slow', { status: 429, headers: { 'retry-after': '30' } })
      ),
    });
    assert.equal(calls, 1);
    assert.equal(r.status, 429);
    assert.equal(r.error.code, 'rate_limited');
    assert.equal(r.error.retry_after, 30);
  });

  test('401/403 → upstream_auth; other 4xx → upstream_rejected (502), no retry', async () => {
    const r1 = await fetchWithRetry('https://x', {
      fetchImpl: async () => new Response('', { status: 403 }),
    });
    assert.equal(r1.error.code, 'upstream_auth');
    assert.equal(r1.status, 403);
    const r2 = await fetchWithRetry('https://x', {
      fetchImpl: async () => new Response('', { status: 404 }),
    });
    assert.equal(r2.error.code, 'upstream_rejected');
    assert.equal(r2.status, 502);
  });

  test('timeout → retried once, then 504 upstream_timeout', async () => {
    let calls = 0;
    const r = await fetchWithRetry('https://x', {
      timeoutMs: 20,
      fetchImpl: (_u, { signal }) =>
        new Promise((_res, rej) => {
          calls++;
          signal.addEventListener('abort', () =>
            rej(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    });
    assert.equal(calls, 2);
    assert.equal(r.status, 504);
    assert.equal(r.error.code, 'upstream_timeout');
  });

  test('network error → retried once, then 502', async () => {
    let calls = 0;
    const r = await fetchWithRetry('https://x', {
      fetchImpl: async () => {
        calls++;
        throw new TypeError('fetch failed');
      },
    });
    assert.equal(calls, 2);
    assert.equal(r.error.code, 'upstream_unavailable');
  });

  test('caller AbortSignal → 499 cancelled, never retried', async () => {
    const ac = new AbortController();
    let calls = 0;
    const p = fetchWithRetry('https://x', {
      signal: ac.signal,
      fetchImpl: (_u, { signal }) =>
        new Promise((_res, rej) => {
          calls++;
          signal.addEventListener('abort', () =>
            rej(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    });
    ac.abort();
    const r = await p;
    assert.equal(r.status, 499);
    assert.equal(r.error.code, 'cancelled');
    assert.equal(calls, 1);
    const r2 = await fetchWithRetry('https://x', {
      signal: ac.signal,
      fetchImpl: async () => okResponse(),
    });
    assert.equal(r2.error.code, 'cancelled');
  });
});

describe('server/sources/_shared.js — parseJson / provenance / helpers', () => {
  test('parseJson: valid JSON ok, invalid → 502 malformed_upstream', async () => {
    assert.deepEqual((await parseJson(new Response('{"x":1}'))).json, { x: 1 });
    const bad = await parseJson(new Response('<html>'), 'P');
    assert.equal(bad.status, 502);
    assert.equal(bad.error.code, 'malformed_upstream');
  });

  test('provenance: builds the envelope and refuses completeness "complete"', () => {
    const p = provenance({
      provider: 'P',
      source_url: 'https://s',
      license: LICENSE,
      fetched_at: '2026-09-18T00:00:00.000Z',
      freshness: { kind: 'live' },
      coverage: { kind: 'bbox' },
      completeness: { status: 'bounded', reason: 'limit' },
    });
    assert.deepEqual(Object.keys(p), [
      'provider',
      'source_url',
      'license',
      'fetched_at',
      'freshness',
      'coverage',
      'completeness',
    ]);
    assert.throws(
      () =>
        provenance({
          provider: 'P',
          license: LICENSE,
          completeness: { status: 'complete' },
        }),
      /never 'complete'/,
    );
    assert.throws(
      () => provenance({ provider: 'P', license: LICENSE, completeness: {} }),
      /completeness/,
    );
    assert.throws(
      () =>
        provenance({
          provider: 'P',
          license: { name: 'x' },
          completeness: { status: 'partial' },
        }),
      /license/,
    );
    assert.deepEqual(
      [...COMPLETENESS_VALUES],
      ['partial', 'sampled', 'bounded', 'estimated'],
    );
  });

  test('missingAuth, isoUtc, normalizeBbox', () => {
    const m = missingAuth('FIRMS_MAP_KEY');
    assert.equal(m.status, 401);
    assert.equal(m.error.code, 'missing_auth');
    assert.equal(m.error.param, 'FIRMS_MAP_KEY');
    assert.match(isoUtc(new Date(0)), /^1970-01-01T00:00:00.000Z$/);
    assert.deepEqual(
      normalizeBbox({ south: '1', west: '2', north: '3', east: '4' }),
      { south: 1, west: 2, north: 3, east: 4 },
    );
    assert.equal(normalizeBbox({ south: 5, west: 2, north: 3, east: 4 }), null);
    assert.equal(
      normalizeBbox({ south: 1, west: 2, north: 3, east: 'x' }),
      null,
    );
  });
});
