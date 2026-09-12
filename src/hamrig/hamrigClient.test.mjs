import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LOGIN_FAILURE_BACKOFF_MS,
  buildHamrigQuery,
  createHamrigClient,
  isValidHamrigApiPath,
  normalizeHamrigBaseUrl,
  parseHamrigTokenExpiry,
} from './hamrigClient.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-09-12T12:00:00Z');
const PASSWORD = 'hunter2-very-secret';
const SIG = 'ab'.repeat(32);

/** Build a HamRig-shaped token: `user_<id>_<unixExp>_<hex64>`. */
function makeToken(userId, expiresAtMs) {
  return `user_${userId}_${Math.floor(expiresAtMs / 1000)}_${SIG}`;
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function textResponse(body, status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'text/html' } });
}

/**
 * Recording fetch. `handler(call)` returns a Response (or throws). Every call
 * captures the url, method, headers and parsed body so tests can assert on
 * ordering and on which token was sent.
 */
function createFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method || 'GET',
      headers: { ...(init.headers || {}) },
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body ?? null,
      init,
    };
    calls.push(call);
    return handler(call, calls.length);
  };
  return { calls, fetchImpl };
}

function createLog() {
  const lines = [];
  const push = (level) => (...args) => lines.push(`${level}: ${args.map(String).join(' ')}`);
  return { lines, warn: push('warn'), info: push('info'), error: push('error') };
}

function createClock(start = T0) {
  let current = start;
  const now = () => current;
  now.advance = (ms) => { current += ms; };
  now.set = (ms) => { current = ms; };
  return now;
}

/** A fetch that serves login + a couple of protected/public routes. */
function createHamrigStub({ tokenExpiresAt = T0 + 30 * DAY_MS, loginStatus = 200, userId = 7 } = {}) {
  const stub = {
    logins: 0,
    rejectTokens: new Set(),
    tokenSequence: [],
  };
  const fetch = createFetch((call) => {
    if (call.url.endsWith('/api/auth/login')) {
      stub.logins += 1;
      if (loginStatus !== 200) return jsonResponse({ error: 'Invalid credentials' }, loginStatus);
      const token = stub.tokenSequence.length
        ? stub.tokenSequence.shift()
        : makeToken(userId, tokenExpiresAt + (stub.logins - 1) * 1000);
      return jsonResponse({ status: 'success', user: { id: userId, username: 'gev' }, token, expires_in: 3600 });
    }
    if (call.url.includes('/api/rotators')) {
      const auth = call.headers.Authorization || '';
      const token = auth.replace(/^Bearer /, '');
      if (!auth.startsWith('Bearer ') || stub.rejectTokens.has(token)) {
        return jsonResponse({ error: 'Unauthorized. Valid authentication token required.' }, 401);
      }
      return jsonResponse([{ id: 1, nickname: 'Tower', gateway_key: 'gk' }]);
    }
    if (call.url.includes('/api/spots')) {
      return jsonResponse({ success: true, count: 1, spots: [{ dx_callsign: 'DA2M', spotter: 'CR3W', frequency: '21.364' }] });
    }
    if (call.url.includes('/api/missing')) return jsonResponse({ error: 'Not found' }, 404);
    if (call.url.includes('/api/html')) return textResponse('<html>Gateway Timeout</html>', 504);
    return jsonResponse({ error: `unexpected ${call.url}` }, 500);
  });
  return Object.assign(stub, fetch);
}

test('normalizeHamrigBaseUrl enforces https except on loopback hosts', () => {
  assert.equal(normalizeHamrigBaseUrl('https://hamrig.com'), 'https://hamrig.com');
  assert.equal(normalizeHamrigBaseUrl('https://test.hamrig.com/'), 'https://test.hamrig.com');
  assert.equal(normalizeHamrigBaseUrl('https://example.org/hamrig/'), 'https://example.org/hamrig');
  assert.equal(normalizeHamrigBaseUrl('http://localhost:8080'), 'http://localhost:8080');
  assert.equal(normalizeHamrigBaseUrl('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080');
  assert.equal(normalizeHamrigBaseUrl('http://[::1]:8080'), 'http://[::1]:8080');
  assert.equal(normalizeHamrigBaseUrl('http://hamrig.com'), null);
  assert.equal(normalizeHamrigBaseUrl('http://hamrig.localhost.evil.com'), null);
  assert.equal(normalizeHamrigBaseUrl('https://user:pw@hamrig.com'), null);
  assert.equal(normalizeHamrigBaseUrl('https://hamrig.com/?x=1'), null);
  assert.equal(normalizeHamrigBaseUrl('ftp://hamrig.com'), null);
  assert.equal(normalizeHamrigBaseUrl('not a url'), null);
  assert.equal(normalizeHamrigBaseUrl(''), null);
  assert.equal(normalizeHamrigBaseUrl(undefined), null);
});

test('parseHamrigTokenExpiry reads the unix-seconds middle segment', () => {
  const expiresAt = T0 + 30 * DAY_MS;
  assert.equal(parseHamrigTokenExpiry(makeToken(12, expiresAt)), expiresAt);
  assert.equal(parseHamrigTokenExpiry(` ${makeToken(1, expiresAt)}\n`), expiresAt);
  assert.equal(parseHamrigTokenExpiry('user_12_abc'), null);
  assert.equal(parseHamrigTokenExpiry(`user_12_${Math.floor(expiresAt / 1000)}_short`), null);
  assert.equal(parseHamrigTokenExpiry('opaque-token'), null);
  assert.equal(parseHamrigTokenExpiry(null), null);
  assert.equal(parseHamrigTokenExpiry(42), null);
});

test('isValidHamrigApiPath accepts /api/ routes and rejects everything else', () => {
  assert.equal(isValidHamrigApiPath('/api/spots'), true);
  assert.equal(isValidHamrigApiPath('/api/public/callsign-db/S79%2FDL2SBY'), true);
  assert.equal(isValidHamrigApiPath('/api/rotators/3/status'), true);
  assert.equal(isValidHamrigApiPath('/health.php'), false);
  assert.equal(isValidHamrigApiPath('api/spots'), false);
  assert.equal(isValidHamrigApiPath('/api'), false);
  assert.equal(isValidHamrigApiPath('/api/spots?limit=1'), false);
  assert.equal(isValidHamrigApiPath('/api/spots#x'), false);
  assert.equal(isValidHamrigApiPath('/api/../health.php'), false);
  assert.equal(isValidHamrigApiPath('/api/./spots'), false);
  assert.equal(isValidHamrigApiPath('/api//spots'), false);
  assert.equal(isValidHamrigApiPath('/api/spo ts'), false);
  assert.equal(isValidHamrigApiPath('/api/spots\r\nX: y'), false);
  assert.equal(isValidHamrigApiPath('/api/spots\\x'), false);
  assert.equal(isValidHamrigApiPath(''), false);
  assert.equal(isValidHamrigApiPath(null), false);
});

test('buildHamrigQuery URL-encodes values, skips null/undefined and repeats arrays', () => {
  assert.equal(buildHamrigQuery(undefined), '');
  assert.equal(buildHamrigQuery(null), '');
  assert.equal(buildHamrigQuery({}), '');
  assert.equal(buildHamrigQuery({ a: undefined, b: null }), '');
  assert.equal(
    buildHamrigQuery({ limit: 300, band: '20m', call: 'S79/DL2SBY', grid: 'JO32 ab', skip: undefined, nul: null, ids: [1, 2] }),
    '?limit=300&band=20m&call=S79%2FDL2SBY&grid=JO32+ab&ids=1&ids=2',
  );
  assert.equal(buildHamrigQuery({ q: 'a&b=c' }), '?q=a%26b%3Dc');
  assert.equal(buildHamrigQuery(new URLSearchParams({ x: '1' })), '?x=1');
  assert.throws(() => buildHamrigQuery('limit=1'), TypeError);
});

test('configured / canAuthenticate / status() shapes never expose secrets', () => {
  const plain = createHamrigClient({ fetchImpl: async () => { throw new Error('offline'); }, log: null });
  assert.equal(plain.configured, true);
  assert.equal(plain.canAuthenticate, false);
  assert.deepEqual(plain.status(), {
    baseUrl: 'https://hamrig.com',
    configured: true,
    canAuthenticate: false,
    authenticated: false,
    tokenExpiresAt: null,
  });

  const withCreds = createHamrigClient({ baseUrl: 'https://test.hamrig.com/', username: 'gev', password: PASSWORD, log: null });
  assert.equal(withCreds.configured, true);
  assert.equal(withCreds.canAuthenticate, true);
  assert.equal(withCreds.status().baseUrl, 'https://test.hamrig.com');
  assert.equal(withCreds.status().authenticated, false);
  assert.ok(!JSON.stringify(withCreds.status()).includes(PASSWORD));
  assert.ok(Object.values(withCreds).every((value) => typeof value !== 'string'), 'no secret strings hang off the client object');

  const local = createHamrigClient({ baseUrl: 'http://localhost:8080', log: null });
  assert.equal(local.configured, true);

  const insecure = createHamrigClient({ baseUrl: 'http://hamrig.com', username: 'gev', password: PASSWORD, log: null });
  assert.equal(insecure.configured, false);
  assert.equal(insecure.canAuthenticate, false);
  assert.equal(insecure.status().baseUrl, null);
  assert.equal(insecure.status().configured, false);

  const blank = createHamrigClient({ username: '   ', password: '', log: null });
  assert.equal(blank.canAuthenticate, false);

  assert.equal(typeof withCreds.get, 'function');
  assert.equal(typeof withCreds.post, 'function');
  assert.equal(typeof withCreds.status, 'function');
  assert.equal(typeof withCreds.invalidateToken, 'function');
});

test('unconfigured client rejects every call without touching the network', async () => {
  const { calls, fetchImpl } = createFetch(() => jsonResponse({}));
  const client = createHamrigClient({ baseUrl: 'http://hamrig.com', fetchImpl, log: null });
  await assert.rejects(client.get('/api/spots'), (error) => error.code === 'HAMRIG_NOT_CONFIGURED');
  await assert.rejects(client.post('/api/dxcc/batch-lookup', { callsigns: [] }), /not configured/);
  assert.equal(calls.length, 0);
});

test('path guard rejects non-/api/ paths such as /health.php before any fetch', async () => {
  const { calls, fetchImpl } = createFetch(() => jsonResponse({}));
  const client = createHamrigClient({ fetchImpl, username: 'gev', password: PASSWORD, log: null });
  for (const bad of ['/health.php', 'api/spots', '/api/spots?limit=1', '/api/../health.php', '', undefined, 42]) {
    await assert.rejects(client.get(bad), (error) => error.code === 'HAMRIG_BAD_PATH' && /\/api\//.test(error.message));
    await assert.rejects(client.get(bad, { auth: true }), (error) => error.code === 'HAMRIG_BAD_PATH');
    await assert.rejects(client.post(bad, {}), (error) => error.code === 'HAMRIG_BAD_PATH');
  }
  assert.equal(calls.length, 0);
});

test('unauthenticated GET builds the URL, encodes the query and returns { status, json, text }', async () => {
  const stub = createHamrigStub();
  const client = createHamrigClient({ fetchImpl: stub.fetchImpl, username: 'gev', password: PASSWORD, log: null });
  const result = await client.get('/api/spots', { query: { limit: 300, band: '20m', call: 'S79/DL2SBY', skip: undefined, nul: null } });
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.logins, 0);
  const call = stub.calls[0];
  assert.equal(call.url, 'https://hamrig.com/api/spots?limit=300&band=20m&call=S79%2FDL2SBY');
  assert.equal(call.method, 'GET');
  assert.equal(call.headers.Accept, 'application/json');
  assert.match(call.headers['User-Agent'], /^GodsEyeView\/1\.0/);
  assert.equal(call.headers.Authorization, undefined);
  assert.equal(call.headers['Content-Type'], undefined);
  assert.equal(call.init.body, undefined);
  assert.equal(call.init.redirect, 'manual');
  assert.ok(call.init.signal instanceof AbortSignal);
  assert.deepEqual(Object.keys(result).sort(), ['json', 'status', 'text']);
  assert.equal(result.status, 200);
  assert.equal(result.json.success, true);
  assert.equal(result.json.spots[0].dx_callsign, 'DA2M');
  assert.equal(JSON.parse(result.text).count, 1);
});

test('baseUrl with a path prefix is preserved and a trailing slash is not doubled', async () => {
  const { calls, fetchImpl } = createFetch(() => jsonResponse({ ok: true }));
  const client = createHamrigClient({ baseUrl: 'https://example.org/hamrig/', fetchImpl, log: null });
  await client.get('/api/spots');
  assert.equal(calls[0].url, 'https://example.org/hamrig/api/spots');
});

test('non-2xx responses resolve with the status and never throw', async () => {
  const stub = createHamrigStub();
  const client = createHamrigClient({ fetchImpl: stub.fetchImpl, log: null });
  const missing = await client.get('/api/missing');
  assert.deepEqual(missing, { status: 404, json: { error: 'Not found' }, text: '{"error":"Not found"}' });
  const html = await client.get('/api/html');
  assert.equal(html.status, 504);
  assert.equal(html.json, null);
  assert.equal(html.text, '<html>Gateway Timeout</html>');
});

test('redirects are not followed (a bearer token must never travel to another host)', async () => {
  const { calls, fetchImpl } = createFetch(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }));
  const client = createHamrigClient({ fetchImpl, log: null });
  const result = await client.get('/api/spots');
  assert.deepEqual(result, { status: 302, json: null, text: '' });
  assert.equal(calls[0].init.redirect, 'manual');
});

test('POST sends a JSON body with the content-type header', async () => {
  const { calls, fetchImpl } = createFetch(() => jsonResponse({ success: true, results: [] }));
  const client = createHamrigClient({ fetchImpl, log: null });
  const result = await client.post('/api/dxcc/batch-lookup', { callsigns: ['S79/DL2SBY', 'DL1ABC'] });
  assert.equal(result.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://hamrig.com/api/dxcc/batch-lookup');
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.deepEqual(calls[0].body, { callsigns: ['S79/DL2SBY', 'DL1ABC'] });
});

test('auth GET logs in lazily first, then sends the bearer token', async () => {
  const stub = createHamrigStub();
  const log = createLog();
  const now = createClock();
  const client = createHamrigClient({ fetchImpl: stub.fetchImpl, username: 'gev', password: PASSWORD, now, log });
  assert.equal(client.status().authenticated, false);

  const result = await client.get('/api/rotators', { auth: true });
  assert.equal(stub.logins, 1);
  assert.equal(stub.calls.length, 2);

  const [loginCall, rotatorCall] = stub.calls;
  assert.equal(loginCall.url, 'https://hamrig.com/api/auth/login');
  assert.equal(loginCall.method, 'POST');
  assert.equal(loginCall.headers['Content-Type'], 'application/json');
  assert.equal(loginCall.headers.Authorization, undefined);
  assert.deepEqual(loginCall.body, { username: 'gev', password: PASSWORD });

  const expectedToken = makeToken(7, T0 + 30 * DAY_MS);
  assert.equal(rotatorCall.url, 'https://hamrig.com/api/rotators');
  assert.equal(rotatorCall.headers.Authorization, `Bearer ${expectedToken}`);

  assert.equal(result.status, 200);
  assert.equal(result.json[0].nickname, 'Tower');
  assert.ok(!result.text.includes(expectedToken));

  const status = client.status();
  assert.equal(status.authenticated, true);
  assert.equal(status.tokenExpiresAt, new Date(T0 + 30 * DAY_MS).toISOString());
  assert.ok(!JSON.stringify(status).includes(SIG));
  assert.ok(!JSON.stringify(status).includes(PASSWORD));
  assert.ok(log.lines.length >= 1);
  for (const line of log.lines) {
    assert.ok(!line.includes(SIG), `log leaked the token: ${line}`);
    assert.ok(!line.includes(PASSWORD), `log leaked the password: ${line}`);
  }
});

test('the 30-day token expiry comes from the token, not from expires_in', async () => {
  const expiresAt = T0 + 30 * DAY_MS;
  const stub = createHamrigStub({ tokenExpiresAt: expiresAt });
  const now = createClock();
  const client = createHamrigClient({ fetchImpl: stub.fetchImpl, username: 'gev', password: PASSWORD, now, log: null });
  await client.get('/api/rotators', { auth: true });
  // expires_in said 3600 s; the token itself says 30 days.
  assert.equal(client.status().tokenExpiresAt, new Date(expiresAt).toISOString());
  now.advance(2 * 60 * 60 * 1000);
  assert.equal(client.status().authenticated, true);
});

test('an unparseable token falls back to expires_in for its lifetime', async () => {
  const now = createClock();
  const { fetchImpl } = createFetch((call) => (call.url.endsWith('/api/auth/login')
    ? jsonResponse({ status: 'success', token: 'opaque-session', expires_in: 3600 })
    : jsonResponse({ ok: true })));
  const client = createHamrigClient({ fetchImpl, username: 'gev', password: PASSWORD, now, log: null });
  await client.get('/api/rotators', { auth: true });
  assert.equal(client.status().tokenExpiresAt, new Date(T0 + 3600 * 1000).toISOString());
});

test('the cached token is reused across calls and parallel calls share one login', async () => {
  const stub = createHamrigStub();
  const now = createClock();
  const client = createHamrigClient({ fetchImpl: stub.fetchImpl, username: 'gev', password: PASSWORD, now, log: null });

  const [a, b, c] = await Promise.all([
    client.get('/api/rotators', { auth: true }),
    client.get('/api/rotators', { auth: true, query: { x: 1 } }),
    client.post('/api/rotators', { command: 'park' }, { auth: true }),
  ]);
  assert.equal(stub.logins, 1, 'parallel auth calls must share one login');
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(c.status, 200);
  assert.equal(stub.calls.length, 4);

  now.advance(3 * DAY_MS);
  await client.get('/api/rotators', { auth: true });
  await client.get('/api/rotators', { auth: true });
  assert.equal(stub.logins, 1, 'token still has 27 days left; no re-login');
  assert.equal(stub.calls.length, 6);
  const tokens = new Set(stub.calls.filter((call) => call.headers.Authorization).map((call) => call.headers.Authorization));
  assert.equal(tokens.size, 1);
});

test('401 from the upstream triggers one re-login and one retry with the new token', async () => {
  const stub = createHamrigStub();
  const now = createClock();
  const log = createLog();
  const client = createHamrigClient({ fetchImpl: stub.fetchImpl, username: 'gev', password: PASSWORD, now, log });

  const first = await client.get('/api/rotators', { auth: true });
  assert.equal(first.status, 200);
  const tokenA = stub.calls[1].headers.Authorization.replace('Bearer ', '');

  // Upstream now rejects token A (revoked / secret rotated).
  stub.rejectTokens.add(tokenA);
  now.advance(10 * 60 * 1000);
  const second = await client.get('/api/rotators', { auth: true, query: { limit: 5 } });
  assert.equal(second.status, 200);
  assert.equal(stub.logins, 2);
  // login A, GET(A) 200, GET(A) 401, login B, GET(B) 200
  assert.deepEqual(stub.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`), [
    'POST /api/auth/login',
    'GET /api/rotators',
    'GET /api/rotators',
    'POST /api/auth/login',
    'GET /api/rotators',
  ]);
  const tokenB = stub.calls[4].headers.Authorization.replace('Bearer ', '');
  assert.notEqual(tokenA, tokenB);
  assert.equal(stub.calls[2].headers.Authorization, `Bearer ${tokenA}`);
  assert.equal(stub.calls[4].url, 'https://hamrig.com/api/rotators?limit=5');
  assert.equal(client.status().authenticated, true);
  for (const line of log.lines) assert.ok(!line.includes(SIG) && !line.includes(PASSWORD));
});

test('a second 401 after re-login is returned as-is (retry happens once only)', async () => {
  const stub = createHamrigStub();
  const now = createClock();
  const client = createHamrigClient({ fetchImpl: stub.fetchImpl, username: 'gev', password: PASSWORD, now, log: null });
  // Every token the stub mints will be rejected.
  const originalFetch = stub.fetchImpl;
  const fetchImpl = async (url, init) => {
    const response = await originalFetch(url, init);
    if (String(url).includes('/api/rotators')) {
      return jsonResponse({ error: 'Unauthorized. Valid authentication token required.' }, 401);
    }
    return response;
  };
  const strict = createHamrigClient({ fetchImpl, username: 'gev', password: PASSWORD, now, log: null });
  const result = await strict.get('/api/rotators', { auth: true });
  assert.equal(result.status, 401);
  assert.deepEqual(result.json, { error: 'Unauthorized. Valid authentication token required.' });
  assert.equal(stub.logins, 2);
  assert.equal(stub.calls.length, 4, 'login, GET 401, login, GET 401 — no third attempt');
  void client;
});

test('a token with less than a day left is renewed before the call', async () => {
  const stub = createHamrigStub({ tokenExpiresAt: T0 + 30 * DAY_MS });
  const now = createClock();
  const client = createHamrigClient({ fetchImpl: stub.fetchImpl, username: 'gev', password: PASSWORD, now, log: null });
  await client.get('/api/rotators', { auth: true });
  assert.equal(stub.logins, 1);

  now.set(T0 + 29 * DAY_MS - 60 * 60 * 1000);
  await client.get('/api/rotators', { auth: true });
  assert.equal(stub.logins, 1, '25 h left: still fresh');

  now.set(T0 + 29 * DAY_MS + 60 * 60 * 1000);
  await client.get('/api/rotators', { auth: true });
  assert.equal(stub.logins, 2, '23 h left: renewed');
  assert.equal(stub.calls.at(-1).headers.Authorization, `Bearer ${makeToken(7, T0 + 30 * DAY_MS + 1000)}`);
});

test('an expired token is replaced by a fresh login', async () => {
  const stub = createHamrigStub({ tokenExpiresAt: T0 + 30 * DAY_MS });
  const now = createClock();
  const client = createHamrigClient({ fetchImpl: stub.fetchImpl, username: 'gev', password: PASSWORD, now, log: null });
  await client.get('/api/rotators', { auth: true });
  assert.equal(client.status().authenticated, true);

  now.set(T0 + 31 * DAY_MS);
  assert.equal(client.status().authenticated, false);
  const renewed = makeToken(7, T0 + 61 * DAY_MS);
  stub.tokenSequence.push(renewed);
  const result = await client.get('/api/rotators', { auth: true });
  assert.equal(result.status, 200);
  assert.equal(stub.logins, 2);
  assert.equal(client.status().authenticated, true);
  assert.equal(client.status().tokenExpiresAt, new Date(T0 + 61 * DAY_MS).toISOString());
  assert.equal(stub.calls.at(-2).method, 'POST');
  assert.equal(stub.calls.at(-1).headers.Authorization, `Bearer ${renewed}`);
});

test('bad credentials: auth calls resolve to { status: 401, json: null } without throwing', async () => {
  const stub = createHamrigStub({ loginStatus: 401 });
  const now = createClock();
  const log = createLog();
  const client = createHamrigClient({ fetchImpl: stub.fetchImpl, username: 'gev', password: PASSWORD, now, log });

  const result = await client.get('/api/rotators', { auth: true });
  assert.equal(result.status, 401);
  assert.equal(result.json, null);
  assert.equal(result.text, '');
  assert.match(result.error, /login failed/i);
  assert.equal(stub.logins, 1);
  assert.equal(stub.calls.length, 1, 'the protected route was never attempted');
  assert.equal(client.status().authenticated, false);
  assert.equal(client.status().tokenExpiresAt, null);
  assert.ok(log.lines.some((line) => /login failed/i.test(line)));
  for (const line of log.lines) {
    assert.ok(!line.includes(PASSWORD), `log leaked the password: ${line}`);
  }

  // Within the backoff window the client answers locally instead of re-trying the login.
  now.advance(LOGIN_FAILURE_BACKOFF_MS / 2);
  const again = await client.get('/api/rotators', { auth: true });
  assert.equal(again.status, 401);
  assert.equal(stub.logins, 1);

  // After the backoff a new login attempt is made.
  now.advance(LOGIN_FAILURE_BACKOFF_MS);
  await client.get('/api/rotators', { auth: true });
  assert.equal(stub.logins, 2);

  // invalidateToken() also clears the backoff.
  client.invalidateToken();
  await client.post('/api/map/data/locate-calls', { calls: ['DL1ABC'] }, { auth: true });
  assert.equal(stub.logins, 3);

  // Public calls keep working regardless.
  const spots = await client.get('/api/spots');
  assert.equal(spots.status, 200);
});

test('a 200 login without a token counts as a failed login', async () => {
  const { calls, fetchImpl } = createFetch(() => jsonResponse({ status: 'error', message: 'maintenance' }));
  const client = createHamrigClient({ fetchImpl, username: 'gev', password: PASSWORD, log: null });
  const result = await client.get('/api/rotators', { auth: true });
  assert.equal(result.status, 401);
  assert.equal(result.json, null);
  assert.match(result.error, /no token/);
  assert.equal(calls.length, 1);
});

test('auth calls without configured credentials resolve to 401 and never fetch', async () => {
  const { calls, fetchImpl } = createFetch(() => jsonResponse({}));
  const client = createHamrigClient({ fetchImpl, log: null });
  const result = await client.get('/api/rotators', { auth: true });
  assert.deepEqual(result, { status: 401, json: null, text: '', error: 'HamRig login not configured' });
  assert.equal(calls.length, 0);
});

test('invalidateToken forces a new login on the next auth call', async () => {
  const stub = createHamrigStub();
  const client = createHamrigClient({ fetchImpl: stub.fetchImpl, username: 'gev', password: PASSWORD, now: createClock(), log: null });
  await client.get('/api/rotators', { auth: true });
  assert.equal(client.status().authenticated, true);
  client.invalidateToken();
  assert.equal(client.status().authenticated, false);
  assert.equal(client.status().tokenExpiresAt, null);
  await client.get('/api/rotators', { auth: true });
  assert.equal(stub.logins, 2);
});

test('network errors throw with the method and path but without secrets', async () => {
  const fetchImpl = async () => { throw new TypeError('fetch failed'); };
  const client = createHamrigClient({ fetchImpl, username: 'gev', password: PASSWORD, log: null });
  await assert.rejects(client.get('/api/spots', { query: { limit: 1 } }), (error) => {
    assert.equal(error.code, 'HAMRIG_NETWORK');
    assert.match(error.message, /GET \/api\/spots/);
    assert.match(error.message, /fetch failed/);
    assert.ok(error.cause instanceof TypeError);
    return true;
  });
  // A login that fails at the transport level propagates too (it is a network error, not a 401).
  await assert.rejects(client.get('/api/rotators', { auth: true }), (error) => {
    assert.equal(error.code, 'HAMRIG_NETWORK');
    assert.match(error.message, /POST \/api\/auth\/login/);
    assert.ok(!error.message.includes(PASSWORD));
    return true;
  });
});

test('the request times out via AbortSignal and rejects with HAMRIG_TIMEOUT', async () => {
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });
  const client = createHamrigClient({ fetchImpl, timeoutMs: 25, log: null });
  const started = Date.now();
  await assert.rejects(client.get('/api/spots'), (error) => {
    assert.equal(error.code, 'HAMRIG_TIMEOUT');
    assert.match(error.message, /timed out after 25 ms \(GET \/api\/spots\)/);
    return true;
  });
  assert.ok(Date.now() - started < 5000);
});

test('an injected signal aborts the request and the caller sees its own reason', async () => {
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });
  const client = createHamrigClient({ fetchImpl, timeoutMs: 60_000, log: null });
  const controller = new AbortController();
  const pending = client.get('/api/spots', { signal: controller.signal });
  const reason = new Error('voice action superseded');
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
});

test('timeoutMs <= 0 disables the timeout signal unless the caller injects one', async () => {
  const { calls, fetchImpl } = createFetch(() => jsonResponse({ ok: true }));
  const client = createHamrigClient({ fetchImpl, timeoutMs: 0, log: null });
  await client.get('/api/spots');
  assert.equal(calls[0].init.signal, undefined);
  const controller = new AbortController();
  await client.get('/api/spots', { signal: controller.signal });
  assert.equal(calls[1].init.signal, controller.signal);
});

test('tolerates minimal fake responses that only expose json() or text()', async () => {
  const jsonOnly = createHamrigClient({ fetchImpl: async () => ({ status: 200, json: async () => ({ success: true }) }), log: null });
  assert.deepEqual(await jsonOnly.get('/api/spots'), { status: 200, json: { success: true }, text: '{"success":true}' });
  const textOnly = createHamrigClient({ fetchImpl: async () => ({ status: 503, text: async () => 'busy' }), log: null });
  assert.deepEqual(await textOnly.get('/api/spots'), { status: 503, json: null, text: 'busy' });
  const bare = createHamrigClient({ fetchImpl: async () => ({ status: 204 }), log: null });
  assert.deepEqual(await bare.get('/api/spots'), { status: 204, json: null, text: '' });
});

test('a logger that throws never breaks a request', async () => {
  const stub = createHamrigStub({ loginStatus: 401 });
  const log = { warn() { throw new Error('logger broken'); }, info() { throw new Error('logger broken'); } };
  const client = createHamrigClient({ fetchImpl: stub.fetchImpl, username: 'gev', password: PASSWORD, now: createClock(), log });
  const result = await client.get('/api/rotators', { auth: true });
  assert.equal(result.status, 401);
});
