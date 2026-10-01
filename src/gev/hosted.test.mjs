import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  signSession,
  verifySession,
  parseAccessTokens,
  verifyJwt,
  createJwks,
  createAuth,
  parseCookies,
} from '../../server/hosted/auth.js';
import { createQuotas, parseQuotas } from '../../server/hosted/quotas.js';
import { createMiddlewareStack } from '../../server/hosted/middleware.js';
import { createHostedServer } from '../../server/hosted/server.js';

const SECRET = 'x'.repeat(40);
const TOKEN = 'tok_' + 'a'.repeat(30);

test('session cookies are signed, expiring and tamper-evident', () => {
  const c = signSession({ sub: 'u1', name: 'U', admin: true, exp: Date.now() + 1000 }, SECRET);
  assert.deepEqual(verifySession(c, SECRET).id, 'u1');
  assert.equal(verifySession(c, 'y'.repeat(40)), null);
  const [body, mac] = c.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'admin', admin: true, exp: Date.now() + 1e9 })).toString('base64url');
  assert.equal(verifySession(`${forged}.${mac}`, SECRET), null);
  assert.equal(verifySession(signSession({ sub: 'u1', exp: Date.now() - 1 }, SECRET), SECRET), null);
  assert.equal(verifySession(`${body}`, SECRET), null);
  assert.deepEqual(parseCookies('a=1; gev_session=x%3Dy'), { a: '1', gev_session: 'x=y' });
});

test('access tokens must be long and well-formed', () => {
  assert.throws(() => parseAccessTokens('bob:short'), /24/);
  const list = parseAccessTokens(`alice:${TOKEN}:admin, bob:${'b'.repeat(24)}`);
  assert.deepEqual(list.map((x) => [x.name, x.admin]), [['alice', true], ['bob', false]]);
});

test('createAuth refuses weak or missing configuration', () => {
  assert.throws(() => createAuth({ GEV_AUTH_MODE: 'tokens', GEV_SESSION_SECRET: 'short' }), /32/);
  assert.throws(() => createAuth({ GEV_SESSION_SECRET: SECRET }), /GEV_AUTH_MODE/);
  assert.throws(() => createAuth({ GEV_AUTH_MODE: 'tokens', GEV_SESSION_SECRET: SECRET }), /GEV_ACCESS_TOKENS/);
  assert.throws(() => createAuth({ GEV_AUTH_MODE: 'supabase', GEV_SESSION_SECRET: SECRET, SUPABASE_URL: 'http://x' }), /https/);
});

function jwt(header, payload, sign) {
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${h}.${p}.${sign(`${h}.${p}`).toString('base64url')}`;
}

test('Supabase JWTs verify with HS256 secrets and ES256 JWKS', async () => {
  const iss = 'https://proj.supabase.co/auth/v1';
  const now = Date.now();
  const claims = { sub: 'abc', role: 'authenticated', iss, exp: Math.floor(now / 1000) + 600, email: 'J@x.com' };
  const hs = jwt({ alg: 'HS256' }, claims, (s) => crypto.createHmac('sha256', 'jwtsecret').update(s).digest());
  assert.equal((await verifyJwt(hs, { secret: 'jwtsecret', issuer: iss })).sub, 'abc');
  assert.equal(await verifyJwt(hs, { secret: 'wrong', issuer: iss }), null);
  assert.equal(await verifyJwt(hs, { secret: 'jwtsecret', issuer: 'https://other/auth/v1' }), null);
  const expired = jwt({ alg: 'HS256' }, { ...claims, exp: 1 }, (s) => crypto.createHmac('sha256', 'jwtsecret').update(s).digest());
  assert.equal(await verifyJwt(expired, { secret: 'jwtsecret', issuer: iss }), null);
  const anon = jwt({ alg: 'HS256' }, { ...claims, role: 'anon' }, (s) => crypto.createHmac('sha256', 'jwtsecret').update(s).digest());
  assert.equal(await verifyJwt(anon, { secret: 'jwtsecret', issuer: iss }), null);
  const none = jwt({ alg: 'none' }, claims, () => Buffer.alloc(0));
  assert.equal(await verifyJwt(none, { secret: 'jwtsecret', issuer: iss }), null);

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'ES256' };
  const getKey = createJwks('https://proj.supabase.co/auth/v1/.well-known/jwks.json', {
    fetchImpl: async () => ({ ok: true, json: async () => ({ keys: [jwk] }) }),
  });
  const es = jwt({ alg: 'ES256', kid: 'k1' }, claims, (s) => crypto.sign('sha256', Buffer.from(s), { key: privateKey, dsaEncoding: 'ieee-p1363' }));
  assert.equal((await verifyJwt(es, { getKey, issuer: iss })).email, 'J@x.com');
  const wrongKid = jwt({ alg: 'ES256', kid: 'k2' }, claims, (s) => crypto.sign('sha256', Buffer.from(s), { key: privateKey, dsaEncoding: 'ieee-p1363' }));
  assert.equal(await verifyJwt(wrongKid, { getKey, issuer: iss }), null);
  // An attacker cannot downgrade to HS256 using the public key when no secret is configured.
  const confused = jwt({ alg: 'HS256', kid: 'k1' }, claims, (s) => crypto.createHmac('sha256', JSON.stringify(jwk)).update(s).digest());
  assert.equal(await verifyJwt(confused, { getKey, issuer: iss }), null);
});

test('quotas: per user, per family, fixed windows', () => {
  let t = 0;
  const q = createQuotas(parseQuotas('/api/realtime/token=2/60,*=3/60'), { now: () => t });
  assert.ok(q.take('a', '/api/realtime/token').ok);
  assert.ok(q.take('a', '/api/realtime/token').ok);
  const no = q.take('a', '/api/realtime/token');
  assert.equal(no.ok, false);
  assert.equal(no.retryAfter, 60);
  assert.ok(q.take('b', '/api/realtime/token').ok, 'other users unaffected');
  assert.ok(q.take('a', '/api/opensky').ok, 'other families unaffected');
  t = 61_000;
  assert.ok(q.take('a', '/api/realtime/token').ok, 'window resets');
  assert.throws(() => parseQuotas('nope'), /invalid quota/);
});

test('middleware stack strips prefixes like connect', async () => {
  const app = createMiddlewareStack();
  const seen = [];
  app.use('/api/x', (req, res, next) => (seen.push(['x', req.url, req.originalUrl]), next()));
  app.use('/api', (req, res) => (seen.push(['api', req.url]), res.end()));
  const res = { end() {} };
  app.handle({ url: '/api/x/y?q=1' }, res, () => {});
  app.handle({ url: '/api/xy' }, res, () => {});
  assert.deepEqual(seen, [
    ['x', '/y?q=1', '/api/x/y?q=1'],
    ['api', '/x/y?q=1'],
    ['api', '/xy'],
  ]);
});

test('hosted server: login, gate, CSRF, quotas, denied routes, static', async () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-dist-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>app</title>');
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'assets', 'a.js'), 'console.log(1)');
  fs.writeFileSync(path.join(os.tmpdir(), 'gev-secret.txt'), 'secret');
  const env = {
    GEV_AUTH_MODE: 'tokens',
    GEV_ACCESS_TOKENS: `alice:${TOKEN}`,
    GEV_SESSION_SECRET: SECRET,
    GEV_COOKIE_SECURE: '0',
    GEV_QUOTAS: '/api/echo=2/60,*=100/60',
  };
  const echo = {
    name: 'echo',
    configurePreviewServer(s) {
      s.middlewares.use('/api/echo', (req, res) => res.end(JSON.stringify({ user: req.gevUser.id, url: req.url })));
    },
  };
  const setup = { name: 'gev-key-setup', configurePreviewServer(s) { s.middlewares.use('/api/setup/keys', (req, res) => res.end('WROTE ENV')); } };
  const server = createHostedServer({ env, distDir: dist, plugins: [echo, setup] });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const go = (p, init = {}) => fetch(origin + p, { redirect: 'manual', ...init });
  try {
    assert.equal((await go('/healthz')).status, 200);
    let r = await go('/');
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/login');
    assert.equal((await go('/api/echo')).status, 401);
    r = await go('/login');
    assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');

    r = await go('/auth/login', { method: 'POST', body: JSON.stringify({ token: 'wrong' }) });
    assert.equal(r.status, 401);
    r = await go('/auth/login', { method: 'POST', body: JSON.stringify({ token: TOKEN }) });
    assert.equal(r.status, 200);
    const cookie = r.headers.get('set-cookie').split(';')[0];
    assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
    const authed = (p, init = {}) => go(p, { ...init, headers: { cookie, ...(init.headers || {}) } });

    r = await authed('/api/echo/hi?x=1');
    assert.deepEqual(await r.json(), { user: 'token:alice', url: '/hi?x=1' });
    assert.equal((await authed('/api/me').then((x) => x.json())).name, 'alice');
    assert.equal((await authed('/api/echo')).status, 200);
    assert.equal((await authed('/api/echo')).status, 429, 'quota of 2 per minute reached');

    r = await authed('/api/watch/rules/x', { method: 'PUT', body: '{}' });
    assert.equal(r.status, 403, 'write without Origin refused');
    r = await authed('/api/setup/keys', { method: 'POST', headers: { origin } });
    assert.equal(r.status, 404, 'key setup is never mounted when hosted');
    r = await authed('/api/realtime/debug-log', { method: 'POST', headers: { origin } });
    assert.equal(r.status, 404);
    r = await authed('/api/nothing');
    assert.equal((await r.json()).error, 'unknown_api_route');

    r = await authed('/assets/a.js');
    assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    r = await authed('/some/deep/link');
    assert.match(await r.text(), /<title>app<\/title>/, 'SPA fallback');
    r = await authed('/..%2f..%2fgev-secret.txt');
    assert.notEqual(await r.text(), 'secret');
    r = await authed('/missing.png');
    assert.equal(r.status, 404);

    r = await go('/auth/logout', { method: 'POST' });
    assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
  } finally {
    server.close();
  }
});
