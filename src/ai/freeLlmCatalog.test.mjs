import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FREE_LLM_PROVIDERS,
  findFreeLlmProvider,
  detectProviderFromKey,
  findProviderForModel,
  getAllProviders,
  getModelCapabilities,
  getModelsForCategory,
  NVIDIA_MODEL_REGISTRY,
  getEnvVarForProvider,
  getKeysForProvider,
  getFirstKeyForProvider,
  buildProviderCandidate,
  getAllActiveProviderCandidates,
  resolveActiveProviderId,
  getProviderKeyStatuses,
} from './freeLlmCatalog.js';

test('FREE_LLM_PROVIDERS exports all providers from awesome-free-llm-apis', () => {
  const ids = FREE_LLM_PROVIDERS.map((p) => p.id);
  assert.equal(ids.length, 15);
  assert.ok(ids.includes('nvidia'));
  assert.ok(ids.includes('local'));
  assert.ok(ids.includes('gemini'));
  assert.ok(ids.includes('groq'));
  assert.ok(ids.includes('mistral'));
  assert.ok(ids.includes('cerebras'));
  assert.ok(ids.includes('openrouter'));
  assert.ok(ids.includes('cohere'));
  assert.ok(ids.includes('aion'));
  assert.ok(ids.includes('zhipu'));
  assert.ok(ids.includes('sambanova'));
  assert.ok(ids.includes('together'));
  assert.ok(ids.includes('requesty'));
  assert.ok(ids.includes('cloudflare'));
  assert.ok(ids.includes('manifest'));
});

test('findFreeLlmProvider retrieves provider by ID or URL substring', () => {
  const groq = findFreeLlmProvider('groq');
  assert.equal(groq.id, 'groq');
  assert.ok(groq.baseUrl.includes('api.groq.com'));

  const gemini = findFreeLlmProvider('generativelanguage.googleapis.com');
  assert.equal(gemini.id, 'gemini');

  const cohere = findFreeLlmProvider('cohere');
  assert.equal(cohere.id, 'cohere');
});

test('detectProviderFromKey correctly identifies provider by key prefix', () => {
  assert.equal(detectProviderFromKey('nvapi-12345678').id, 'nvidia');
  assert.equal(detectProviderFromKey('AIzaSyDummyKey').id, 'gemini');
  assert.equal(detectProviderFromKey('gsk_groqKey123').id, 'groq');
  assert.equal(detectProviderFromKey('csk-cerebrasKey').id, 'cerebras');
  assert.equal(detectProviderFromKey('sk-or-v1-openrouter').id, 'openrouter');
  assert.equal(detectProviderFromKey('aion-sampleKey').id, 'aion');
});

test('getModelCapabilities identifies vision, reasoning, code, and speed models', () => {
  const vision = getModelCapabilities('meta/llama-3.2-11b-vision-instruct');
  assert.equal(vision.modality, 'multimodal');

  const reasoning = getModelCapabilities('deepseek-ai/deepseek-r1');
  assert.equal(reasoning.isReasoning, true);

  const code = getModelCapabilities('openai/gpt-oss-20b');
  assert.equal(code.isCode, true);
});

test('getModelsForCategory returns categorized models from registry', () => {
  const tactical = getModelsForCategory('tactical');
  assert.ok(tactical.length > 0);
  const genai = getModelsForCategory('genai');
  assert.ok(genai.length > 0);
});

test('findProviderForModel accurately identifies provider for various models', () => {
  assert.equal(findProviderForModel('gemini-2.5-flash')?.id, 'gemini');
  assert.equal(findProviderForModel('codestral-latest')?.id, 'mistral');
  assert.equal(findProviderForModel('command-r-plus-08-2024')?.id, 'cohere');
  assert.equal(findProviderForModel('cerebras/gpt-oss-120b')?.id, 'cerebras');
  assert.equal(findProviderForModel('groq/openai/gpt-oss-20b')?.id, 'groq');
  assert.equal(findProviderForModel('qwen/qwen3.8-27b')?.id, 'groq');
  assert.equal(findProviderForModel('nvidia/nemotron-3.5-lightning-30b-a3b')?.id, 'nvidia');
  assert.equal(findProviderForModel('meta-llama/llama-3.3-70b-instruct:free')?.id, 'openrouter');
  assert.equal(findProviderForModel('Meta-Llama-3.3-70B-Instruct')?.id, 'sambanova');
});

test('getEnvVarForProvider returns correct env var for each provider', () => {
  assert.equal(getEnvVarForProvider('nvidia'), 'NVIDIA_API_KEY');
  assert.equal(getEnvVarForProvider('groq'), 'GROQ_API_KEY');
  assert.equal(getEnvVarForProvider('gemini'), 'GEMINI_API_KEY');
  assert.equal(getEnvVarForProvider('cerebras'), 'CEREBRAS_API_KEY');
  assert.equal(getEnvVarForProvider('mistral'), 'MISTRAL_API_KEY');
  assert.equal(getEnvVarForProvider('cohere'), 'COHERE_API_KEY');
  assert.equal(getEnvVarForProvider('aion'), 'AION_API_KEY');
  assert.equal(getEnvVarForProvider('zhipu'), 'ZHIPU_API_KEY');
  assert.equal(getEnvVarForProvider('sambanova'), 'SAMBANOVA_API_KEY');
  assert.equal(getEnvVarForProvider('together'), 'TOGETHER_API_KEY');
  assert.equal(getEnvVarForProvider('requesty'), 'REQUESTY_API_KEY');
  assert.equal(getEnvVarForProvider('cloudflare'), 'CLOUDFLARE_API_KEY');
  assert.equal(getEnvVarForProvider('openrouter'), 'OPENROUTER_API_KEY');
  assert.equal(getEnvVarForProvider('manifest'), 'MANIFEST_API_KEY');
  assert.equal(getEnvVarForProvider('unknown'), null);
});

test('getKeysForProvider parses comma-separated keys from env', () => {
  const env = {
    NVIDIA_API_KEY: 'nvapi-key1, nvapi-key2 , nvapi-key3',
    GROQ_API_KEY: 'gsk_only',
    EMPTY_API_KEY: '',
    UNSET_API_KEY: undefined,
  };
  const nvidiaKeys = getKeysForProvider('nvidia', env);
  assert.equal(nvidiaKeys.length, 3);
  assert.equal(nvidiaKeys[0], 'nvapi-key1');
  assert.equal(nvidiaKeys[1], 'nvapi-key2');
  assert.equal(nvidiaKeys[2], 'nvapi-key3');
  assert.equal(getKeysForProvider('groq', env).length, 1);
  assert.equal(getKeysForProvider('empty', env).length, 0);
  assert.equal(getKeysForProvider('unset', env).length, 0);
  assert.equal(getKeysForProvider('unknown', env).length, 0);
});

test('getFirstKeyForProvider returns first key or null', () => {
  const env = { NVIDIA_API_KEY: 'nvapi-first, nvapi-second' };
  assert.equal(getFirstKeyForProvider('nvidia', env), 'nvapi-first');
  assert.equal(getFirstKeyForProvider('groq', env), null);
  assert.equal(getFirstKeyForProvider('unknown', env), null);
});

test('buildProviderCandidate builds candidate from catalog', () => {
  const env = { GROQ_API_KEY: 'gsk_test' };
  const candidate = buildProviderCandidate('groq', 'custom-model', env);
  assert.ok(candidate);
  assert.equal(candidate[0].name, 'Groq Cloud');
  assert.equal(candidate[0].baseUrl, 'https://api.groq.com/openai/v1');
  assert.equal(candidate[0].key, 'gsk_test');
  assert.equal(candidate[0].model, 'custom-model');
  assert.equal(candidate[0].isNvidia, false);
  assert.equal(candidate[0].emblem, '🚀');
  // No key = no candidate
  assert.equal(buildProviderCandidate('groq', 'model', {}), null);
});

test('getAllActiveProviderCandidates returns all providers with keys', () => {
  const env = {
    NVIDIA_API_KEY: 'nvapi-1',
    GROQ_API_KEY: 'gsk_1,gsk_2',
    GEMINI_API_KEY: 'AIzaSy1',
  };
  const candidates = getAllActiveProviderCandidates(env);
  const names = candidates.map((c) => c.provider);
  assert.ok(names.includes('NVIDIA NIM'));
  assert.ok(names.includes('Groq Cloud'));
  assert.ok(names.includes('Google Gemini'));
  assert.ok(!names.includes('Mistral AI'));
  assert.ok(!names.includes('Cerebras'));
  // Multiple keys for Groq = multiple candidates
  const groqCount = candidates.filter((c) => c.provider === 'Groq Cloud').length;
  assert.equal(groqCount, 2);
});

test('resolveActiveProviderId picks correct provider from base URL and key', () => {
  // Groq base URL + Groq key
  assert.equal(resolveActiveProviderId({
    NVIDIA_BASE_URL: 'https://api.groq.com/openai/v1',
    GROQ_API_KEY: 'gsk_test',
  }), 'groq');

  // Requesty base URL + Requesty key
  assert.equal(resolveActiveProviderId({
    NVIDIA_BASE_URL: 'https://router.requesty.ai/v1',
    REQUESTY_API_KEY: 'rqsty_test',
  }), 'requesty');

  // Third-party key in NVIDIA_API_KEY (prefix detection)
  assert.equal(resolveActiveProviderId({
    NVIDIA_API_KEY: 'gsk_groqKeyInNvidiaSlot',
    NVIDIA_BASE_URL: 'https://integrate.api.nvidia.com/v1',
  }), 'groq');

  assert.equal(resolveActiveProviderId({
    NVIDIA_API_KEY: 'rqsty-requestyKeyInNvidiaSlot',
    NVIDIA_BASE_URL: 'https://integrate.api.nvidia.com/v1',
  }), 'requesty');

  // Default to nvidia
  assert.equal(resolveActiveProviderId({}), 'nvidia');
  assert.equal(resolveActiveProviderId({
    NVIDIA_API_KEY: 'nvapi_native',
    NVIDIA_BASE_URL: 'https://integrate.api.nvidia.com/v1',
  }), 'nvidia');
});

test('getProviderKeyStatuses returns status for POWER UP panel', () => {
  const env = {
    NVIDIA_API_KEY: 'nvapi_1',
    GROQ_API_KEY: 'gsk_1',
  };
  const status = getProviderKeyStatuses(env);
  assert.equal(status.activeId, 'nvidia');
  assert.equal(status.providers.nvidia.set, true);
  assert.equal(status.providers.nvidia.envVar, 'NVIDIA_API_KEY');
  assert.equal(status.providers.groq.set, true);
  assert.equal(status.providers.groq.envVar, 'GROQ_API_KEY');
  assert.equal(status.providers.gemini.set, false);
  assert.equal(status.providers.gemini.envVar, 'GEMINI_API_KEY');
  // All 15 providers present (14 remote + 1 keyless local)
  assert.equal(Object.keys(status.providers).length, 15);
});

