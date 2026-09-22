import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import path from 'node:path';
import {
  codexAuthPath,
  readCodexOAuthAccessToken,
  resolveCodexExecutable,
  startCodexChatGptLogin,
} from '../server/providers/openai/codex-auth.js';

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

test('Codex OAuth token reader returns only the access token and fails closed', () => {
  assert.equal(
    readCodexOAuthAccessToken({
      authPath: '/unused',
      readFile: () => JSON.stringify({ tokens: { access_token: ' oauth-fixture ' } }),
    }),
    'oauth-fixture',
  );
  for (const readFile of [
    () => '{bad json',
    () => JSON.stringify({ tokens: {} }),
    () => {
      throw new Error('missing');
    },
  ]) {
    assert.throws(
      () => readCodexOAuthAccessToken({ authPath: '/unused', readFile }),
      /ChatGPT sign-in is unavailable/,
    );
  }
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
