import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequest } from './regional-brief.ts';

const ctx = (request) => ({ request });
const get = (query = '') => new Request(`https://example.com/api/regional-brief${query}`);

test('GET returns the documented graceful-degradation shape', async () => {
  const res = await onRequest(ctx(get('?lat=32.7&lon=-117.2')));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json');
  const body = await res.json();
  // News headlines need an upstream provider this deployment does not broker,
  // so the contract is an EMPTY headline list with an explicit ok status —
  // the HUD brief section renders empty rather than erroring.
  assert.deepEqual(body, { headlines: [], status: 'ok' });
});

test('query parameters are accepted and ignored (no steering surface)', async () => {
  // Whatever coordinates a client sends, the response is static — the handler
  // must not fetch, echo input back, or vary its shape with input.
  const res = await onRequest(ctx(get('?lat=1&lon=2&url=https://attacker.example')));
  assert.deepEqual(await res.json(), { headlines: [], status: 'ok' });
});

test('CORS preflight answers 204 with the GET/OPTIONS policy', async () => {
  const res = await onRequest(ctx(new Request(get(), { method: 'OPTIONS' })));
  assert.equal(res.status, 204);
  assert.equal(await res.text(), '');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
  assert.equal(res.headers.get('access-control-max-age'), '86400');
});
