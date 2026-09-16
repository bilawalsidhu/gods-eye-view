import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLocalVoiceInstaller } from '../../server/standalone/local-voice.js';

/** A profile with no mlx stage, so the fixture installs on any machine. */
function fixtureProfile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-install-'));
  const models = path.join(root, 'profile', 'models');
  fs.mkdirSync(models, { recursive: true });
  fs.writeFileSync(
    path.join(models, 'gpt-realtime.yaml'),
    [
      'name: gpt-realtime',
      'pipeline:',
      '  vad: silero-vad-ggml',
      '  transcription: whisper-large',
      '  llm: my-gguf-llm',
      '  tts: kokoro',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(models, 'my-gguf-llm.yaml'),
    [
      'name: my-gguf-llm',
      'backend: llama-cpp',
      'parameters:',
      '  model: my-model-Q4_K_M.gguf',
      '',
    ].join('\n'),
  );
  return {
    root,
    profileDir: path.join(root, 'profile'),
    home: path.join(root, 'localai'),
  };
}

function installerFor({ profileDir, home, exitCode = 0, calls = [] }) {
  return createLocalVoiceInstaller({
    environment: { GEV_LOCAL_AI_HOME: home, GEV_LOCAL_AI_BIN: '/opt/local-ai' },
    platform: 'linux',
    architecture: 'x64',
    profileDir,
    probeBinary: () => true,
    spawnImpl(command, args) {
      const child = new EventEmitter();
      calls.push(`${path.basename(command)} ${args.join(' ')}`);
      queueMicrotask(() => child.emit('exit', exitCode));
      return child;
    },
  });
}

async function settle(installer) {
  for (
    let tick = 0;
    tick < 500 && installer.status().state === 'running';
    tick += 1
  ) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
  return installer.status();
}

test('the in-app install runs the profile plan and flips the row to ready', async () => {
  const { root, profileDir, home } = fixtureProfile();
  const calls = [];
  try {
    const installer = installerFor({ profileDir, home, calls });
    const before = installer.status();
    assert.equal(
      before.supported,
      true,
      'a profile without mlx installs anywhere',
    );
    assert.equal(before.ready, false, 'nothing is installed yet');
    assert.equal(before.state, 'idle');

    assert.equal(installer.start().state, 'running');
    const done = await settle(installer);

    assert.equal(done.state, 'done', done.error);
    assert.deepEqual(
      done.steps.map((step) => step.state),
      done.steps.map(() => 'done'),
    );
    assert.deepEqual(calls, [
      'local-ai backends install opus',
      'local-ai backends install llama-cpp',
      'local-ai models install silero-vad-ggml',
      'local-ai models install whisper-large',
      'local-ai models install my-gguf-llm',
      'local-ai models install kokoro',
    ]);
    assert.ok(
      fs.existsSync(path.join(home, 'models', 'gpt-realtime.yaml')),
      'pipeline config copied',
    );
    assert.equal(done.ready, true, 'the check passes once the plan has run');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a failed step stops the run and reports which command failed', async () => {
  const { root, profileDir, home } = fixtureProfile();
  try {
    const installer = installerFor({ profileDir, home, exitCode: 1 });
    installer.start();
    const failed = await settle(installer);
    assert.equal(failed.state, 'failed');
    assert.match(failed.error, /exited with 1/);
    assert.equal(failed.steps[0].state, 'failed');
    assert.equal(
      failed.steps[1].state,
      'pending',
      'the run stops instead of grinding through',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an mlx profile off Apple Silicon is reported unsupported instead of attempted', () => {
  const installer = createLocalVoiceInstaller({
    environment: { GEV_LOCAL_AI_HOME: '/tmp/gev-unused' },
    platform: 'linux',
    architecture: 'x64',
    spawnImpl() {
      throw new Error('must not spawn');
    },
  });
  const status = installer.status();
  assert.equal(
    status.supported,
    false,
    'the shipped profile runs an mlx stage',
  );
  assert.equal(installer.start().state, 'failed');
  assert.match(installer.status().error, /Apple Silicon/);
});

test('a missing LocalAI names the one command that stays in the terminal', () => {
  const { root, profileDir, home } = fixtureProfile();
  try {
    const installer = createLocalVoiceInstaller({
      environment: { GEV_LOCAL_AI_HOME: home },
      platform: 'linux',
      architecture: 'x64',
      profileDir,
      probeBinary: () => false,
      spawnImpl() {
        throw new Error('must not spawn');
      },
    });
    assert.equal(installer.status().binary, false);
    assert.equal(installer.start().state, 'failed');
    assert.match(installer.status().error, /brew install localai/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the setup row recommends the model that fits this Mac', () => {
  const low = createLocalVoiceInstaller({
    environment: { GEV_LOCAL_AI_HOME: '/tmp/gev-unused-low' },
    platform: 'darwin',
    architecture: 'arm64',
    totalMemoryBytes: 8 * 1024 ** 3,
    probeBinary: () => false,
  }).status();
  assert.equal(low.model.automatic, true);
  assert.equal(low.model.selected, 'minicpm5-1b-mlx');
  assert.equal(low.recommendation.id, 'minicpm5-1b-mlx');

  const roomy = createLocalVoiceInstaller({
    environment: { GEV_LOCAL_AI_HOME: '/tmp/gev-unused-roomy' },
    platform: 'darwin',
    architecture: 'arm64',
    totalMemoryBytes: 16 * 1024 ** 3,
    probeBinary: () => false,
  }).status();
  assert.equal(roomy.model.selected, 'minicpm5-2b-mlx');
  assert.equal(roomy.recommendation.id, 'minicpm5-2b-mlx');
});
