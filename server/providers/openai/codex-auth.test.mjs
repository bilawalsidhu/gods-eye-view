import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  NO_CREDENTIAL_MESSAGE,
  OpenAiAuthError,
  preferCodexOauth,
  resolveOpenAiCredential,
} from './codex-auth.js';
import { createRealtimeTokenHandler } from './realtime.js';

const NOW_MS = Date.now();

function makeJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(payload)}.signature`;
}

function makeCodexHome({ authJson, mtimeS } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gev-codex-auth-'));
  if (authJson !== undefined) {
    writeFileSync(join(dir, 'auth.json'), authJson);
    if (mtimeS !== undefined) utimesSync(join(dir, 'auth.json'), mtimeS, mtimeS);
  }
  return dir;
}

function chatGptAuthJson(accessToken) {
  return JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: accessToken, refresh_token: 'refresh-fixture' },
  });
}

function withTempHome(authJson, fn, { mtimeS } = {}) {
  const codexHome = makeCodexHome({ authJson, mtimeS });
  try {
    return fn(codexHome);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
}

test('OPENAI_API_KEY wins when set', () => {
  const credential = resolveOpenAiCredential({
    env: { OPENAI_API_KEY: 'sk-fixture', CODEX_HOME: '/nonexistent' },
    nowMs: NOW_MS,
  });
  assert.equal(credential.token, 'sk-fixture');
  assert.equal(credential.source, 'env');
});

test('blank OPENAI_API_KEY falls through to the Codex lane', () => {
  const access = makeJwt({ exp: Math.round(NOW_MS / 1000) + 3600 });
  withTempHome(chatGptAuthJson(access), (codexHome) => {
    const credential = resolveOpenAiCredential({
      env: { OPENAI_API_KEY: '   ', CODEX_HOME: codexHome },
      nowMs: NOW_MS,
    });
    assert.equal(credential.token, access);
    assert.equal(credential.source, 'codex-oauth');
  });
});

test('Codex OAuth fallback resolves a valid ChatGPT login', () => {
  const exp = Math.round(NOW_MS / 1000) + 3600;
  const access = makeJwt({ exp });
  withTempHome(chatGptAuthJson(access), (codexHome) => {
    const credential = resolveOpenAiCredential({
      env: { CODEX_HOME: codexHome },
      nowMs: NOW_MS,
    });
    assert.equal(credential.token, access);
    assert.equal(credential.source, 'codex-oauth');
  });
});

test('expired Codex token fails closed and names codex login', () => {
  const access = makeJwt({ exp: Math.round(NOW_MS / 1000) - 3600 });
  withTempHome(chatGptAuthJson(access), (codexHome) => {
    assert.throws(
      () =>
        resolveOpenAiCredential({
          env: { CODEX_HOME: codexHome },
          nowMs: NOW_MS,
        }),
      (error) => {
        assert.ok(error instanceof OpenAiAuthError);
        assert.match(error.message, /OPENAI_API_KEY is not set/);
        assert.match(error.message, /codex login/);
        return true;
      },
    );
  });
});

test('malformed auth.json means no OAuth lane', () => {
  withTempHome('{not json', (codexHome) => {
    assert.throws(
      () =>
        resolveOpenAiCredential({
          env: { CODEX_HOME: codexHome },
          nowMs: NOW_MS,
        }),
      new OpenAiAuthError(NO_CREDENTIAL_MESSAGE),
    );
  });
});

test('API-key-mode auth.json is not a ChatGPT subscription lane', () => {
  withTempHome(JSON.stringify({ OPENAI_API_KEY: 'sk-inside-file' }), (codexHome) => {
    assert.throws(
      () =>
        resolveOpenAiCredential({
          env: { CODEX_HOME: codexHome },
          nowMs: NOW_MS,
        }),
      new OpenAiAuthError(NO_CREDENTIAL_MESSAGE),
    );
  });
});

test('token without an exp claim anchors on the auth.json mtime', () => {
  const access = makeJwt({ sub: 'no-expiry-claim' });
  const freshMtimeS = Math.round(NOW_MS / 1000);
  withTempHome(
    chatGptAuthJson(access),
    (codexHome) => {
      const credential = resolveOpenAiCredential({
        env: { CODEX_HOME: codexHome },
        nowMs: NOW_MS,
      });
      assert.equal(credential.token, access);
    },
    { mtimeS: freshMtimeS },
  );
});

test('GEV_PREFER_CODEX_OAUTH=true refuses metered key fallback', () => {
  assert.throws(
    () =>
      resolveOpenAiCredential({
        env: {
          GEV_PREFER_CODEX_OAUTH: 'true',
          OPENAI_API_KEY: 'sk-fixture',
          CODEX_HOME: '/nonexistent',
        },
        nowMs: NOW_MS,
      }),
    /metered API keys were not used/,
  );
});

test('GEV_PREFER_CODEX_OAUTH with a bogus value fails closed', () => {
  assert.throws(() => preferCodexOauth({ GEV_PREFER_CODEX_OAUTH: 'maybe' }), /true or false/);
});

function mockRes() {
  const headers = new Map();
  return {
    statusCode: 200,
    headers,
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), String(value));
    },
    end(body = '') {
      this.body = String(body);
    },
  };
}

function mockReq(url = '/api/realtime/token') {
  return { method: 'GET', url, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
}

test('handler surfaces a resolver failure as 503 with the lane message', async () => {
  const handler = createRealtimeTokenHandler({
    resolveApiKey: () => {
      throw new OpenAiAuthError(NO_CREDENTIAL_MESSAGE);
    },
  });
  const res = mockRes();
  await handler(mockReq(), res);
  assert.equal(res.statusCode, 503);
  assert.match(res.body, /OPENAI_API_KEY is not set/);
  assert.match(res.body, /codex login/);
});

test('handler mints with a { token, source } credential and reports the lane', async () => {
  let seenAuthorization;
  const handler = createRealtimeTokenHandler({
    resolveApiKey: () => ({ token: 'codex-access-fixture', source: 'codex-oauth' }),
    fetchImpl: async (endpoint, init) => {
      seenAuthorization = init.headers.Authorization;
      return {
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        text: async () => JSON.stringify({ value: 'ek_ephemeral', expires_at: 0 }),
      };
    },
  });
  const res = mockRes();
  await handler(mockReq(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(seenAuthorization, 'Bearer codex-access-fixture');
  assert.equal(res.headers.get('x-gev-voice-auth'), 'codex-oauth');
});

test('handler still accepts a legacy plain-string resolver', async () => {
  let seenAuthorization;
  const handler = createRealtimeTokenHandler({
    resolveApiKey: () => 'sk-legacy-fixture',
    fetchImpl: async (endpoint, init) => {
      seenAuthorization = init.headers.Authorization;
      return {
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        text: async () => JSON.stringify({ value: 'ek_ephemeral', expires_at: 0 }),
      };
    },
  });
  const res = mockRes();
  await handler(mockReq(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(seenAuthorization, 'Bearer sk-legacy-fixture');
  assert.equal(res.headers.get('x-gev-voice-auth'), 'env');
});
