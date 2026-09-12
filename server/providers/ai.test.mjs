import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toFiveWordHudSummary,
  extractOpenAiResponseText,
  activeAiKey,
  BaseAiProvider,
  OpenAiProvider,
  AnthropicProvider,
  GeminiProvider,
  OllamaProvider,
  AiProviderRegistry,
  aiRegistry,
  generateMultiProviderHudSummary,
  generateMultiProviderChat,
} from './ai.js';

test('toFiveWordHudSummary produces exactly at most 5 words without punctuation', () => {
  assert.equal(
    toFiveWordHudSummary('Eiffel Tower in Paris, France near the river!'),
    'Eiffel Tower in Paris France',
  );
  assert.equal(toFiveWordHudSummary(''), '');
  assert.equal(toFiveWordHudSummary('One Two Three'), 'One Two Three');
  assert.equal(
    toFiveWordHudSummary('One Two Three Four Five Six Seven'),
    'One Two Three Four Five',
  );
});

test('extractOpenAiResponseText extracts text from various response structures', () => {
  assert.equal(
    extractOpenAiResponseText({ output_text: 'Hello world' }),
    'Hello world',
  );
  assert.equal(
    extractOpenAiResponseText({
      output: [{ content: [{ text: 'Part 1' }, { text: 'Part 2' }] }],
    }),
    'Part 1 Part 2',
  );
});

test('activeAiKey resolves correct key for each provider via registry', () => {
  assert.equal(
    activeAiKey({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' }),
    'sk-test',
  );
  assert.equal(
    activeAiKey({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'ant-test' }),
    'ant-test',
  );
  assert.equal(
    activeAiKey({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'gem-test' }),
    'gem-test',
  );
  assert.equal(
    activeAiKey({
      AI_PROVIDER: 'ollama',
      OLLAMA_BASE_URL: 'http://localhost:11434',
    }),
    'http://localhost:11434',
  );
});

test('AiProviderRegistry supports dynamic provider registration and lookup', () => {
  const customRegistry = new AiProviderRegistry();

  class MockCustomProvider extends BaseAiProvider {
    constructor() {
      super({
        id: 'mock-llm',
        name: 'Mock LLM',
        envKeyName: 'MOCK_API_KEY',
        defaultModel: 'mock-v1',
      });
    }

    async generateSummary(context, env) {
      return 'Mock Summary For Current View';
    }

    async chat({ message }) {
      return { text: `Echo: ${message}`, toolCalls: [] };
    }
  }

  customRegistry.register(new MockCustomProvider());
  assert.equal(customRegistry.list().length, 1);
  const provider = customRegistry.get('mock-llm');
  assert.ok(provider instanceof MockCustomProvider);
  assert.equal(provider.name, 'Mock LLM');
  assert.equal(provider.getApiKey({ MOCK_API_KEY: 'mock-123' }), 'mock-123');
});

test('Default aiRegistry contains all standard providers', () => {
  const registered = aiRegistry.list().map((p) => p.id);
  assert.ok(registered.includes('openai'));
  assert.ok(registered.includes('anthropic'));
  assert.ok(registered.includes('gemini'));
  assert.ok(registered.includes('ollama'));
});
