import test from 'node:test';
import assert from 'node:assert/strict';

import {
  allowRequest,
  clientKey,
  createDefaultOnRateLimiter,
  hostOf,
  jsonResponse,
  makeOptInRateLimiter,
  makeRateLimiter,
  methodNotAllowed,
  PAGES_RATELIMIT_GOOGLE_PER_MIN,
  PAGES_RATELIMIT_OPENAI_PER_MIN,
  rateLimitedResponse,
  readJsonBody,
  sameSiteRejection,
  sameSiteViolation,
} from './_lib.js';

const req = (body = null, headers = {}) => new Request('https://example.com/api/x', {
  method: body === null ? 'GET' : 'POST',
  headers,
  body: body === null ? undefined : body,
});

/** A request attributed to a specific edge peer address. */
const ipReq = (ip, headers = {}) => req(null, { 'CF-Connecting-IP': ip, ...headers });

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

test('default-on limiter: an UNSET env builds the default throttle on first call', () => {
  const factory = createDefaultOnRateLimiter(3);
  const limiter = factory(undefined);
  assert.equal(typeof limiter, 'function', 'unset env must NOT mean unlimited');

  // Regression: the factory used to initialize its cache key to `undefined`,
  // so the first unset-env call "matched" and silently returned no limiter.
  const seen = [];
  for (let i = 0; i < 4; i += 1) seen.push(allowRequest(limiter, ipReq('10.1.0.1')));
  assert.deepEqual(seen, [true, true, true, false], 'the 4th request inside the window is blocked');

  assert.equal(PAGES_RATELIMIT_OPENAI_PER_MIN, 30);
  assert.equal(PAGES_RATELIMIT_GOOGLE_PER_MIN, 60);
});

test('default-on limiter: empty env behaves like unset, `0` is the escape hatch', () => {
  const factory = createDefaultOnRateLimiter(1);
  assert.equal(typeof factory(''), 'function', 'empty string still gets the default throttle');
  assert.equal(factory('0'), null, '0 opts out entirely');
  assert.equal(factory('nope'), null, 'any other non-positive garbage opts out too');
});

test('default-on limiter: a positive env overrides the default', () => {
  const factory = createDefaultOnRateLimiter(30);
  const limiter = factory('2');
  const seen = [];
  for (let i = 0; i < 3; i += 1) seen.push(allowRequest(limiter, ipReq('10.2.0.1')));
  assert.deepEqual(seen, [true, true, false], 'the override max wins over the default');
});

test('default-on limiter: the same env value reuses one limiter, a new value rebuilds', () => {
  const factory = createDefaultOnRateLimiter(5);
  const first = factory('1');
  assert.equal(factory('1'), first, 'per-isolate cache: same env, same window state');

  allowRequest(first, ipReq('10.3.0.1'));
  assert.equal(allowRequest(first, ipReq('10.3.0.1')), false, 'state genuinely persists across calls');

  const fresh = factory('6');
  assert.notEqual(fresh, first, 'a changed env rebuilds the limiter');
  assert.equal(allowRequest(fresh, ipReq('10.3.0.1')), true, 'the rebuilt limiter starts empty');
});

test('sameSiteViolation: Origin decides for POST-style requests', () => {
  assert.equal(sameSiteViolation(req(null, { Origin: 'https://evil.example' })), 'cross-origin');
  assert.equal(sameSiteViolation(req(null, { Origin: 'https://example.com' })), null);
  assert.equal(
    sameSiteViolation(req(null, { Origin: 'null' })),
    'cross-origin',
    'a sandboxed `Origin: null` is not this origin',
  );
});

test('sameSiteViolation: GETs fall back to Sec-Fetch-Site', () => {
  assert.equal(sameSiteViolation(req(null, { 'Sec-Fetch-Site': 'cross-site' })), 'cross-site');
  assert.equal(
    sameSiteViolation(req(null, { 'Sec-Fetch-Site': 'same-site' })),
    'cross-site',
    'sibling subdomains are still not this origin',
  );
  assert.equal(sameSiteViolation(req(null, { 'Sec-Fetch-Site': 'same-origin' })), null);
  assert.equal(sameSiteViolation(req(null, { 'Sec-Fetch-Site': 'none' })), null, 'address-bar navigation is trusted');
});

test('sameSiteViolation: absent headers mean a non-browser client and are allowed', () => {
  assert.equal(sameSiteViolation(req()), null);
});

test('sameSiteRejection answers the shared 403 shape', async () => {
  const res = sameSiteRejection();
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'cross-origin requests are rejected' });
});

test('hostOf extracts host including a non-default port', () => {
  assert.equal(hostOf('https://example.com/path?x=1'), 'example.com');
  assert.equal(hostOf('http://localhost:4173/api'), 'localhost:4173');
  assert.equal(hostOf('not a url'), '');
});
