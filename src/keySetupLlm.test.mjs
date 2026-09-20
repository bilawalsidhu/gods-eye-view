import test from 'node:test';
import assert from 'node:assert/strict';
import { collectLlmUpdates, llmProbeLine, llmSummaryLine } from './keySetup.js';
import { LLM_ENV_VARS, llmSettingsStatus } from './llmSettings.mjs';

const field = (envVar, value, initial, managed = null) => ({
  envVar,
  value,
  initial,
  managed,
});

test('only changed local-LLM settings are saved, so defaults stay defaults', () => {
  assert.deepEqual(
    collectLlmUpdates([
      field(LLM_ENV_VARS.provider, 'openai', 'openai'),
      field(
        LLM_ENV_VARS.baseUrl,
        'https://api.openai.com',
        'https://api.openai.com',
      ),
      field(LLM_ENV_VARS.model, '', ''),
    ]),
    {},
    'an untouched panel writes nothing',
  );
  assert.deepEqual(
    collectLlmUpdates([
      field(LLM_ENV_VARS.provider, 'ollama', 'openai'),
      field(
        LLM_ENV_VARS.baseUrl,
        '  http://localhost:11434 ',
        'https://api.openai.com',
      ),
      field(LLM_ENV_VARS.model, 'llama3.1:8b', ''),
    ]),
    {
      [LLM_ENV_VARS.provider]: 'ollama',
      [LLM_ENV_VARS.baseUrl]: 'http://localhost:11434',
      [LLM_ENV_VARS.model]: 'llama3.1:8b',
    },
  );
});

test('clearing a field is a removal, and external values are never rewritten', () => {
  assert.deepEqual(
    collectLlmUpdates([field(LLM_ENV_VARS.model, '  ', 'llama3.1:8b')]),
    { [LLM_ENV_VARS.model]: null },
    'empty means "back to the default", which the store expresses as a removal',
  );
  assert.deepEqual(
    collectLlmUpdates([
      field(
        LLM_ENV_VARS.baseUrl,
        'http://elsewhere:1',
        'http://localhost:11434',
        'external',
      ),
      field(LLM_ENV_VARS.model, 'qwen2.5', '', 'file'),
    ]),
    { [LLM_ENV_VARS.model]: 'qwen2.5' },
  );
  assert.deepEqual(collectLlmUpdates([]), {});
  assert.deepEqual(collectLlmUpdates(null), {});
  assert.deepEqual(collectLlmUpdates([null, { value: 'orphan' }]), {});
});

test('the panel line never claims voice works on a local model', () => {
  const local = llmSummaryLine(
    llmSettingsStatus({ [LLM_ENV_VARS.provider]: 'ollama' }),
  );
  assert.match(local, /OLLAMA at http:\/\/localhost:11434/);
  assert.match(local, /Voice control stays on OpenAI/);
  assert.match(local, /cannot serve the Realtime speech API/);

  const hosted = llmSummaryLine(
    llmSettingsStatus({ OPENAI_API_KEY: 'sk-test' }),
  );
  assert.match(hosted, /OPENAI runs the AI HUD summary and voice control/);
  assert.match(
    llmSummaryLine(llmSettingsStatus({})),
    /add OPENAI_API_KEY above/,
  );
  assert.equal(llmSummaryLine(null), '');
});

test('the probe line reports reachability and models without hiding a failure', () => {
  assert.match(
    llmProbeLine({
      reachable: false,
      error: 'connect ECONNREFUSED',
      probed: { endpoint: 'http://localhost:11434/api/tags' },
    }),
    /^UNREACHABLE · connect ECONNREFUSED \(http:\/\/localhost:11434\/api\/tags\)\. Nothing else is affected\.$/,
  );
  assert.match(
    llmProbeLine({
      reachable: true,
      models: ['llama3.1:8b'],
      probed: { endpoint: 'http://localhost:11434/api/tags' },
    }),
    /^REACHABLE · 1 model: llama3\.1:8b$/,
  );
  assert.match(
    llmProbeLine({
      reachable: true,
      models: Array.from({ length: 9 }, (_, i) => `m${i}`),
      probed: {},
    }),
    /^REACHABLE · 9 models: m0, m1, m2, m3, m4, m5 …$/,
  );
  assert.match(
    llmProbeLine({
      reachable: true,
      models: [],
      probed: { baseUrl: 'http://box:8080' },
    }),
    /answered but listed no models/,
  );
  assert.match(llmProbeLine(undefined), /^UNREACHABLE · no answer/);
});

test('the save endpoint accepts the LLM settings and refuses a bad one', async () => {
  const { knownKeySetupEnvVars, keySetupStatus, validateKeySetupUpdates } =
    await import('./keySetupCore.mjs');
  for (const name of Object.values(LLM_ENV_VARS)) {
    assert.equal(knownKeySetupEnvVars().has(name), true, name);
  }
  assert.deepEqual(
    validateKeySetupUpdates({
      [LLM_ENV_VARS.provider]: 'ollama',
      [LLM_ENV_VARS.baseUrl]: 'http://localhost:11434',
      [LLM_ENV_VARS.model]: 'llama3.1:8b',
    }),
    {
      ok: true,
      updates: {
        [LLM_ENV_VARS.provider]: 'ollama',
        [LLM_ENV_VARS.baseUrl]: 'http://localhost:11434',
        [LLM_ENV_VARS.model]: 'llama3.1:8b',
      },
    },
  );
  assert.deepEqual(validateKeySetupUpdates({ [LLM_ENV_VARS.provider]: null }), {
    ok: true,
    updates: { [LLM_ENV_VARS.provider]: null },
  });
  assert.match(
    validateKeySetupUpdates({ [LLM_ENV_VARS.provider]: 'anthropic' }).error,
    /must be one of/,
  );
  assert.match(
    validateKeySetupUpdates({ [LLM_ENV_VARS.baseUrl]: 'ftp://box:1' }).error,
    /http\(s\) URL/,
  );
  // A shorthand is saved in its canonical form, so what the panel shows back
  // is exactly what the proxy will call.
  assert.deepEqual(
    validateKeySetupUpdates({ [LLM_ENV_VARS.baseUrl]: 'localhost:11434/' })
      .updates,
    { [LLM_ENV_VARS.baseUrl]: 'http://localhost:11434' },
  );
  // The LLM block rides along with the key registry but changes no count.
  const status = keySetupStatus({ [LLM_ENV_VARS.provider]: 'ollama' });
  assert.equal(status.llm.provider, 'ollama');
  assert.equal(status.setCount, 0);
  assert.equal(status.total, keySetupStatus({}).total);
});
