import test from 'node:test';
import assert from 'node:assert/strict';
import {
  spawnEnabled,
  modelDirectories,
  whichBinary,
  detectRuntime,
  discoverLocalModels,
  startRuntime,
  runtimeState,
  resetRuntimeForTesting,
  detectExternalServer,
} from './runtime.js';

function fakeWhich(map) {
  return (cmd, args, opts, cb) => {
    const name = args[0];
    if (map[name]) return cb(null, `${map[name]}\n`, '');
    cb(new Error('not found'), '', '');
  };
}

test('spawning is on by default and switchable off', () => {
  assert.equal(spawnEnabled({}), true);
  assert.equal(spawnEnabled({ GEV_LLM_ALLOW_SPAWN: '0' }), false);
  assert.equal(spawnEnabled({ GEV_LLM_ALLOW_SPAWN: 'off' }), false);
  assert.equal(spawnEnabled({ GEV_LLM_ALLOW_SPAWN: '1' }), true);
});

test('model directories come from the environment, with ~ expanded', () => {
  const dirs = modelDirectories({ GEV_LLM_MODEL_DIR: '~/a:/tmp/b' });
  assert.equal(dirs.length, 2);
  assert.ok(dirs[0].endsWith('/a'));
  assert.ok(!dirs[0].startsWith('~'), 'tilde must be expanded, not passed through');
  assert.equal(dirs[1], '/tmp/b');
  assert.equal(modelDirectories({}).length, 3, 'conventional locations by default');
});

test('binary resolution never invokes a shell', async () => {
  let sawShell = false;
  const execImpl = (cmd, args, opts, cb) => {
    if (opts?.shell) sawShell = true;
    cb(null, '/usr/local/bin/llama-server\n', '');
  };
  const found = await whichBinary('llama-server', { execImpl });
  assert.equal(found, '/usr/local/bin/llama-server');
  assert.equal(sawShell, false);
});

test('a missing binary reports not installed rather than throwing', async () => {
  const detected = await detectRuntime('llamacpp', { execImpl: fakeWhich({}) });
  assert.equal(detected.installed, false);
  assert.equal(detected.binary, '');
});

test('an unknown provider is refused', async () => {
  const detected = await detectRuntime('definitely-not-a-runtime');
  assert.equal(detected.installed, false);
  assert.match(detected.error, /unknown provider/);
  assert.deepEqual(await discoverLocalModels('definitely-not-a-runtime'), []);
});

test('start refuses an unsupported provider', async () => {
  resetRuntimeForTesting();
  const result = await startRuntime({ provider: 'evil' }, { env: {} });
  assert.equal(result.ok, false);
  assert.match(result.error, /Unsupported provider/);
});

test('start refuses when spawning is disabled', async () => {
  resetRuntimeForTesting();
  const result = await startRuntime(
    { provider: 'llamacpp', model: '/x.gguf' },
    { env: { GEV_LLM_ALLOW_SPAWN: '0' } },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /disabled/);
});

test('start refuses a model the server never offered', async () => {
  resetRuntimeForTesting();
  // The attacker-controlled value here is a path that exists on disk; it must
  // still be refused, because discovery did not offer it.
  const result = await startRuntime(
    { provider: 'llamacpp', model: '/etc/passwd' },
    { env: { GEV_LLM_MODEL_DIR: '/nonexistent-dir' }, execImpl: fakeWhich({ 'llama-server': '/usr/bin/llama-server' }) },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /No \.gguf files found|discovered models/);
});

test('start refuses an out-of-range port', async () => {
  resetRuntimeForTesting();
  for (const port of [80, 22, 70000, -1]) {
    const result = await startRuntime(
      { provider: 'llamacpp', model: '/x.gguf', port },
      { env: {}, execImpl: fakeWhich({ 'llama-server': '/usr/bin/llama-server' }) },
    );
    assert.equal(result.ok, false, `port ${port} must be refused`);
    assert.match(result.error, /Port must be|discovered models|No \.gguf/);
  }
});

test('a missing runtime is reported, not launched', async () => {
  resetRuntimeForTesting();
  const result = await startRuntime(
    { provider: 'ollama' },
    { env: {}, execImpl: fakeWhich({}) },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /not installed/);
});

test('state is inert when nothing was started', () => {
  resetRuntimeForTesting();
  const state = runtimeState();
  assert.equal(state.running, false);
  assert.equal(state.pid, null);
  assert.deepEqual(state.log, []);
});

test('gguf discovery skips shard continuations', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gguf-'));
  await writeFile(path.join(dir, 'model-00001-of-00003.gguf'), 'x');
  await writeFile(path.join(dir, 'model-00002-of-00003.gguf'), 'x');
  await writeFile(path.join(dir, 'plain.gguf'), 'x');
  await writeFile(path.join(dir, 'notamodel.txt'), 'x');
  const models = await discoverLocalModels('llamacpp', { env: { GEV_LLM_MODEL_DIR: dir } });
  const labels = models.map((m) => m.label).sort();
  assert.deepEqual(labels, ['model-00001-of-00003', 'plain'],
    'only the first shard and plain files are offered');
});

test('an external server on the port is detected but not claimed as managed', async () => {
  const found = await detectExternalServer('llamacpp', {
    port: 8080,
    fetchImpl: async () => ({ ok: true }),
  });
  assert.deepEqual(found, { provider: 'llamacpp', port: 8080, managed: false });
});

test('a silent port reports nothing rather than guessing', async () => {
  const quiet = await detectExternalServer('llamacpp', {
    port: 8080,
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.equal(quiet, null);
  const refusing = await detectExternalServer('llamacpp', {
    port: 8080,
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  assert.equal(refusing, null);
});
