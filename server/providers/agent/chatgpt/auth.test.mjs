import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createChatGptAuth } from './auth.js';
import { createChatGptStore } from './store.js';
import { AUTH_ORIGIN, TOKEN_URL, RESOURCE } from './http.js';
import { createChatGptAuthHandler } from './routes.js';
import { Readable } from 'node:stream';

const pair = await generateKeyPair('RS256');
const wrongPair = await generateKeyPair('RS256');
const jwk = {
  ...(await exportJWK(pair.publicKey)),
  kid: 'fixture',
  alg: 'RS256',
  use: 'sig',
};
const scopes =
  'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

async function fixture(
  t,
  {
    mutateClaims = (p) => p,
    mutateTokens = (p) => p,
    signingKey = pair.privateKey,
    tokenError = null,
    beforeExchange = async () => {},
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-chatgpt-'));
  const directory = path.join(root, 'chatgpt');
  const store = createChatGptStore({ directory });
  const calls = [];
  let authUrl;
  let currentTime = Date.now();
  let refreshes = 0;
  let revision = 0;
  let revokeStatus = 200;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/jwks.json'))
      return Response.json({ keys: [jwk] });
    if (String(url).endsWith('/openid-configuration'))
      return Response.json({
        issuer: AUTH_ORIGIN,
        revocation_endpoint: `${AUTH_ORIGIN}/oauth/revoke`,
      });
    if (String(url).endsWith('/oauth/revoke'))
      return new Response(null, { status: revokeStatus });
    assert.equal(String(url), TOKEN_URL);
    assert.equal(init.redirect, 'error');
    const form = new URLSearchParams(init.body);
    assert.equal(form.get('resource'), RESOURCE);
    assert.notEqual(form.get('client_id'), 'dynamic_agent_client');
    assert.equal(form.has('client_secret'), false);
    if (tokenError)
      return Response.json({ error: tokenError }, { status: 400 });
    if (form.get('grant_type') === 'refresh_token') {
      refreshes += 1;
      assert.equal(form.has('scope'), false);
      return Response.json({
        token_type: 'Bearer',
        access_token: `access-refreshed-${refreshes}`,
        refresh_token: `refresh-rotated-${refreshes}`,
        expires_in: 3600,
      });
    }
    assert.equal(
      form.get('redirect_uri'),
      authUrl.searchParams.get('redirect_uri'),
    );
    assert.equal(
      createHash('sha256')
        .update(form.get('code_verifier'))
        .digest('base64url'),
      authUrl.searchParams.get('code_challenge'),
    );
    await beforeExchange();
    const seconds = Math.floor(currentTime / 1000);
    const claims = mutateClaims({
      iss: AUTH_ORIGIN,
      aud: form.get('client_id'),
      sub: 'test-user',
      email: 'fixture@example.test',
      exp: seconds + 3600,
      iat: seconds,
      nonce: authUrl.searchParams.get('nonce'),
    });
    const idToken = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
      .sign(signingKey);
    revision += 1;
    return Response.json(
      mutateTokens({
        token_type: 'Bearer',
        access_token: `access-${revision}`,
        refresh_token: `refresh-${revision}`,
        id_token: idToken,
        expires_in: 3600,
        scope: scopes,
      }),
    );
  };
  const auth = createChatGptAuth({ store, fetchImpl, now: () => currentTime });
  t.after(() => {
    auth.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function start(account = null) {
    const { path: url } = await auth.start(account);
    assert.match(url, /^\/api\/agent\/chatgpt\/authorize\?ticket=[\w-]+$/);
    authUrl = new URL(
      auth.authorize(
        new URL(url, 'http://localhost').searchParams.get('ticket'),
      ),
    );
    return authUrl;
  }
  async function callback({ clientId = 'oaiapp_fixture', state, error } = {}) {
    const url = new URL(authUrl.searchParams.get('redirect_uri'));
    url.searchParams.set('state', state ?? authUrl.searchParams.get('state'));
    if (clientId) url.searchParams.set('client_id', clientId);
    if (error) url.searchParams.set('error', error);
    else url.searchParams.set('code', 'fake-authorization-code');
    return fetch(url);
  }
  return {
    auth,
    store,
    directory,
    fetchImpl,
    calls,
    start,
    callback,
    advance(ms) {
      currentTime += ms;
    },
    get refreshes() {
      return refreshes;
    },
    setRevokeStatus(status) {
      revokeStatus = status;
    },
  };
}

test('dynamic registration uses PKCE, stable host, validated identity and private storage; no token in status', async (t) => {
  const f = await fixture(t);
  const url = await f.start();
  assert.equal(url.origin, AUTH_ORIGIN);
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(url.searchParams.get('agent_name_hint'), "God's Eye View");
  assert.equal(
    url.searchParams.get('ext_agent_host_id'),
    f.store.read().hostId,
  );
  assert.equal(url.searchParams.get('scope'), scopes);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(
    url.searchParams.get('redirect_uri'),
    /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/,
  );
  assert.equal((await f.callback()).status, 200);
  const status = f.auth.status();
  assert.equal(status.configured, true);
  assert.equal(status.accounts.length, 1);
  assert.doesNotMatch(
    JSON.stringify(status),
    /access-1|refresh-1|id_token|test-user|oaiapp_fixture/,
  );
  const lease = await f.auth.lease(status.binding);
  assert.equal(lease.token, 'access-1');
  if (process.platform !== 'win32')
    assert.equal(
      fs.statSync(path.join(f.directory, 'accounts.json')).mode & 0o777,
      0o600,
    );
  const next = await f.start(status.active);
  assert.equal(next.searchParams.get('client_id'), 'oaiapp_fixture');
  assert.equal(next.searchParams.has('agent_name_hint'), false);
  assert.equal(
    next.searchParams.get('ext_agent_host_id'),
    url.searchParams.get('ext_agent_host_id'),
  );
  assert.notEqual(
    next.searchParams.get('nonce'),
    url.searchParams.get('nonce'),
  );
  assert.notEqual(
    next.searchParams.get('state'),
    url.searchParams.get('state'),
  );
  assert.equal((await f.callback({ clientId: null })).status, 200);
  assert.equal(lease.signal.aborted, true);
  await assert.rejects(f.auth.lease(status.binding), /account changed/);
});

for (const [name, options] of Object.entries({
  signature: { signingKey: wrongPair.privateKey },
  issuer: { mutateClaims: (p) => ({ ...p, iss: 'https://evil.invalid' }) },
  audience: { mutateClaims: (p) => ({ ...p, aud: 'another-client' }) },
  expiry: { mutateClaims: (p) => ({ ...p, exp: p.iat - 60 }) },
  nonce: { mutateClaims: (p) => ({ ...p, nonce: 'wrong' }) },
  subject: { mutateClaims: (p) => ({ ...p, sub: '' }) },
  permission: {
    mutateTokens: (p) => ({ ...p, scope: 'openid profile email' }),
  },
}))
  test(`reject invalid ${name} before activating account or saving tokens`, async (t) => {
    const f = await fixture(t, options);
    await f.start();
    assert.equal((await f.callback()).status, 400);
    assert.equal(f.auth.status().configured, false);
    assert.equal(f.store.read().accounts[0].tokens, undefined);
  });

test('bad state is rejected without token exchange; denial stops the attempt', async (t) => {
  const f = await fixture(t);
  await f.start();
  assert.equal((await f.callback({ state: 'attacker' })).status, 400);
  assert.equal(f.calls.length, 0);
  assert.equal(f.auth.status().pending, true);
  assert.equal((await f.callback({ error: 'access_denied' })).status, 400);
  assert.equal(f.calls.length, 0);
  assert.equal(f.auth.status().pending, false);
});

test('invalid_grant retains issued client ID for a fresh authorization', async (t) => {
  const f = await fixture(t, { tokenError: 'invalid_grant' });
  await f.start();
  assert.equal((await f.callback()).status, 400);
  const record = f.store.read().accounts[0];
  assert.equal(record.clientId, 'oaiapp_fixture');
  const url = await f.start(record.id);
  assert.equal(url.searchParams.get('client_id'), record.clientId);
});

test('returning registration cannot be replaced by a different client ID', async (t) => {
  const f = await fixture(t);
  await f.start();
  await f.callback();
  const before = f.store.read();
  await f.start(before.active);
  const requestsBefore = f.calls.length;
  assert.equal((await f.callback({ clientId: 'oaiapp_other' })).status, 400);
  assert.equal(f.calls.length, requestsBefore);
  assert.deepEqual(f.store.read(), before);
});

test('same email registrations stay separate; switching cancels leases and rejects stale bindings', async (t) => {
  const f = await fixture(t);
  await f.start();
  await f.callback();
  const first = f.auth.status();
  const lease = await f.auth.lease(first.binding);
  await f.start();
  await f.callback({ clientId: 'oaiapp_other_workspace' });
  const second = f.auth.status();
  assert.equal(second.accounts.length, 2);
  assert.notEqual(first.active, second.active);
  assert.equal(lease.signal.aborted, true);
  await f.auth.select(first.active);
  assert.equal(f.auth.status().active, first.active);
  await assert.rejects(f.auth.lease(second.binding), /account changed/);
});

test('refresh is serialized across independent store instances and uses rotated credentials', async (t) => {
  const f = await fixture(t);
  await f.start();
  await f.callback();
  f.advance(3_550_000);
  const other = createChatGptAuth({
    store: createChatGptStore({ directory: f.directory }),
    fetchImpl: f.fetchImpl,
    now: () => Date.now() + 3_550_000,
  });
  t.after(() => other.close());
  const binding = f.auth.status().binding;
  const leases = await Promise.all([
    f.auth.lease(binding),
    other.lease(binding),
    f.auth.lease(binding),
  ]);
  assert.equal(f.refreshes, 1);
  assert.deepEqual(
    leases.map((l) => l.token),
    ['access-refreshed-1', 'access-refreshed-1', 'access-refreshed-1'],
  );
  assert.equal(
    f.store.read().accounts[0].tokens.refresh_token,
    'refresh-rotated-1',
  );
});

for (const status of [200, 503])
  test(`logout clears tokens and preserves registration even when revocation returns ${status}`, async (t) => {
    const f = await fixture(t);
    await f.start();
    await f.callback();
    const before = f.auth.status();
    const lease = await f.auth.lease(before.binding);
    f.setRevokeStatus(status);
    const result = await f.auth.logout();
    assert.equal(result.revoked, status === 200);
    assert.equal(result.configured, false);
    assert.equal(lease.signal.aborted, true);
    const record = f.store.read().accounts[0];
    assert.equal(record.tokens, undefined);
    assert.equal(record.clientId, 'oaiapp_fixture');
    const url = await f.start(record.id);
    assert.equal(url.searchParams.has('id_token_hint'), false);
    assert.equal(url.searchParams.get('client_id'), 'oaiapp_fixture');
  });

test('failed hardening never writes credentials', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-chatgpt-storage-'));
  const directory = path.join(root, 'chatgpt');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createChatGptStore({ directory, harden: () => false });
  await assert.rejects(
    store.transaction((d) => {
      d.secret = 'must-not-write';
    }),
    /protect/,
  );
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('auth routes refuse foreign origins, proxy headers, hostile Host, LAN clients and non-POST mutations', async () => {
  let called = false;
  const handler = createChatGptAuthHandler({
    status() {
      called = true;
      return {};
    },
  });
  for (const patch of [
    { headers: { host: 'localhost:4173', origin: 'https://evil.invalid' } },
    { headers: { host: 'localhost:4173', 'x-forwarded-for': '127.0.0.1' } },
    { headers: { host: 'evil.invalid' } },
    { socket: { remoteAddress: '192.168.1.2' } },
    { url: '/login' },
  ]) {
    const req = Object.assign(
      Readable.from([]),
      {
        method: 'GET',
        url: '/status',
        headers: { host: 'localhost:4173' },
        socket: { remoteAddress: '127.0.0.1' },
      },
      patch,
    );
    const res = { setHeader() {}, end() {}, statusCode: 200 };
    await handler(req, res);
    assert.ok([403, 405].includes(res.statusCode));
    assert.equal(called, false);
  }
});

test('simultaneous login starts cannot replace each other', async (t) => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.auth.start(), f.auth.start()]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
  assert.equal(f.auth.status().pending, true);
});

test('logout during code exchange cannot resurrect the session and revokes the abandoned grant', async (t) => {
  let release;
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, {
    beforeExchange: async () => {
      entered();
      await pending;
    },
  });
  await f.start();
  const callback = f.callback();
  await ready;
  await f.auth.logout();
  release();
  assert.equal((await callback).status, 400);
  for (let i = 0; i < 20 && f.auth.status().pending; i++)
    await new Promise(setImmediate);
  assert.equal(f.auth.status().configured, false);
  assert.equal(f.store.read().accounts[0].tokens, undefined);
  assert.ok(f.calls.some((c) => c.url.endsWith('/oauth/revoke')));
});

test('malformed callback URLs return 400 without consuming the authorization attempt', async (t) => {
  const { request } = await import('node:http');
  const f = await fixture(t);
  const authorization = await f.start();
  const callback = new URL(authorization.searchParams.get('redirect_uri'));
  const status = await new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: callback.hostname,
        port: callback.port,
        path: 'http://%',
        method: 'GET',
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 400);
  assert.equal(f.auth.status().pending, true);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.callback()).status, 200);
});
