import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_PROVIDERS,
  AGENT_PROVIDER_IDS,
  MAX_MODEL_ID_CHARS,
  MIN_TOOL_CONTEXT_TOKENS,
  MODEL_REJECTION,
  TOOL_CONTEXT_PREFIX_HEADROOM,
  UNKNOWN_CONTEXT_TOKENS,
  describeProviders,
  gateModels,
  isOpenAiChatModel,
  isProviderConfigured,
  modelAllowList,
  normalizeOllamaModel,
  normalizeOpenAiModel,
  normalizeOpenRouterModel,
  ollamaNativeRoot,
  providerApiKey,
  providerBaseUrl,
  resolveConfiguredModel,
  resolveConfiguredProvider,
  resolveProvider,
  resolveRequestedModel,
  sortModelsForPicker,
  toolContextFloor,
} from '../../server/providers/agent/registry.js';

const openai = AGENT_PROVIDERS.openai;
const openrouter = AGENT_PROVIDERS.openrouter;
const ollama = AGENT_PROVIDERS.ollama;

test('an unknown provider id resolves to null rather than a default', () => {
  assert.equal(resolveProvider('openai'), openai);
  assert.equal(resolveProvider('  OpenAI  '), openai);
  assert.equal(resolveProvider('anthropic'), null);
  assert.equal(resolveProvider(''), null);
  assert.equal(resolveProvider(null), null);
  assert.equal(resolveProvider({ id: 'openai' }), null);
});

test('every registered provider has the fields the endpoints read', () => {
  for (const id of AGENT_PROVIDER_IDS) {
    const provider = AGENT_PROVIDERS[id];
    assert.equal(provider.id, id);
    assert.ok(provider.label);
    assert.ok(['hosted', 'local'].includes(provider.kind));
    assert.match(provider.defaultBaseUrl, /^https?:\/\//);
    assert.match(provider.modelsPath, /^\//);
  }
});

test('base URLs honour the env override and lose a trailing slash', () => {
  assert.equal(providerBaseUrl(ollama, {}), 'http://localhost:11434/v1');
  assert.equal(
    providerBaseUrl(ollama, { OLLAMA_BASE_URL: 'http://gpu-box:11434/v1/' }),
    'http://gpu-box:11434/v1',
  );
  // OpenAI has no override, so a stray variable cannot repoint it.
  assert.equal(
    providerBaseUrl(openai, { OPENAI_BASE_URL: 'http://evil.example/v1' }),
    'https://api.openai.com/v1',
  );
  assert.throws(() => providerBaseUrl(null), TypeError);
});

test('a blank key reads as absent, and a keyless provider needs none', () => {
  assert.equal(providerApiKey(openai, { OPENAI_API_KEY: '  sk-x  ' }), 'sk-x');
  assert.equal(providerApiKey(openai, { OPENAI_API_KEY: '   ' }), null);
  assert.equal(providerApiKey(ollama, {}), null);
  assert.equal(isProviderConfigured(ollama, {}), true);
  assert.equal(isProviderConfigured(openai, {}), false);
  assert.equal(isProviderConfigured(openai, { OPENAI_API_KEY: 'sk-x' }), true);
  assert.equal(isProviderConfigured(null, {}), false);
});

test('model configuration prefers the per-provider override', () => {
  assert.equal(resolveConfiguredModel(openai, {}), 'gpt-5-mini');
  assert.equal(
    resolveConfiguredModel(openai, { GEV_AGENT_MODEL: 'gpt-5' }),
    'gpt-5',
  );
  assert.equal(
    resolveConfiguredModel(openai, {
      GEV_AGENT_MODEL: 'gpt-5',
      GEV_AGENT_MODEL_OPENAI: 'gpt-5-nano',
    }),
    'gpt-5-nano',
  );
  assert.equal(resolveConfiguredModel(ollama, {}), null);
  assert.equal(resolveConfiguredModel(null, {}), null);
});

test('an unrecognised configured provider falls back to the default', () => {
  assert.equal(resolveConfiguredProvider({}).id, 'openai');
  assert.equal(
    resolveConfiguredProvider({ GEV_AGENT_PROVIDER: 'ollama' }).id,
    'ollama',
  );
  assert.equal(
    resolveConfiguredProvider({ GEV_AGENT_PROVIDER: 'nope' }).id,
    'openai',
  );
});

test('describeProviders never leaks a key or a hosted base URL', () => {
  const described = describeProviders({ OPENAI_API_KEY: 'sk-secret' });
  const serialized = JSON.stringify(described);
  assert.doesNotMatch(serialized, /sk-secret/);
  assert.doesNotMatch(serialized, /api\.openai\.com/);
  assert.deepEqual(
    described.map((entry) => [entry.id, entry.configured]),
    [
      ['openai', true],
      ['openrouter', false],
      ['ollama', true],
    ],
  );
  assert.equal(described[1].apiKeyEnv, 'OPENROUTER_API_KEY');
});

test('the requested model is accepted only in a shape a provider uses', () => {
  const ok = (id) => resolveRequestedModel(id, openai, {});
  assert.deepEqual(ok('gpt-5-mini'), {
    model: 'gpt-5-mini',
    fallback: false,
    reason: null,
  });
  assert.deepEqual(ok('  gpt-5-mini  '), {
    model: 'gpt-5-mini',
    fallback: false,
    reason: null,
  });
  assert.equal(
    resolveRequestedModel('openai/gpt-5-mini', openrouter, {}).model,
    'openai/gpt-5-mini',
  );
  assert.equal(resolveRequestedModel('qwen3:4b', ollama, {}).model, 'qwen3:4b');
  assert.equal(
    resolveRequestedModel('hf.co/user/repo:Q4_K_M', ollama, {}).model,
    'hf.co/user/repo:Q4_K_M',
  );
});

test('a malformed model id degrades to the configured default', () => {
  for (const hostile of [
    '../../etc/passwd',
    'a/./b',
    '/leading',
    'trailing/',
    'has space',
    'quote"',
    'x'.repeat(MAX_MODEL_ID_CHARS + 1),
  ]) {
    assert.deepEqual(
      resolveRequestedModel(hostile, openai, {}),
      { model: 'gpt-5-mini', fallback: true, reason: 'malformed' },
      `accepted ${hostile}`,
    );
  }
});

test('an absent model takes the configured default without flagging a fallback', () => {
  assert.deepEqual(resolveRequestedModel('', openai, {}), {
    model: 'gpt-5-mini',
    fallback: false,
    reason: null,
  });
  assert.deepEqual(resolveRequestedModel(undefined, openai, {}), {
    model: 'gpt-5-mini',
    fallback: false,
    reason: null,
  });
  assert.deepEqual(resolveRequestedModel(42, openai, {}), {
    model: 'gpt-5-mini',
    fallback: false,
    reason: null,
  });
});

test('the operator allowlist is the authority over what a request may run', () => {
  const env = { GEV_AGENT_MODELS_OPENAI: 'gpt-5-nano, gpt-5-mini' };
  assert.deepEqual(modelAllowList(openai, env), ['gpt-5-nano', 'gpt-5-mini']);
  assert.equal(modelAllowList(openai, {}), null);
  assert.equal(
    modelAllowList(openai, { GEV_AGENT_MODELS_OPENAI: ' , ' }),
    null,
  );
  assert.equal(
    resolveRequestedModel('gpt-5-nano', openai, env).model,
    'gpt-5-nano',
  );
  assert.deepEqual(resolveRequestedModel('gpt-5', openai, env), {
    model: 'gpt-5-mini',
    fallback: true,
    reason: 'not-allowed',
  });
  // A shared allowlist covers a provider with no per-provider one.
  assert.deepEqual(modelAllowList(ollama, { GEV_AGENT_MODELS: 'qwen3:4b' }), [
    'qwen3:4b',
  ]);
});

test('OpenAI non-chat families are hidden from the picker', () => {
  for (const id of [
    'whisper-1',
    'tts-1-hd',
    'gpt-4o-mini-tts',
    'text-embedding-3-small',
    'omni-moderation-latest',
    'dall-e-3',
    'gpt-image-1',
    'sora-2',
    'gpt-4o-audio-preview',
    'gpt-realtime-2',
    'gpt-4o-mini-transcribe',
    'davinci-002',
    'codex-mini-latest',
  ]) {
    assert.equal(isOpenAiChatModel(id), false, `offered ${id}`);
    assert.equal(normalizeOpenAiModel({ id }), null);
  }
  for (const id of [
    'gpt-5',
    'gpt-5-mini',
    'gpt-5-nano',
    'gpt-4o',
    'o4-mini',
    'chatgpt-4o-latest',
  ]) {
    assert.equal(isOpenAiChatModel(id), true, `hid ${id}`);
    assert.equal(normalizeOpenAiModel({ id })?.id, id);
  }
  assert.equal(isOpenAiChatModel(''), false);
  assert.equal(isOpenAiChatModel(null), false);
});

test('OpenAI entries report unverified context and assumed tool support', () => {
  const model = normalizeOpenAiModel({ id: ' gpt-5-mini ' });
  assert.deepEqual(model, {
    id: 'gpt-5-mini',
    label: 'gpt-5-mini',
    provider: 'openai',
    contextLength: UNKNOWN_CONTEXT_TOKENS,
    supportsTools: true,
    // OpenAI reports no capabilities, so vision is recorded as absent rather
    // than claimed for every chat model in the picker.
    supportsVision: false,
    pricing: null,
  });
  assert.equal(normalizeOpenAiModel({}), null);
});

test('OpenRouter capabilities and per-million pricing are read from the catalog', () => {
  const model = normalizeOpenRouterModel({
    id: 'openai/gpt-5-mini',
    name: 'GPT-5 Mini',
    context_length: 400000,
    supported_parameters: ['tools', 'temperature'],
    architecture: { input_modalities: ['text', 'image'] },
    pricing: { prompt: '0.00000025', completion: '0.000002' },
  });
  assert.equal(model.label, 'GPT-5 Mini');
  assert.equal(model.contextLength, 400000);
  assert.equal(model.supportsTools, true);
  assert.equal(model.supportsVision, true);
  assert.equal(model.pricing.promptPerMTok, 0.25);
  assert.equal(model.pricing.completionPerMTok, 2);
});

test('an OpenRouter model with unreadable pricing reports none, not zero', () => {
  const model = normalizeOpenRouterModel({
    id: 'a/b',
    pricing: { prompt: 'n/a' },
  });
  assert.equal(model.pricing, null);
  assert.equal(model.supportsTools, false);
  assert.equal(model.contextLength, UNKNOWN_CONTEXT_TOKENS);
  assert.equal(normalizeOpenRouterModel({ id: '   ' }), null);
});

test('Ollama context length is read from the architecture-prefixed key', () => {
  const model = normalizeOllamaModel(
    { id: 'qwen3:4b' },
    {
      capabilities: ['tools', 'vision'],
      model_info: { 'qwen3.context_length': 262144 },
    },
  );
  assert.equal(model.contextLength, 262144);
  assert.equal(model.supportsTools, true);
  assert.equal(model.supportsVision, true);
  assert.deepEqual(model.pricing, { promptPerMTok: 0, completionPerMTok: 0 });
});

test('a daemon that reports nothing still offers the model, ungated on context', () => {
  const model = normalizeOllamaModel({ id: 'llama3.2:3b' }, null);
  assert.equal(model.supportsTools, true);
  assert.equal(model.supportsVision, false);
  assert.equal(model.contextLength, UNKNOWN_CONTEXT_TOKENS);
  assert.equal(normalizeOllamaModel({}), null);
});

test('a model reporting no tools, or too small a context, is withheld with its reason', () => {
  const small = normalizeOllamaModel(
    { id: 'tiny' },
    { capabilities: ['tools'], model_info: { 'tiny.context_length': 4096 } },
  );
  const noTools = normalizeOllamaModel({ id: 'embed' }, { capabilities: [] });
  const fine = normalizeOllamaModel(
    { id: 'big' },
    { capabilities: ['tools'], model_info: { 'big.context_length': 131072 } },
  );
  const unknown = normalizeOpenAiModel({ id: 'gpt-5-mini' });
  const { usable, rejected } = gateModels([
    small,
    noTools,
    fine,
    unknown,
    null,
  ]);
  assert.deepEqual(
    usable.map((model) => model.id),
    ['big', 'gpt-5-mini'],
  );
  assert.deepEqual(rejected, [
    { model: small, reason: MODEL_REJECTION.CONTEXT_TOO_SMALL },
    { model: noTools, reason: MODEL_REJECTION.NO_TOOLS },
  ]);
  assert.ok(MIN_TOOL_CONTEXT_TOKENS > 4096);
});

test('the gate applies the operator allowlist before any capability check', () => {
  const allowed = normalizeOpenAiModel({ id: 'gpt-5-mini' });
  const other = normalizeOpenAiModel({ id: 'gpt-5' });
  const { usable, rejected } = gateModels([allowed, other], {
    allowList: ['gpt-5-mini'],
  });
  assert.deepEqual(
    usable.map((model) => model.id),
    ['gpt-5-mini'],
  );
  assert.deepEqual(rejected, [
    { model: other, reason: MODEL_REJECTION.NOT_ALLOWED },
  ]);
});

test('the picker lists free models first, then cheapest, then unpriced', () => {
  const free = {
    id: 'local',
    pricing: { promptPerMTok: 0, completionPerMTok: 0 },
  };
  const cheap = {
    id: 'cheap',
    pricing: { promptPerMTok: 0.25, completionPerMTok: 2 },
  };
  const dear = {
    id: 'dear',
    pricing: { promptPerMTok: 10, completionPerMTok: 30 },
  };
  const unpriced = { id: 'unpriced', pricing: null };
  assert.deepEqual(
    sortModelsForPicker([dear, unpriced, free, cheap]).map((model) => model.id),
    ['local', 'cheap', 'dear', 'unpriced'],
  );
  assert.deepEqual(sortModelsForPicker(null), []);
});

test('the native Ollama root drops the compatible /v1 suffix', () => {
  assert.equal(
    ollamaNativeRoot('http://localhost:11434/v1'),
    'http://localhost:11434',
  );
  assert.equal(
    ollamaNativeRoot('http://localhost:11434/v1/'),
    'http://localhost:11434',
  );
  assert.equal(
    ollamaNativeRoot('http://localhost:11434'),
    'http://localhost:11434',
  );
});

test('an allowlist also binds the configured default, which is the fallback', () => {
  // Omitting `model` is the bypass this guards: every unresolvable request
  // lands on the configured default, so an unchecked default is an unchecked
  // model.
  assert.equal(
    resolveConfiguredModel(AGENT_PROVIDERS.openai, {
      GEV_AGENT_MODELS: 'gpt-5-nano',
    }),
    'gpt-5-nano',
  );
  assert.equal(
    resolveRequestedModel(undefined, AGENT_PROVIDERS.openai, {
      GEV_AGENT_MODELS: 'gpt-5-nano',
    }).model,
    'gpt-5-nano',
  );
  assert.equal(
    resolveRequestedModel('gpt-5-mini', AGENT_PROVIDERS.openai, {
      GEV_AGENT_MODELS: 'gpt-5-nano',
    }).model,
    'gpt-5-nano',
  );
});

test('an allowed configured default is left exactly as configured', () => {
  assert.equal(
    resolveConfiguredModel(AGENT_PROVIDERS.openai, {
      GEV_AGENT_MODEL: 'gpt-5-mini',
      GEV_AGENT_MODELS: 'gpt-5-mini,gpt-5-nano',
    }),
    'gpt-5-mini',
  );
});

test('a provider with nothing configured does not adopt an allowlist entry', () => {
  // Ollama depends entirely on what the operator pulled, so the picker has to
  // ask. An allowlist narrows that question, it does not answer it.
  assert.equal(
    resolveConfiguredModel(AGENT_PROVIDERS.ollama, {
      GEV_AGENT_MODELS_OLLAMA: 'llama3.2:3b',
    }),
    null,
  );
});

test('the tool context floor follows the prefix and never drops below the gate', () => {
  assert.equal(toolContextFloor(12_655), 12_655 * TOOL_CONTEXT_PREFIX_HEADROOM);
  assert.equal(toolContextFloor(1_000), MIN_TOOL_CONTEXT_TOKENS);
  assert.equal(toolContextFloor(0), MIN_TOOL_CONTEXT_TOKENS);
  assert.equal(toolContextFloor(Number.NaN), MIN_TOOL_CONTEXT_TOKENS);
  assert.equal(toolContextFloor(undefined), MIN_TOOL_CONTEXT_TOKENS);
});

test('a window that merely exceeds the prefix is not enough to be offered', () => {
  const prefixTokens = 12_655;
  const tightWindow = {
    id: 'tight',
    supportsTools: true,
    contextLength: MIN_TOOL_CONTEXT_TOKENS,
  };
  const roomyWindow = {
    id: 'roomy',
    supportsTools: true,
    contextLength: prefixTokens * TOOL_CONTEXT_PREFIX_HEADROOM,
  };
  const { usable, rejected } = gateModels([tightWindow, roomyWindow], {
    minContextTokens: toolContextFloor(prefixTokens),
  });
  assert.deepEqual(
    usable.map((model) => model.id),
    ['roomy'],
  );
  assert.equal(rejected[0].reason, MODEL_REJECTION.CONTEXT_TOO_SMALL);
});

test('a negative upstream price is unknown pricing, not a cheap model', () => {
  // OpenRouter uses a negative value for a rate it will not quote up front.
  // Taken literally it sorts cheapest and gets preselected at a negative cost.
  assert.equal(
    normalizeOpenRouterModel({
      id: 'openrouter/auto',
      supported_parameters: ['tools'],
      pricing: { prompt: '-1', completion: '-1' },
    }).pricing,
    null,
  );

  const free = {
    id: 'free',
    pricing: { promptPerMTok: 0, completionPerMTok: 0 },
  };
  const paid = {
    id: 'paid',
    pricing: { promptPerMTok: 1, completionPerMTok: 2 },
  };
  const unquoted = { id: 'unquoted', pricing: null };
  assert.deepEqual(
    sortModelsForPicker([unquoted, paid, free]).map((model) => model.id),
    ['free', 'paid', 'unquoted'],
  );
});
