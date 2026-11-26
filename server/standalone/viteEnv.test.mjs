import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEnvFiles } from './vite.config.js';

test('a removed env-file key is unset on restart and a shell key is kept', () => {
  const key = Symbol.for('gev.standalone.envFileValues');
  const original = globalThis[key];
  delete globalThis[key];
  try {
    const env = { SHELL_ONLY: 'shell' };
    let files = { FILE_ONLY: '1', SHELL_ONLY: 'file' };
    const read = () => ({ ...files, ...env });
    applyEnvFiles(read, env);
    assert.deepEqual(env, { SHELL_ONLY: 'shell', FILE_ONLY: '1' });
    files = { SHELL_ONLY: 'file' };
    applyEnvFiles(read, env);
    assert.deepEqual(env, { SHELL_ONLY: 'shell' });
    files = { FILE_ONLY: '0' };
    applyEnvFiles(read, env);
    assert.equal(env.FILE_ONLY, '0');
  } finally {
    if (original === undefined) delete globalThis[key];
    else globalThis[key] = original;
  }
});
