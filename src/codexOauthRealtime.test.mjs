import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import path from 'node:path';
import {
  codexAuthPath,
  preferCodexOAuth,
  readCodexOAuthAccessToken,
  resolveCodexExecutable,
  startCodexChatGptLogin,
} from '../server/providers/openai/codex-auth.js';

const nowMs = Date.UTC(2026, 8, 27);
const jwt = (payload) =>
  `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
const auth = (token, extras = {}) =>
  JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: token, refresh_token: 'refresh-fixture' },
    ...extras,
  });

test('optional Codex OAuth pin fails closed on ambiguous values', () => {
  assert.equal(preferCodexOAuth({}), false);
  assert.equal(preferCodexOAuth({ GEV_PREFER_CODEX_OAUTH: 'true' }), true);
  assert.equal(preferCodexOAuth({ GEV_PREFER_CODEX_OAUTH: 'off' }), false);
  assert.throws(
    () => preferCodexOAuth({ GEV_PREFER_CODEX_OAUTH: 'maybe' }),
    /must be true or false/,
  );
});

test('Codex auth path follows explicit auth file, CODEX_HOME, then home directory', () => {
  assert.equal(
    codexAuthPath({
      environment: { CODEX_AUTH_JSON: '/tmp/custom-auth.json' },
      home: '/home/fixture',
    }),
    path.resolve('/tmp/custom-auth.json'),
  );
  assert.equal(
    codexAuthPath({
      environment: { CODEX_HOME: '/tmp/codex-home' },
      home: '/home/fixture',
    }),
    path.join(path.resolve('/tmp/codex-home'), 'auth.json'),
  );
  assert.equal(
    codexAuthPath({ environment: {}, home: '/home/fixture' }),
    path.join('/home/fixture', '.codex', 'auth.json'),
  );
});

test('Codex OAuth reader accepts a current ChatGPT token and rejects unusable credentials', () => {
  const current = jwt({ exp: nowMs / 1000 + 3600 });
  assert.equal(
    readCodexOAuthAccessToken({
      authPath: '/unused',
      nowMs,
      readFile: () => auth(current),
    }),
    current,
  );
  for (const readFile of [
    () => '{bad json',
    () => JSON.stringify({ tokens: {} }),
    () => auth(current, { auth_mode: 'apikey' }),
    () =>
      JSON.stringify({
        OPENAI_API_KEY: 'sk-fixture',
        tokens: { access_token: current, refresh_token: 'refresh-fixture' },
      }),
    () =>
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: current },
      }),
    () => auth('opaque-token'),
    () => auth('header.not-json.signature'),
    () => auth(jwt({ exp: 'tomorrow' })),
    () => {
      throw new Error('missing');
    },
  ]) {
    assert.throws(
      () => readCodexOAuthAccessToken({ authPath: '/unused', readFile, nowMs }),
      /ChatGPT sign-in is unavailable/,
    );
  }
});

test('Codex OAuth reader enforces expiry margin and bounds tokens without exp by file age', () => {
  for (const exp of [nowMs / 1000 - 1, nowMs / 1000 + 59]) {
    assert.throws(
      () =>
        readCodexOAuthAccessToken({
          authPath: '/unused',
          nowMs,
          readFile: () => auth(jwt({ exp })),
        }),
      /sign-in has expired/,
    );
  }
  const noExp = jwt({ sub: 'fixture' });
  const base = { authPath: '/unused', nowMs, readFile: () => auth(noExp) };
  assert.equal(
    readCodexOAuthAccessToken({
      ...base,
      statFile: () => ({ mtimeMs: nowMs }),
    }),
    noExp,
  );
  assert.throws(
    () =>
      readCodexOAuthAccessToken({
        ...base,
        statFile: () => ({ mtimeMs: nowMs - 3600_000 }),
      }),
    /sign-in has expired/,
  );
  assert.throws(
    () =>
      readCodexOAuthAccessToken({
        ...base,
        statFile: () => {
          throw new Error('missing');
        },
      }),
    /sign-in is unavailable/,
  );
});

test('Codex login resolves an installed executable before PATH and starts browser auth detached', async () => {
  const checked = [];
  assert.equal(
    resolveCodexExecutable({
      environment: {},
      home: '/home/fixture',
      access(candidate) {
        checked.push(candidate);
        if (candidate.endsWith('/.local/bin/codex')) return;
        throw new Error('missing');
      },
    }),
    path.join('/home/fixture', '.local', 'bin', 'codex'),
  );
  assert.equal(checked.length, 1);

  const child = new EventEmitter();
  let unref = 0;
  child.unref = () => {
    unref += 1;
  };
  const calls = [];
  const pending = startCodexChatGptLogin({
    executable: '/fixture/codex',
    home: '/home/fixture',
    environment: { PATH: '/fixture' },
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  assert.deepEqual(await pending, { executable: '/fixture/codex' });
  assert.equal(unref, 1);
  assert.equal(calls[0].command, '/fixture/codex');
  assert.deepEqual(calls[0].args, ['login']);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, 'ignore');
});
