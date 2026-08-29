import test from 'node:test';
import assert from 'node:assert/strict';

import {
  allowRequest,
  clientKey,
  jsonResponse,
  makeOptInRateLimiter,
  makeRateLimiter,
  methodNotAllowed,
  rateLimitedResponse,
  readJsonBody,
} from './_lib.js';

const req = (body = null, headers = {}) => new Request('https://example.com/api/x', {
  method: body === null ? 'GET' : 'POST',
  headers,
  body: body === null ? undefined : body,
});

test('jsonResponse serializes with the documented content type and status', async () => {
  const res = jsonResponse({ ok: true }, { status: 201, cacheControl: 'no-store' });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await res.json(), { ok: true });

  const bare = jsonResponse({ a: 1 });
  assert.equal(bare.status, 200);
  assert.equal(bare.headers.get('Cache-Control'), null);
});

test('methodNotAllowed matches the dev middleware error shape', async () => {
  const res = methodNotAllowed();
  assert.equal(res.status, 405);
  assert.deepEqual(await res.json(), { error: 'Method not allowed' });
});

test('readJsonBody parses valid JSON and enforces the byte cap', async () => {
  const ok = await readJsonBody(req('{"a":1}'), 1000);
  assert.deepEqual(ok, { ok: true, value: { a: 1 } });

  const empty = await readJsonBody(req(''), 1000);
  assert.deepEqual(empty, { ok: true, value: {} });

  const tooBig = await readJsonBody(req('"aaaaaaaaaa"'), 5);
  assert.equal(tooBig.ok, false);
  assert.equal(tooBig.status, 400);
  assert.match(tooBig.error, /exceeds 5 bytes/);

  const bad = await readJsonBody(req('{nope'), 1000);
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);
});

test('makeRateLimiter admits within the window and refuses at the cap', () => {
  let now = 0;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const allow = makeRateLimiter({ windowMs: 60_000, max: 2 });
    assert.equal(allow('a'), true);
    assert.equal(allow('a'), true);
    assert.equal(allow('a'), false, 'third hit inside the window is refused');

    now = 61_000;
    assert.equal(allow('a'), true, 'the window slides and quota returns');
  } finally {
    Date.now = realNow;
  }
});

test('makeOptInRateLimiter is null unless a positive integer is configured', () => {
  for (const unset of [undefined, '', '0', '-3', 'abc', NaN]) {
    assert.equal(makeOptInRateLimiter(unset), null, `unset-like value: ${String(unset)}`);
  }
  assert.equal(typeof makeOptInRateLimiter('30'), 'function');
  // A fractional cap is honored by flooring — 2.5/min means 2/min, not unlimited.
  assert.equal(typeof makeOptInRateLimiter('2.5'), 'function');
});

test('createCachedOptInLimiter reuses one limiter so window state persists', async () => {
  const { createCachedOptInLimiter } = await import('./_lib.js');
  const limiterFor = createCachedOptInLimiter();
  const a = limiterFor('1');
  assert.equal(limiterFor('1'), a, 'the same env value reuses the same limiter');
  assert.equal(typeof a, 'function');
  assert.equal(limiterFor(undefined), null, 'an unset value is unlimited');
  assert.notEqual(limiterFor('2'), a, 'a changed value rebuilds');

  // Throttling only works if the window state survives across requests.
  const envValue = '1';
  const allow = limiterFor(envValue);
  const ip = '10.9.9.9';
  assert.equal(allow(ip), true);
  assert.equal(allow(ip), false, 'the second request sees the first one in the window');
});

test('allowRequest passes through unlimited and blocks over-cap keys', async () => {
  assert.equal(allowRequest(null, req()), true, 'null limiter is a runtime no-op');

  const limiter = makeOptInRateLimiter('1');
  const limited = rateLimitedResponse();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('Retry-After'), '5');
  assert.deepEqual(await limited.json(), { error: 'Rate limit exceeded' });

  const a = { headers: new Headers({ 'CF-Connecting-IP': '1.2.3.4' }) };
  const b = { headers: new Headers({ 'CF-Connecting-IP': '5.6.7.8' }) };
  assert.equal(limiter(clientKey({ headers: a.headers })), true);
  assert.equal(allowRequest(limiter, { headers: a.headers }), false, 'same IP is over cap');
  assert.equal(allowRequest(limiter, { headers: b.headers }), true, 'a different IP still passes');
});

test('clientKey trusts only the edge-set peer address', () => {
  assert.equal(clientKey({ headers: new Headers({ 'CF-Connecting-IP': '9.9.9.9' }) }), '9.9.9.9');
  assert.equal(
    clientKey({ headers: new Headers({ 'X-Forwarded-For': 'spoofed' }) }),
    'unknown',
    'XFF is client-controlled and must never mint quota',
  );
});
