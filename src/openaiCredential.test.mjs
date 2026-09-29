import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRealtimeTokenHandler } from '../server/providers/openai/realtime.js';
import {
  exchangeDeviceCode,
  requestDeviceCode,
  resolveOpenAiCredential,
  writeOAuthStore,
} from '../server/providers/openai/credential.js';

function jwt(exp) {
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return `aaa.${payload}.bbb`;
}

test('an API key beats a ChatGPT OAuth token', () => {
  const credential = resolveOpenAiCredential({
    env: {
      OPENAI_API_KEY: 'sk-fixture',
      OPENAI_OAUTH_ACCESS_TOKEN: jwt(9_999_999_999),
    },
    now: 1_000,
  });
  assert.equal(credential.source, 'api-key');
  assert.equal(credential.bearer, 'sk-fixture');
  assert.equal(credential.hud, true);
});

test('a ChatGPT OAuth access token is the Realtime bearer when no API key is set', () => {
  const token = jwt(5_000);
  const credential = resolveOpenAiCredential({
    env: { OPENAI_OAUTH_ACCESS_TOKEN: token },
    now: 1_000,
  });
  assert.equal(credential.source, 'oauth');
  assert.equal(credential.bearer, token);
  assert.equal(credential.hud, false);
});

test('an expired OAuth env token falls through to the GEV-owned store', () => {
  const stored = jwt(9_000);
  const credential = resolveOpenAiCredential({
    env: { OPENAI_OAUTH_ACCESS_TOKEN: jwt(500) },
    now: 1_000,
    readStore: () => ({ access_token: stored, expires_at: 9_000 }),
  });
  assert.equal(credential.bearer, stored);
  assert.equal(credential.source, 'oauth-file');
});

test('Realtime uses the OAuth bearer and does not require an API key', async () => {
  const token = jwt(9_000);
  let authorization = '';
  const handler = createRealtimeTokenHandler({
    resolveCredential: () => ({ bearer: token, source: 'oauth', hud: false }),
    fetchImpl: async (_url, options) => {
      authorization = options.headers.Authorization;
      return Response.json({ value: 'ek_fixture' });
    },
  });
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body) {
      this.body = body;
    },
  };
  await handler({ method: 'POST', url: '/' }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(authorization, `Bearer ${token}`);
  assert.equal(res.body.includes(token), false);
});

test('device-code login exchanges a code without printing tokens', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: options.body, json: options.json });
    if (String(url).endsWith('/usercode')) {
      return Response.json({
        user_code: 'ABCD-EFGH',
        device_auth_id: 'dev-1',
        interval: 1,
      });
    }
    return Response.json({
      access_token: jwt(9_000),
      refresh_token: 'refresh-fixture',
    });
  };
  const device = await requestDeviceCode({ fetchImpl });
  assert.equal(device.user_code, 'ABCD-EFGH');
  assert.equal(
    JSON.parse(calls[0].body).client_id,
    'app_EMoamEEZ73f0CkXaXp7hrann',
  );
  const tokens = await exchangeDeviceCode({
    fetchImpl,
    authorizationCode: 'code-1',
    codeVerifier: 'verifier-1',
  });
  assert.equal(tokens.refresh_token, 'refresh-fixture');
  assert.equal(String(calls[1].body).includes('refresh-fixture'), false);
});

test('the OAuth store is written mode 600 and is not an API key file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-oauth-'));
  const file = path.join(dir, 'openai-oauth.json');
  writeOAuthStore(file, {
    access_token: jwt(9_000),
    refresh_token: 'refresh-fixture',
    expires_at: 9_000,
  });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.refresh_token, 'refresh-fixture');
  assert.equal(saved.client, 'codex-public');
});
