import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FREE_LLM_PROVIDERS,
  findFreeLlmProvider,
  detectProviderFromKey,
  getAllProviders,
  getModelCapabilities,
  getModelsForCategory,
  NVIDIA_MODEL_REGISTRY,
} from './freeLlmCatalog.js';

test('FREE_LLM_PROVIDERS exports all 13 providers from awesome-free-llm-apis', () => {
  const ids = FREE_LLM_PROVIDERS.map((p) => p.id);
  assert.equal(ids.length, 13);
  assert.ok(ids.includes('nvidia'));
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
