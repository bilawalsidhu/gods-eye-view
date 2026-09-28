import assert from 'node:assert/strict';
import test from 'node:test';

import {
  credentialReference,
  parseBwsProjectSecrets,
  parseBwsSecretObject,
  resolveCredentialEnvironment,
} from '../server/credentials/resolve.mjs';

test('recognizes Proton Pass and BWS references only', () => {
  assert.deepEqual(credentialReference('pass://GEV/OpenAI/password'), {
    provider: 'proton-pass',
    reference: 'pass://GEV/OpenAI/password',
  });
  assert.deepEqual(credentialReference('bws://1234-abcd'), {
    provider: 'bws',
    secretId: '1234-abcd',
  });
  assert.equal(credentialReference('sk-live-literal'), null);
  assert.equal(credentialReference('bws://'), null);
});

test('parses BWS object and filters project secrets to the allowlist', () => {
  assert.equal(parseBwsSecretObject('{"value":"secret-value"}'), 'secret-value');
  assert.deepEqual(
    parseBwsProjectSecrets(
      JSON.stringify([
        { key: 'OPENAI_API_KEY', value: 'openai' },
        { key: 'UNRELATED', value: 'ignore-me' },
        { key: 'TOMTOM_API_KEY', value: 'tomtom' },
      ]),
      ['OPENAI_API_KEY', 'TOMTOM_API_KEY'],
    ),
    { OPENAI_API_KEY: 'openai', TOMTOM_API_KEY: 'tomtom' },
  );
});

test('literal env wins over manager references', () => {
  const env = {
    OPENAI_API_KEY: 'literal',
    GEV_SECRET_OPENAI_API_KEY: 'pass://GEV/OpenAI/password',
  };
  const calls = [];
  resolveCredentialEnvironment({
    env,
    runCommand(command, args) {
      calls.push([command, args]);
      return 'should-not-run';
    },
  });
  assert.equal(env.OPENAI_API_KEY, 'literal');
  assert.deepEqual(calls, []);
});

test('resolves Proton Pass companion references without persistence', () => {
  const env = { GEV_SECRET_OPENAI_API_KEY: 'pass://GEV/OpenAI/password' };
  const calls = [];
  const result = resolveCredentialEnvironment({
    env,
    runCommand(command, args) {
      calls.push([command, args]);
      return 'sk-from-proton\n';
    },
  });
  assert.equal(env.OPENAI_API_KEY, 'sk-from-proton');
  assert.deepEqual(calls, [
    ['pass-cli', ['item', 'view', 'pass://GEV/OpenAI/password']],
  ]);
  assert.equal(result.resolved.OPENAI_API_KEY, 'proton-pass');
});

test('resolves direct BWS references through secret get', () => {
  const env = { TOMTOM_API_KEY: 'bws://secret-uuid' };
  const calls = [];
  const result = resolveCredentialEnvironment({
    env,
    runCommand(command, args) {
      calls.push([command, args]);
      return JSON.stringify({ value: 'tomtom-from-bws' });
    },
  });
  assert.equal(env.TOMTOM_API_KEY, 'tomtom-from-bws');
  assert.deepEqual(calls, [
    ['bws', ['secret', 'get', 'secret-uuid', '--output', 'json']],
  ]);
  assert.equal(result.resolved.TOMTOM_API_KEY, 'bws');
});

test('BWS project fills only missing registered provider keys', () => {
  const env = {
    GEV_BWS_PROJECT_ID: 'project-uuid',
    OPENAI_API_KEY: 'explicit-openai',
  };
  const calls = [];
  const result = resolveCredentialEnvironment({
    env,
    runCommand(command, args) {
      calls.push([command, args]);
      return JSON.stringify([
        { key: 'OPENAI_API_KEY', value: 'must-not-overwrite' },
        { key: 'AISSTREAM_API_KEY', value: 'ais-from-bws' },
        { key: 'PATH', value: '/evil' },
      ]);
    },
  });
  assert.equal(env.OPENAI_API_KEY, 'explicit-openai');
  assert.equal(env.AISSTREAM_API_KEY, 'ais-from-bws');
  assert.equal(env.PATH, undefined);
  assert.deepEqual(calls, [
    ['bws', ['secret', 'list', 'project-uuid', '--output', 'json']],
  ]);
  assert.equal(result.resolved.AISSTREAM_API_KEY, 'bws');
});

test('manager failures do not require exposing command output', () => {
  const env = { GEV_SECRET_OPENAI_API_KEY: 'pass://GEV/OpenAI/password' };
  assert.throws(
    () =>
      resolveCredentialEnvironment({
        env,
        runCommand() {
          throw new Error('pass-cli failed while resolving credentials');
        },
      }),
    /pass-cli failed while resolving credentials/,
  );
});
