import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequest } from './ais-live.ts';

const ctx = (request) => ({ request });
const get = () => new Request('https://example.com/api/ais-live');

test('GET returns the documented Pages degradation shape', async () => {
  const res = await onRequest(ctx(get()));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json');
  const body = await res.json();
  // The AISSTREAM key cannot be brokered from a Pages Function (no
  // persistent WebSocket), so the contract is an EMPTY sources list plus an
  // explicit status — not an error, and never a fabricated feed.
  assert.deepEqual(body, { sources: [], status: 'unavailable_in_pages' });
});

test('CORS preflight answers 204 with the GET/OPTIONS policy', async () => {
  const res = await onRequest(ctx(new Request(get(), { method: 'OPTIONS' })));
  assert.equal(res.status, 204);
  assert.equal(await res.text(), '');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
  assert.equal(res.headers.get('access-control-max-age'), '86400');
});

test('every response carries the wildcard CORS header', async () => {
  for (const method of ['GET', 'POST']) {
    const res = await onRequest(ctx(new Request(get(), { method })));
    assert.equal(res.headers.get('access-control-allow-origin'), '*', method);
  }
});
