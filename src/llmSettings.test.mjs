import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LLM_ENV_VARS,
  LLM_PROVIDERS,
  isPrivateLlmHostname,
  isProbeableLlmBaseUrl,
  llmEndpointUrl,
  llmProviderDescriptor,
  llmSettingProblem,
  llmSettingsStatus,
  normalizeLlmBaseUrl,
  normalizeLlmProvider,
  parseLlmModelList,
  resolveLlmSettings,
} from './llmSettings.mjs';

test('an unset, unknown, or hostile provider resolves to hosted OpenAI', () => {
  for (const value of [
    undefined,
    '',
    '   ',
    'gpt4all',
    '../../etc/passwd',
    null,
    {},
  ]) {
    assert.equal(normalizeLlmProvider(value), 'openai');
  }
  assert.equal(resolveLlmSettings({}).provider, 'openai');
  assert.equal(resolveLlmSettings({}).requiresKey, true);
  assert.equal(
    resolveLlmSettings({ [LLM_ENV_VARS.provider]: 'gpt4all' }).providerFallback,
    true,
  );
  assert.equal(resolveLlmSettings({}).providerFallback, false);
});

test('the product spellings people actually type reach the right backend', () => {
  for (const value of ['llamacpp', 'llama.cpp', 'LLAMA-CPP', ' llama_cpp ']) {
    assert.equal(llmProviderDescriptor(value)?.id, 'llamacpp');
  }
  assert.equal(llmProviderDescriptor('OLLAMA')?.id, 'ollama');
  assert.equal(llmProviderDescriptor('anthropic'), null);
});

test('local providers default to their documented ports and need no key', () => {
  const ollama = resolveLlmSettings({ [LLM_ENV_VARS.provider]: 'ollama' });
  assert.equal(ollama.baseUrl, 'http://localhost:11434');
  assert.equal(ollama.modelsUrl, 'http://localhost:11434/api/tags');
  assert.equal(ollama.chatUrl, 'http://localhost:11434/v1/chat/completions');
  assert.equal(ollama.requiresKey, false);
  assert.equal(ollama.configured, true, 'a local backend needs no credential');

  const llamacpp = resolveLlmSettings({ [LLM_ENV_VARS.provider]: 'llamacpp' });
  assert.equal(llamacpp.baseUrl, 'http://localhost:8080');
  assert.equal(llamacpp.modelsUrl, 'http://localhost:8080/v1/models');
  assert.equal(llamacpp.chatUrl, 'http://localhost:8080/v1/chat/completions');
});

test('hosted OpenAI is only "configured" with a key; local never carries one', () => {
  assert.equal(resolveLlmSettings({}).configured, false);
  assert.equal(resolveLlmSettings({ OPENAI_API_KEY: 'sk-x' }).configured, true);
  const local = resolveLlmSettings({
    [LLM_ENV_VARS.provider]: 'ollama',
    OPENAI_API_KEY: 'sk-x',
  });
  assert.equal(local.requiresKey, false);
  assert.equal(local.apiKeyPresent, true, 'presence is still reported');
  assert.ok(!Object.values(local).includes('sk-x'), 'never echoes the key');
});

test('voice is advertised only where the Realtime API actually exists', () => {
  const byId = Object.fromEntries(
    LLM_PROVIDERS.map((provider) => [provider.id, provider]),
  );
  assert.equal(byId.openai.capabilities.realtimeVoice, true);
  assert.equal(byId.ollama.capabilities.realtimeVoice, false);
  assert.equal(byId.llamacpp.capabilities.realtimeVoice, false);
  for (const provider of LLM_PROVIDERS) {
    assert.equal(provider.capabilities.text, true);
  }
  assert.equal(byId.ollama.capabilities.toolCalling, 'model-dependent');
});

test('base URLs normalize, and unusable ones become empty rather than partial', () => {
  assert.equal(
    normalizeLlmBaseUrl('http://localhost:11434/'),
    'http://localhost:11434',
  );
  assert.equal(
    normalizeLlmBaseUrl('localhost:11434'),
    'http://localhost:11434',
  );
  assert.equal(
    normalizeLlmBaseUrl(' http://box.local:8080//v1// '),
    'http://box.local:8080/v1',
  );
  assert.equal(
    normalizeLlmBaseUrl('https://example.test'),
    'https://example.test',
  );
  for (const bad of [
    '',
    'file:///etc/passwd',
    'ftp://host',
    'http://user:pass@localhost:11434',
    'http://localhost:11434?x=1',
    'http://localhost:11434#f',
    'not a url',
  ]) {
    assert.equal(normalizeLlmBaseUrl(bad), '', bad);
  }
});

test('only this machine or this LAN may be probed from the panel', () => {
  for (const host of [
    'localhost',
    '127.0.0.1',
    '127.5.5.5',
    '::1',
    '10.0.0.4',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.10',
    '169.254.1.1',
    'fd00::1',
    'fe80::1',
    'workstation',
    'box.local',
  ]) {
    assert.equal(isPrivateLlmHostname(host), true, host);
  }
  for (const host of [
    '',
    '8.8.8.8',
    '172.32.0.1',
    '172.15.0.1',
    '999.1.1.1',
    'api.openai.com',
    '2606:4700::1111',
  ]) {
    assert.equal(isPrivateLlmHostname(host), false, host);
  }
  assert.equal(isProbeableLlmBaseUrl('http://localhost:11434'), true);
  assert.equal(isProbeableLlmBaseUrl('https://api.openai.com'), false);
  assert.equal(isProbeableLlmBaseUrl('http://169.254.169.254/latest'), true);
  assert.equal(isProbeableLlmBaseUrl('nonsense'), true, 'bare LAN name');
  assert.equal(isProbeableLlmBaseUrl('http://evil.example.com'), false);
});

test('endpoint joining never doubles or drops a slash', () => {
  assert.equal(
    llmEndpointUrl('http://localhost:8080/', 'v1/models'),
    'http://localhost:8080/v1/models',
  );
  assert.equal(
    llmEndpointUrl('http://localhost:8080/gw', '/v1/models'),
    'http://localhost:8080/gw/v1/models',
  );
  assert.equal(llmEndpointUrl('', '/v1/models'), '');
});

test('model discovery reads both dialects and refuses junk', () => {
  assert.deepEqual(
    parseLlmModelList('ollama', {
      models: [{ name: 'llama3.1:8b' }, { name: 'qwen2.5:7b' }],
    }),
    ['llama3.1:8b', 'qwen2.5:7b'],
  );
  assert.deepEqual(
    parseLlmModelList('llamacpp', { data: [{ id: 'gguf-model' }] }),
    ['gguf-model'],
  );
  assert.deepEqual(parseLlmModelList('ollama', { data: [{ id: 'x' }] }), []);
  assert.deepEqual(parseLlmModelList('llamacpp', null), []);
  assert.deepEqual(parseLlmModelList('llamacpp', { data: 'nope' }), []);
  assert.deepEqual(
    parseLlmModelList('llamacpp', {
      data: [{ id: 'a' }, { id: 'a' }, { id: '  ' }, { id: 'b'.repeat(500) }],
    }),
    ['a'],
  );
  assert.equal(
    parseLlmModelList('llamacpp', {
      data: Array.from({ length: 500 }, (_, i) => ({ id: `m${i}` })),
    }).length,
    100,
  );
});

test('a typo is refused at save time, not discovered after a restart', () => {
  assert.equal(llmSettingProblem(LLM_ENV_VARS.provider, 'ollama'), null);
  assert.match(
    llmSettingProblem(LLM_ENV_VARS.provider, 'anthropic'),
    /must be one of openai, ollama, llamacpp/,
  );
  assert.equal(
    llmSettingProblem(LLM_ENV_VARS.baseUrl, 'http://localhost:11434'),
    null,
  );
  assert.match(
    llmSettingProblem(LLM_ENV_VARS.baseUrl, 'file:///etc/passwd'),
    /http\(s\) URL/,
  );
  assert.equal(llmSettingProblem(LLM_ENV_VARS.model, 'llama3.1:8b'), null);
  assert.equal(llmSettingProblem('OPENAI_API_KEY', 'sk-x'), null);
});

test('the panel payload carries the stored values, the defaults, and no key', () => {
  const status = llmSettingsStatus({
    [LLM_ENV_VARS.provider]: 'ollama',
    [LLM_ENV_VARS.model]: 'qwen2.5:7b',
    OPENAI_API_KEY: 'sk-secret',
  });
  assert.equal(status.provider, 'ollama');
  assert.equal(status.baseUrl, 'http://localhost:11434');
  assert.equal(status.baseUrlSource, 'default');
  assert.equal(status.values[LLM_ENV_VARS.baseUrl], '');
  assert.equal(status.values[LLM_ENV_VARS.model], 'qwen2.5:7b');
  assert.equal(status.apiKeyPresent, true);
  assert.equal(status.providers.length, 3);
  assert.ok(status.notes.some((note) => /Realtime/.test(note)));
  assert.ok(!JSON.stringify(status).includes('sk-secret'));
});
