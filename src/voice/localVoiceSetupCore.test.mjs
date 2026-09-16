import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_VOICE_COMPATIBILITY,
  localVoiceActionLabel,
  localVoiceInstallPlan,
  localVoiceProgressLine,
  localVoiceRecommendationLine,
  localVoiceRowLabel,
  recommendLocalVoiceLlm,
} from './localVoiceSetupCore.mjs';

const PROFILE = Object.freeze({
  backends: ['opus', 'mlx'],
  gallery: ['silero-vad-ggml', 'kokoro'],
  weights: [{ name: 'minicpm5-2b-mlx', repoId: 'openbmb/MiniCPM5-2B-MLX' }],
  compatibility: [
    LOCAL_VOICE_COMPATIBILITY.mlxThinking,
    LOCAL_VOICE_COMPATIBILITY.minicpm5Parser,
  ],
});

test('the plan follows the profile, ending with the patches it needs', () => {
  const plan = localVoiceInstallPlan(PROFILE);
  assert.deepEqual(
    plan.map((step) => step.id),
    [
      'backend:opus',
      'backend:mlx',
      'model:silero-vad-ggml',
      'model:kokoro',
      'configs',
      'weights:minicpm5-2b-mlx',
      'compat:mlx-thinking',
      'compat:minicpm5-parser',
    ],
  );
  const qwenProfile = {
    backends: ['opus', 'mlx'],
    gallery: [],
    weights: [{ name: 'qwen', repoId: 'acme/Qwen-MLX' }],
    compatibility: [LOCAL_VOICE_COMPATIBILITY.mlxThinking],
  };
  for (const profile of [
    { backends: ['opus', 'llama-cpp'], gallery: ['my-llm'], weights: [] },
    qwenProfile,
  ]) {
    const plan = localVoiceInstallPlan(profile);
    assert.equal(
      plan.some(
        (step) => step.arg === LOCAL_VOICE_COMPATIBILITY.minicpm5Parser,
      ),
      false,
      'only MiniCPM receives its parser',
    );
  }
  assert.equal(
    localVoiceInstallPlan(qwenProfile).some(
      (step) => step.arg === LOCAL_VOICE_COMPATIBILITY.mlxThinking,
    ),
    true,
    'another MLX model still receives the generic thinking fix',
  );
});

test('a cached download stays visible as already done', () => {
  const plan = localVoiceInstallPlan(PROFILE, {
    cachedRepos: ['openbmb/MiniCPM5-2B-MLX'],
  });
  const weights = plan.find((step) => step.kind === 'weights');
  assert.equal(weights.cached, true);
  assert.match(weights.label, /already downloaded/);
});

test('progress reads as position, and as megabytes while weights arrive', () => {
  const steps = [
    {
      id: 'backend:opus',
      kind: 'backend',
      label: 'Install opus backend',
      state: 'done',
    },
    {
      id: 'weights:llm',
      kind: 'weights',
      label: 'Download openbmb/MiniCPM5-2B-MLX',
      state: 'running',
    },
    {
      id: 'compat',
      kind: 'compat',
      label: 'Apply MLX compatibility patches',
      state: 'pending',
    },
  ];
  assert.equal(
    localVoiceProgressLine({ state: 'running', steps, bytes: 412_000_000 }),
    'Download openbmb/MiniCPM5-2B-MLX — 412 MB (2/3)',
  );
  assert.equal(
    localVoiceProgressLine({
      state: 'running',
      steps: [{ ...steps[0], state: 'running' }],
      bytes: 999,
    }),
    'Install opus backend (1/1)',
    'only a download counts bytes',
  );
  assert.equal(
    localVoiceProgressLine({ state: 'done' }),
    'Local voice is installed',
  );
  assert.match(
    localVoiceProgressLine({ state: 'failed', error: 'exited with 1' }),
    /Install failed — exited with 1/,
  );
  assert.equal(localVoiceProgressLine({ state: 'idle' }), '');
});

test('the row says what it is, and the button says what it would do', () => {
  assert.equal(
    localVoiceRowLabel({ supported: false }),
    'NOT SUPPORTED ON THIS MACHINE',
  );
  assert.equal(
    localVoiceActionLabel({ supported: false }),
    null,
    'nothing to click',
  );
  assert.equal(localVoiceRowLabel({ ready: true }), 'READY');
  assert.equal(localVoiceActionLabel({ ready: true }), 'REINSTALL');
  assert.equal(localVoiceRowLabel({ state: 'running' }), 'INSTALLING');
  assert.equal(
    localVoiceActionLabel({ state: 'running' }),
    null,
    'no double-start',
  );
  assert.equal(localVoiceRowLabel({}), 'NOT INSTALLED');
  assert.equal(localVoiceActionLabel({}), 'INSTALL');
  assert.equal(localVoiceActionLabel({ state: 'failed' }), 'RETRY INSTALL');
});

test('Apple Silicon recommendation scales with unified memory', () => {
  const low = recommendLocalVoiceLlm({
    platform: 'darwin',
    architecture: 'arm64',
    totalMemoryBytes: 8 * 1024 ** 3,
  });
  assert.equal(low.selected, 'minicpm5-1b-mlx');
  assert.deepEqual(
    low.candidates.map(({ id, fits }) => [id, fits]),
    [
      ['minicpm5-1b-mlx', true],
      ['minicpm5-2b-mlx', false],
    ],
  );

  const roomy = recommendLocalVoiceLlm({
    platform: 'darwin',
    architecture: 'arm64',
    totalMemoryBytes: 16 * 1024 ** 3,
  });
  assert.equal(roomy.selected, 'minicpm5-2b-mlx');
  assert.equal(roomy.recommendation.label, 'MiniCPM5 2B · MLX 4-bit');
});

test('recommendation copy distinguishes automatic and manual model choices', () => {
  assert.equal(
    localVoiceRecommendationLine({
      model: { automatic: true, selected: 'minicpm5-2b-mlx' },
      recommendation: { label: 'MiniCPM5 2B · MLX 4-bit' },
      hardware: { totalMemoryGb: 16 },
    }),
    'RECOMMENDED · MiniCPM5 2B · MLX 4-bit · 16 GB unified memory',
  );
  assert.equal(
    localVoiceRecommendationLine({
      model: { automatic: false, selected: 'qwen3-4b-mlx' },
    }),
    'CUSTOM · qwen3-4b-mlx',
  );
});
