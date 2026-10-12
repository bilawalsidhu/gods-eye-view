import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import {
  accessGateConfigProblems,
  createAccessGate,
  createLoginLimiter,
  createSessionToken,
  failClosedMiddleware,
  parseCookies,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  verifySessionToken,
} from '../server/hosted/accessGate.js';
import { sameSiteRequestShape } from '../server/providers/common/same-site.js';
import { admitSameSiteRequest } from './localRequestGate.mjs';

const PASSWORD = 'correct horse battery';
const SECRET = 's'.repeat(48);

function request({ method = 'GET', url = '/', headers = {}, body = '' } = {}) {
  const req = new EventEmitter();
  Object.assign(req, {
    method,
    url,
    headers,
    socket: { remoteAddress: '203.0.113.9' },
  });
  queueMicrotask(() => {
    if (body) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return req;
}

function response() {
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk = '') {
      this.body += chunk;
      this.ended = true;
    },
  };
  return res;
}

async function run(gate, options) {
  const req = request(options);
  const res = response();
  let passed = false;
  await gate(req, res, () => {
    passed = true;
  });
  return { res, passed };
}

const gate = (extra = {}) =>
  createAccessGate({
    password: PASSWORD,
    secret: SECRET,
    failureDelayMs: 0,
    ...extra,
  });

test('hosted config fails closed without strong password and secret', () => {
  assert.equal(accessGateConfigProblems({}).length, 2);
  assert.match(
    accessGateConfigProblems({
      GEV_ACCESS_PASSWORD: 'short',
      GEV_SESSION_SECRET: SECRET,
    }).join(),
    /at least 12/,
  );
  assert.match(
    accessGateConfigProblems({
      GEV_ACCESS_PASSWORD: PASSWORD,
      GEV_SESSION_SECRET: 'tiny',
    }).join(),
    /at least 32/,
  );
  assert.deepEqual(
    accessGateConfigProblems({
      GEV_ACCESS_PASSWORD: PASSWORD,
      GEV_SESSION_SECRET: SECRET,
    }),
    [],
  );
  const res = response();
  failClosedMiddleware(['GEV_ACCESS_PASSWORD is not set'])(request(), res);
  assert.equal(res.statusCode, 503);
  assert.doesNotMatch(res.body, new RegExp(SECRET));
});

test('unauthenticated navigation gets the login page and /api gets 401 JSON', async () => {
  const page = await run(gate(), { headers: { accept: 'text/html' } });
  assert.equal(page.passed, false);
  assert.equal(page.res.statusCode, 401);
  assert.match(page.res.body, /<form method="post" action="\/login"/);
  assert.doesNotMatch(page.res.body, /<script/i);

  const api = await run(gate(), { url: '/api/realtime/token', method: 'POST' });
  assert.equal(api.passed, false);
  assert.equal(api.res.statusCode, 401);
  assert.deepEqual(JSON.parse(api.res.body), {
    error: 'Authentication required',
  });

  const asset = await run(gate(), { url: '/assets/index-abc.js' });
  assert.equal(asset.passed, false);
  assert.equal(asset.res.statusCode, 401);
});

test('only the minimal pre-auth files pass without a session', async () => {
  for (const url of ['/manifest.webmanifest', '/pwa-192.png', '/logo.svg'])
    assert.equal((await run(gate(), { url })).passed, true, url);
  for (const url of ['/sw.js', '/index.html', '/', '/api/x'])
    assert.equal((await run(gate(), { url })).passed, false, url);
  // Public paths are GET-only.
  assert.equal(
    (await run(gate(), { url: '/logo.svg', method: 'POST' })).passed,
    false,
  );
});

test('a correct password sets a signed HttpOnly Secure SameSite=Lax cookie', async () => {
  const { res } = await run(gate(), {
    method: 'POST',
    url: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `password=${encodeURIComponent(PASSWORD)}`,
  });
  assert.equal(res.statusCode, 303);
  assert.equal(res.headers.location, '/');
  const cookie = res.headers['set-cookie'];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, new RegExp(`Max-Age=${SESSION_TTL_MS / 1000}`));
  const token = parseCookies(cookie.split(';')[0])[SESSION_COOKIE];
  assert.ok(verifySessionToken(SECRET, token));

  const after = await run(gate(), {
    url: '/api/places',
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });
  assert.equal(after.passed, true);
});

test('wrong password, forged or expired cookies are refused', async () => {
  const bad = await run(gate(), {
    method: 'POST',
    url: '/login',
    body: 'password=nope',
  });
  assert.equal(bad.res.statusCode, 401);
  assert.equal(bad.res.headers['set-cookie'], undefined);

  const forged = createSessionToken('x'.repeat(48));
  assert.equal(verifySessionToken(SECRET, forged), false);
  const old = createSessionToken(SECRET, Date.now() - SESSION_TTL_MS - 1000);
  assert.equal(verifySessionToken(SECRET, old), false);
  const tampered = createSessionToken(SECRET).replace(
    /^v1\.\d+/,
    'v1.9999999999999',
  );
  assert.equal(verifySessionToken(SECRET, tampered), false);
  for (const token of [forged, old, tampered, 'garbage'])
    assert.equal(
      (await run(gate(), { headers: { cookie: `${SESSION_COOKIE}=${token}` } }))
        .passed,
      false,
    );
});

test('logout clears the cookie and the cached shell', async () => {
  const { res, passed } = await run(gate(), { url: '/logout' });
  assert.equal(passed, false);
  assert.equal(res.statusCode, 303);
  assert.equal(res.headers.location, '/login');
  assert.match(res.headers['set-cookie'], /Max-Age=0/);
  assert.match(res.headers['clear-site-data'], /cache/);
});

test('repeated failures lock the client out', async () => {
  let t = 1_000_000;
  const limiter = createLoginLimiter({ now: () => t, maxPerKey: 3 });
  const g = gate({ limiter });
  for (let i = 0; i < 3; i += 1)
    await run(g, { method: 'POST', url: '/login', body: 'password=wrong' });
  const locked = await run(g, {
    method: 'POST',
    url: '/login',
    body: `password=${encodeURIComponent(PASSWORD)}`,
  });
  assert.equal(locked.res.statusCode, 429);
  t += 16 * 60 * 1000;
  const later = await run(g, {
    method: 'POST',
    url: '/login',
    body: `password=${encodeURIComponent(PASSWORD)}`,
  });
  assert.equal(later.res.statusCode, 303);
});

test('trusted-proxy mode keeps Origin and Sec-Fetch-Site checks', () => {
  const proxied = {
    headers: {
      host: 'internal:3000',
      'x-forwarded-host': 'gev.example.test',
      'x-forwarded-proto': 'https',
      'x-forwarded-for': '198.51.100.1',
      origin: 'https://gev.example.test',
      'sec-fetch-site': 'same-origin',
    },
    socket: {},
  };
  // Default (local) mode still refuses proxied requests.
  assert.equal(
    admitSameSiteRequest(sameSiteRequestShape(proxied, {})).ok,
    false,
  );
  const trusted = { GEV_TRUSTED_PROXY: '1' };
  assert.equal(
    admitSameSiteRequest(sameSiteRequestShape(proxied, trusted)).ok,
    true,
  );
  const crossSite = {
    ...proxied,
    headers: { ...proxied.headers, 'sec-fetch-site': 'cross-site' },
  };
  assert.equal(
    admitSameSiteRequest(sameSiteRequestShape(crossSite, trusted)).ok,
    false,
  );
  const foreign = {
    ...proxied,
    headers: { ...proxied.headers, origin: 'https://evil.example' },
  };
  assert.equal(
    admitSameSiteRequest(sameSiteRequestShape(foreign, trusted)).ok,
    false,
  );
});

test('service worker never caches api or auth routes and manifest is GEV-branded', () => {
  const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  for (const pattern of ['\\/api\\/', '\\/login', '\\/logout'])
    assert.ok(sw.includes(pattern), pattern);
  const manifest = JSON.parse(
    readFileSync(
      new URL('../public/manifest.webmanifest', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(manifest.name, "God's Eye View");
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512'));
  assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable'));
  assert.doesNotMatch(JSON.stringify(manifest), /saug/i);
});

test('Hostinger entry is a CommonJS shim that import()s the ESM server', () => {
  const entry = readFileSync(
    new URL('../hostinger-entry.cjs', import.meta.url),
    'utf8',
  );
  assert.match(entry, /import\('\.\/server\.js'\)/);
  assert.doesNotMatch(entry, /^\s*(import|export)\s/m);
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.equal(
    (server.match(/\.listen\(|preview\(\{/g) || []).length,
    1,
    'server.js must start exactly one HTTP server (lsnode allows one listen)',
  );
  assert.match(server, /process\.env|env\.PORT/);
});
