import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequest } from './analytics.js';

const ctx = (request) => ({ request });
const post = () => new Request('https://example.com/api/analytics', { method: 'POST' });

test('POST acknowledges without persisting (Workers KV required for that)', async () => {
  const res = await onRequest(ctx(post()));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.deepEqual(await res.json(), { ok: true });
});

test('CORS preflight answers 204 with the POST/OPTIONS policy', async () => {
  const res = await onRequest(ctx(new Request(post(), { method: 'OPTIONS' })));
  assert.equal(res.status, 204);
  assert.equal(await res.text(), '');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  // This endpoint is write-only: unlike the GET proxies, the advertised
  // method list must not promise GET.
  assert.equal(res.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  assert.equal(res.headers.get('access-control-max-age'), '86400');
});

test('any method gets the same idempotent acknowledgement', async () => {
  for (const method of ['GET', 'POST', 'PUT']) {
    const res = await onRequest(ctx(new Request('https://example.com/api/analytics', { method })));
    assert.equal(res.status, 200, method);
    assert.deepEqual(await res.json(), { ok: true }, method);
    assert.equal(res.headers.get('access-control-allow-origin'), '*', method);
  }
});
