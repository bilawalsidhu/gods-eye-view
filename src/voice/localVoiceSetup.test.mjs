import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  hfCacheDirName,
  isHuggingFaceRepo,
  parsePipelineStages,
  patchLocalAiBackendSource,
  patchTokenizerSource,
  readProfile,
  setupLocalVoice,
  weightsPresent,
} from '../../scripts/setup-local-voice.mjs';

const BACKEND_FIXTURE = `            if enable_thinking == "true":
                kwargs["enable_thinking"] = True
`;

test('LocalAI compatibility patch honors thinking=false', () => {
  const patched = patchLocalAiBackendSource(BACKEND_FIXTURE);
  assert.match(patched, /enable_thinking in \{"true", "false"\}/);
  assert.equal(patchLocalAiBackendSource(patched), patched, 'patch must be idempotent');
});

test('MLX-LM compatibility patch registers the MiniCPM5 parser once', () => {
  const source = `    elif "<arg_key>" in chat_template:
        return "glm47"
    elif "<|tool_list_start|>" in chat_template:
        return "pythonic"
`;
  const patched = patchTokenizerSource(source);
  assert.match(patched, /return "minicpm5"/);
  assert.equal(patchTokenizerSource(patched), patched, 'patch must be idempotent');
});

test('LocalAI compatibility patch skips the thinking fix when upstream already honors false', () => {
  const upstream = BACKEND_FIXTURE.replace(
    `            if enable_thinking == "true":
                kwargs["enable_thinking"] = True`,
    `            if enable_thinking in ("true", "false"):
                kwargs["enable_thinking"] = enable_thinking == "true"`,
  );
  const patched = patchLocalAiBackendSource(upstream);
  assert.match(patched, /enable_thinking in \("true", "false"\)/);
  assert.doesNotMatch(patched, /enable_thinking in \{"true", "false"\}/);
});

test('weights are detected through the Hugging Face cache layout', () => {
  const repoId = 'acme/Fake-Model-MLX';
  assert.equal(hfCacheDirName(repoId), 'models--acme--Fake-Model-MLX');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-localai-'));
  try {
    assert.equal(weightsPresent(root, repoId), false, 'an empty models directory has no weights');

    const snapshot = path.join(root, hfCacheDirName(repoId), 'snapshots', 'abc123');
    fs.mkdirSync(snapshot, { recursive: true });
    fs.writeFileSync(path.join(snapshot, 'config.json'), '{}');
    assert.equal(weightsPresent(root, repoId), false, 'config without weights is an unfinished download');

    fs.writeFileSync(path.join(snapshot, 'model.safetensors'), 'x');
    assert.equal(weightsPresent(root, repoId), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the installer derives backends, gallery models and weights from the profile', () => {
  const profile = readProfile();
  assert.deepEqual(Object.keys(profile.stages).sort(), ['llm', 'transcription', 'tts', 'vad']);
  for (const backend of ['opus', 'mlx', 'whisper', 'parakeet-cpp', 'kokoro']) {
    assert.ok(profile.backends.includes(backend), `${backend} is installed for this profile`);
  }
  assert.deepEqual(profile.gallery, ['silero-vad-ggml', 'parakeet-cpp-realtime_eou_120m-v1', 'kokoro']);
  assert.deepEqual(profile.weights, [{ name: 'minicpm5-2b-mlx', repoId: 'openbmb/MiniCPM5-2B-MLX' }]);
});

test('swapping a pipeline stage needs no code edit', () => {
  const stages = parsePipelineStages([
    'name: gpt-realtime',
    'pipeline:',
    '  vad: silero-vad-ggml',
    '  transcription: whisper-large',
    '  llm: qwen3-4b-mlx',
    '  tts: kokoro',
    '',
    '  streaming:',
    '    llm: true',
    '',
    'other_top_level: ignored',
  ].join('\n'));
  assert.deepEqual(stages, {
    vad: 'silero-vad-ggml',
    transcription: 'whisper-large',
    llm: 'qwen3-4b-mlx',
    tts: 'kokoro',
  });
});

test('Hub repos are told apart from gallery weight files', () => {
  assert.equal(isHuggingFaceRepo('openbmb/MiniCPM5-2B-MLX'), true);
  assert.equal(isHuggingFaceRepo('parakeet-cpp/realtime_eou_120m-v1-f16.gguf'), false);
  assert.equal(isHuggingFaceRepo('ggml-silero-v5.1.2.bin'), false);
  assert.equal(isHuggingFaceRepo(null), false);
});

test('a profile with no mlx stage installs off Apple Silicon', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-profile-'));
  const models = path.join(root, 'models');
  fs.mkdirSync(models, { recursive: true });
  fs.writeFileSync(path.join(models, 'gpt-realtime.yaml'), [
    'name: gpt-realtime',
    'pipeline:',
    '  vad: silero-vad-ggml',
    '  transcription: whisper-large',
    '  llm: my-gguf-llm',
    '  tts: kokoro',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(models, 'my-gguf-llm.yaml'), [
    'name: my-gguf-llm',
    'backend: llama-cpp',
    'parameters:',
    '  model: my-model-Q4_K_M.gguf',
    '',
  ].join('\n'));

  try {
    const profile = readProfile(root);
    assert.deepEqual(profile.backends, ['opus', 'llama-cpp'], 'only the backends the stages name');
    assert.deepEqual(profile.gallery, ['silero-vad-ggml', 'whisper-large', 'my-gguf-llm', 'kokoro']);
    assert.deepEqual(profile.weights, [], 'a local weight file is not a Hub download');

    // The Apple Silicon gate belongs to the mlx stage, not to local voice.
    assert.throws(
      () => setupLocalVoice({
        profileDir: root,
        platform: 'linux',
        architecture: 'x64',
        checkOnly: true,
        environment: { GEV_LOCAL_AI_HOME: path.join(root, 'localai') },
      }),
      /setup incomplete/,
    );

    const installedModels = path.join(root, 'localai', 'models');
    fs.mkdirSync(installedModels, { recursive: true });
    for (const name of fs.readdirSync(models)) {
      fs.copyFileSync(path.join(models, name), path.join(installedModels, name));
    }
    assert.equal(
      setupLocalVoice({
        profileDir: root,
        platform: 'linux',
        architecture: 'x64',
        checkOnly: true,
        environment: { GEV_LOCAL_AI_HOME: path.join(root, 'localai') },
      }).ready,
      true,
    );

    fs.appendFileSync(path.join(installedModels, 'gpt-realtime.yaml'), '# stale\n');
    assert.throws(
      () => setupLocalVoice({
        profileDir: root,
        platform: 'linux',
        architecture: 'x64',
        checkOnly: true,
        environment: { GEV_LOCAL_AI_HOME: path.join(root, 'localai') },
      }),
      /model config gpt-realtime\.yaml/,
      'readiness must reject an installed config from an older profile revision',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
