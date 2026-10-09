/**
 * Provider registry for the typed agent.
 *
 * Three back ends reach the same OpenAI-compatible `/v1/chat/completions`
 * surface, so the only real differences are the base URL, whether a key is
 * required, and how each one reports what its models can do. Adding a fourth
 * is a table entry plus a normalizer, not another panel or tool loop.
 *
 * Everything here is pure and takes `env` as an argument, so the whole module
 * runs under `node --test` without a network, a key or a live `process.env`.
 */

/**
 * Smallest runtime context window offered for tool use.
 *
 * Ollama defaults `num_ctx` to 4096, which is well under this app's prompt
 * prefix; without this gate the failure presents as malformed tool calls
 * rather than as the configuration problem it actually is.
 */
const MIN_TOOL_CONTEXT_TOKENS = 16384;

/** Context window recorded when a provider reports none. Below the gate. */
const UNKNOWN_CONTEXT_TOKENS = 0;

/**
 * Multiple of the fixed request prefix a model needs to be usable.
 *
 * The prefix is resent on every round trip, so a window merely larger than it
 * leaves nothing for the transcript, the tool results and the answer. A full
 * eight-round command can carry eight bounded tool results of 6,000
 * characters, which at four characters per token is roughly another whole
 * prefix on top of the one being resent, so one prefix of headroom is the
 * smallest honest figure rather than a round number.
 */
const TOOL_CONTEXT_PREFIX_HEADROOM = 2;

/**
 * The context window a model must report to be offered for tool use.
 *
 * Derived from the measured prefix rather than compared against the floor
 * alone, because the floor stops being adequate the moment somebody adds a
 * tool or a directive, and it stops silently.
 *
 * @param {number} prefixTokens Heuristic size of the fixed request prefix.
 * @returns {number}
 */
function toolContextFloor(prefixTokens) {
  const prefix = Number.isFinite(prefixTokens) ? prefixTokens : 0;
  return Math.max(
    MIN_TOOL_CONTEXT_TOKENS,
    Math.ceil(prefix * TOOL_CONTEXT_PREFIX_HEADROOM),
  );
}

/**
 * Provider definitions. `apiKeyEnv: null` means the provider is reachable
 * without a credential, which is what makes a local daemon usable with no
 * signup at all.
 */
const AGENT_PROVIDERS = Object.freeze({
  openai: Object.freeze({
    id: 'openai',
    label: 'OpenAI',
    kind: 'hosted',
    defaultBaseUrl: 'https://api.openai.com/v1',
    baseUrlEnv: null,
    apiKeyEnv: 'OPENAI_API_KEY',
    modelsPath: '/models',
    defaultModel: 'gpt-5-mini',
  }),
  openrouter: Object.freeze({
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'hosted',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    baseUrlEnv: 'OPENROUTER_BASE_URL',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    // Server-side filter: OpenRouter lists hundreds of tool-capable models out
    // of a much larger catalog, so filtering upstream keeps the payload small.
    modelsPath: '/models?supported_parameters=tools',
    defaultModel: 'openai/gpt-5-mini',
  }),
  ollama: Object.freeze({
    id: 'ollama',
    label: 'Ollama',
    kind: 'local',
    defaultBaseUrl: 'http://localhost:11434/v1',
    baseUrlEnv: 'OLLAMA_BASE_URL',
    apiKeyEnv: null,
    modelsPath: '/models',
    // Nothing sensible to default to: it depends entirely on what the
    // operator has pulled, so the picker asks rather than guesses.
    defaultModel: null,
  }),
});

/** Every provider id the agent endpoints accept. */
const AGENT_PROVIDER_IDS = Object.freeze(Object.keys(AGENT_PROVIDERS));

/** Provider used when configuration names none. */
const DEFAULT_AGENT_PROVIDER = 'openai';

/**
 * Resolve a provider id to its definition.
 *
 * Total by design: this is the boundary that stops an arbitrary querystring
 * value reaching `fetch` as a base URL, so an unknown id returns null rather
 * than throwing or falling through to a default.
 *
 * @param {unknown} id
 * @returns {Readonly<object>|null}
 */
function resolveProvider(id) {
  if (typeof id !== 'string') return null;
  const key = id.trim().toLowerCase();
  return Object.hasOwn(AGENT_PROVIDERS, key) ? AGENT_PROVIDERS[key] : null;
}

/**
 * Base URL for a provider, honouring its env override.
 *
 * @param {Readonly<object>} provider
 * @param {Record<string,string|undefined>} [env]
 * @returns {string} Base URL with any trailing slash removed.
 */
function providerBaseUrl(provider, env = {}) {
  if (!provider)
    throw new TypeError('providerBaseUrl requires a provider definition');
  const override = provider.baseUrlEnv ? env[provider.baseUrlEnv] : null;
  const raw =
    typeof override === 'string' && override.trim()
      ? override.trim()
      : provider.defaultBaseUrl;
  return raw.replace(/\/+$/, '');
}

/**
 * API key for a provider, or null when it needs none.
 *
 * @param {Readonly<object>} provider
 * @param {Record<string,string|undefined>} [env]
 * @returns {string|null}
 */
function providerApiKey(provider, env = {}) {
  if (!provider?.apiKeyEnv) return null;
  const value = env[provider.apiKeyEnv];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Whether a provider can be tried right now.
 *
 * A keyless provider is always configured in this sense; whether the daemon
 * is actually running is a question only a request answers, and it comes back
 * as a reachability error rather than a configuration one.
 *
 * @param {Readonly<object>|null} provider
 * @param {Record<string,string|undefined>} [env]
 * @returns {boolean}
 */
function isProviderConfigured(provider, env = {}) {
  if (!provider) return false;
  if (!provider.apiKeyEnv) return true;
  return providerApiKey(provider, env) !== null;
}

/** Read a trimmed, non-empty env string, or null. */
function envString(env, name) {
  const value = env?.[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * The model this provider starts on: per-provider override, shared override,
 * then the provider's own default.
 *
 * Clamped to the allowlist when the operator set one. Without that clamp the
 * allowlist is bypassed by simply omitting `model`, because every caller that
 * cannot resolve a request falls back to this value, which defeats the one
 * thing the allowlist exists to do. A provider with nothing configured stays
 * unconfigured rather than adopting an allowlist entry, so a picker that must
 * ask still asks.
 *
 * @param {Readonly<object>|null} provider
 * @param {Record<string,string|undefined>} [env]
 * @returns {string|null}
 */
function resolveConfiguredModel(provider, env = {}) {
  if (!provider) return null;
  const configured =
    envString(env, `GEV_AGENT_MODEL_${provider.id.toUpperCase()}`) ||
    envString(env, 'GEV_AGENT_MODEL') ||
    provider.defaultModel;
  const allowed = modelAllowList(provider, env);
  if (!allowed || !configured) return configured;
  return allowed.includes(configured) ? configured : allowed[0];
}

/**
 * Provider selected by configuration, falling back to the default when the
 * configured value is absent or unrecognised.
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {Readonly<object>}
 */
function resolveConfiguredProvider(env = {}) {
  return (
    resolveProvider(env.GEV_AGENT_PROVIDER) ||
    AGENT_PROVIDERS[DEFAULT_AGENT_PROVIDER]
  );
}

/**
 * Operator allowlist of model ids for one provider, or null when unset.
 *
 * An operator who has exposed the dev server (`HOST=0.0.0.0`) can pin exactly
 * which models a visitor may spend their credit on, which the picker alone
 * cannot do because the picker is client-side.
 *
 * @param {Readonly<object>|null} provider
 * @param {Record<string,string|undefined>} [env]
 * @returns {string[]|null}
 */
function modelAllowList(provider, env = {}) {
  if (!provider) return null;
  const raw =
    envString(env, `GEV_AGENT_MODELS_${provider.id.toUpperCase()}`) ||
    envString(env, 'GEV_AGENT_MODELS');
  if (!raw) return null;
  const ids = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return ids.length ? ids : null;
}

/** Longest model id accepted from a request. */
const MAX_MODEL_ID_CHARS = 160;

/**
 * Shape a model id may take across the supported providers.
 *
 * One or more dot/colon/at-separated segments joined by `/`, which covers
 * `gpt-5-mini`, `openai/gpt-5-mini`, `qwen3:4b` and `hf.co/user/repo:Q4_K_M`.
 * A relative segment is excluded because an id is operator-facing text that
 * also reaches logs and the picker, and `..` there is always a mistake.
 */
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:@-]+(?:\/[A-Za-z0-9._:@-]+)*$/;

/** Whether a candidate id contains a relative path segment. */
function hasRelativeSegment(id) {
  return id.split('/').some((segment) => segment === '.' || segment === '..');
}

/**
 * Resolve the model one request runs on.
 *
 * The client picks from a listing, but the SERVER decides: an id that is
 * malformed, over-long, or outside the operator's allowlist degrades to the
 * configured default rather than reaching the upstream verbatim. Total, like
 * the voice tier resolver, so a hostile querystring produces an ordinary turn
 * on a known model instead of an upstream error.
 *
 * @param {unknown} requested
 * @param {Readonly<object>|null} provider
 * @param {Record<string,string|undefined>} [env]
 * @returns {{model: string|null, fallback: boolean, reason: string|null}}
 */
function resolveRequestedModel(requested, provider, env = {}) {
  const configured = resolveConfiguredModel(provider, env);
  const raw = typeof requested === 'string' ? requested.trim() : '';
  if (!raw) return { model: configured, fallback: false, reason: null };
  if (
    raw.length > MAX_MODEL_ID_CHARS ||
    !MODEL_ID_PATTERN.test(raw) ||
    hasRelativeSegment(raw)
  ) {
    return { model: configured, fallback: true, reason: 'malformed' };
  }
  const allowed = modelAllowList(provider, env);
  if (allowed && !allowed.includes(raw)) {
    return { model: configured, fallback: true, reason: 'not-allowed' };
  }
  return { model: raw, fallback: false, reason: null };
}

/**
 * Provider summaries safe to hand the browser: no keys, no base URLs for
 * hosted providers, just what the picker needs to render itself.
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {Array<object>}
 */
function describeProviders(env = {}) {
  return AGENT_PROVIDER_IDS.map((id) => {
    const provider = AGENT_PROVIDERS[id];
    return {
      id,
      label: provider.label,
      kind: provider.kind,
      configured: isProviderConfigured(provider, env),
      requiresKey: Boolean(provider.apiKeyEnv),
      apiKeyEnv: provider.apiKeyEnv,
      defaultModel: resolveConfiguredModel(provider, env),
    };
  });
}

/**
 * Ollama's OpenAI-compatible surface omits capability and context metadata, so
 * capability probing uses its native `/api/show`, which sits at the server
 * root rather than under `/v1`.
 *
 * @param {string} baseUrl - The compatible base, e.g. `http://host:11434/v1`.
 * @returns {string} The native root, e.g. `http://host:11434`.
 */
function ollamaNativeRoot(baseUrl) {
  return String(baseUrl).replace(/\/+$/, '').replace(/\/v1$/, '');
}

/**
 * Normalized model shape shared by every provider.
 *
 * @typedef {object} AgentModel
 * @property {string} id            Wire id passed back as `model`.
 * @property {string} label         Human-facing name.
 * @property {string} provider      Owning provider id.
 * @property {number} contextLength Tokens, or UNKNOWN_CONTEXT_TOKENS.
 * @property {boolean} supportsTools
 * @property {boolean} supportsVision
 * @property {{promptPerMTok:number, completionPerMTok:number}|null} pricing
 */

/** Coerce a possibly-stringy numeric field without letting NaN escape. */
function finiteNumber(value, fallback = 0) {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * OpenRouter prices are per-token strings; the picker wants per-million
 * numbers. Null when a model reports no usable pricing, so the picker can say
 * "unknown" rather than confidently showing $0.00.
 */
function openRouterPricing(raw) {
  const prompt = finiteNumber(raw?.prompt, Number.NaN);
  const completion = finiteNumber(raw?.completion, Number.NaN);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null;
  return {
    promptPerMTok: prompt * 1_000_000,
    completionPerMTok: completion * 1_000_000,
  };
}

/**
 * Normalize one OpenRouter catalog entry. OpenRouter is the only provider that
 * reports capabilities directly, through `supported_parameters` and
 * `architecture.input_modalities`.
 *
 * @param {object} raw
 * @returns {AgentModel|null} Null when the entry has no usable id.
 */
function normalizeOpenRouterModel(raw) {
  const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;
  const supported = Array.isArray(raw?.supported_parameters)
    ? raw.supported_parameters
    : [];
  const modalities = Array.isArray(raw?.architecture?.input_modalities)
    ? raw.architecture.input_modalities
    : [];
  return {
    id,
    label:
      typeof raw?.name === 'string' && raw.name.trim() ? raw.name.trim() : id,
    provider: 'openrouter',
    contextLength: Math.max(
      0,
      Math.floor(finiteNumber(raw?.context_length, UNKNOWN_CONTEXT_TOKENS)),
    ),
    supportsTools: supported.includes('tools'),
    supportsVision: modalities.includes('image'),
    pricing: openRouterPricing(raw?.pricing),
  };
}

/**
 * OpenAI model families that are not chat completions at all.
 *
 * `/v1/models` is one undifferentiated list: speech, transcription, embedding,
 * image and moderation models sit beside the chat models with no field that
 * tells them apart. Offering them would put a dozen ids in the picker that
 * answer a chat request with an upstream 400, so the families are named here.
 * Matching on the id is a heuristic over a vendor naming convention, which is
 * why it only HIDES models and nothing depends on the list being complete.
 */
const OPENAI_NON_CHAT_PATTERNS = Object.freeze([
  /whisper/i,
  /(^|[-/])tts([-/]|$)/i,
  /embedding/i,
  /moderation/i,
  /dall-e/i,
  /^gpt-image/i,
  /^sora/i,
  /-(?:audio|transcribe|tts|realtime)(?:-|$)/i,
  /^(?:davinci|babbage|curie|ada)(?:-|$)/i,
  /^omni-moderation/i,
  /^codex-mini/i,
]);

/**
 * Whether an OpenAI model id names something the chat-completions surface can
 * actually run.
 *
 * @param {string} id
 * @returns {boolean}
 */
function isOpenAiChatModel(id) {
  const value = typeof id === 'string' ? id.trim() : '';
  if (!value) return false;
  return !OPENAI_NON_CHAT_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Normalize one OpenAI `/v1/models` entry.
 *
 * The listing carries no capability or context metadata at all, so tool
 * support is assumed and the context gate is skipped rather than guessed at;
 * every current OpenAI chat model exceeds the prefix comfortably. Non-chat
 * families are dropped outright (see OPENAI_NON_CHAT_PATTERNS).
 *
 * @param {object} raw
 * @returns {AgentModel|null}
 */
function normalizeOpenAiModel(raw) {
  const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
  if (!id || !isOpenAiChatModel(id)) return null;
  return {
    id,
    label: id,
    provider: 'openai',
    contextLength: UNKNOWN_CONTEXT_TOKENS,
    supportsTools: true,
    supportsVision: true,
    pricing: null,
  };
}

/**
 * Normalize one Ollama model.
 *
 * Capabilities come only from the native `/api/show`, and the context length
 * sits inside `model_info` under an architecture-prefixed key such as
 * `qwen3.context_length`. Both are probed defensively: a daemon too old to
 * report either yields an entry that fails the context gate loudly instead of
 * a model that fails mysteriously at tool-call time.
 *
 * @param {object} raw     Entry from `/v1/models`.
 * @param {object|null} [details] Response from `/api/show`, when available.
 * @returns {AgentModel|null}
 */
function normalizeOllamaModel(raw, details = null) {
  const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;
  const capabilities = Array.isArray(details?.capabilities)
    ? details.capabilities
    : null;
  const info =
    details?.model_info && typeof details.model_info === 'object'
      ? details.model_info
      : {};
  const contextKey = Object.keys(info).find((key) =>
    key.endsWith('.context_length'),
  );
  return {
    id,
    label: id,
    provider: 'ollama',
    contextLength: Math.max(
      0,
      Math.floor(
        finiteNumber(
          contextKey ? info[contextKey] : null,
          UNKNOWN_CONTEXT_TOKENS,
        ),
      ),
    ),
    // A daemon too old to report capabilities gets the benefit of the doubt on
    // tools: refusing every model there would be worse than a clear downstream
    // error from the model itself.
    supportsTools: capabilities ? capabilities.includes('tools') : true,
    supportsVision: capabilities ? capabilities.includes('vision') : false,
    pricing: { promptPerMTok: 0, completionPerMTok: 0 },
  };
}

/** Why a model was withheld from the picker. */
const MODEL_REJECTION = Object.freeze({
  NO_TOOLS: 'no-tools',
  CONTEXT_TOO_SMALL: 'context-too-small',
  NOT_ALLOWED: 'not-allowed',
});

/**
 * Split normalized models into those usable for tool calling and those that
 * are not, keeping the reason so the picker can explain itself.
 *
 * A reported context of UNKNOWN_CONTEXT_TOKENS is treated as unverified and
 * allowed through, because two of the three providers never report one; the
 * gate exists to catch Ollama's 4096 default, which IS reported.
 *
 * @param {AgentModel[]} models
 * @param {{minContextTokens?: number, allowList?: string[]|null}} [options]
 * @returns {{usable: AgentModel[], rejected: Array<{model: AgentModel, reason: string}>}}
 */
function gateModels(
  models,
  { minContextTokens = MIN_TOOL_CONTEXT_TOKENS, allowList = null } = {},
) {
  const usable = [];
  const rejected = [];
  for (const model of Array.isArray(models) ? models : []) {
    if (!model) continue;
    if (allowList && !allowList.includes(model.id)) {
      rejected.push({ model, reason: MODEL_REJECTION.NOT_ALLOWED });
      continue;
    }
    if (!model.supportsTools) {
      rejected.push({ model, reason: MODEL_REJECTION.NO_TOOLS });
      continue;
    }
    if (
      model.contextLength !== UNKNOWN_CONTEXT_TOKENS &&
      model.contextLength < minContextTokens
    ) {
      rejected.push({ model, reason: MODEL_REJECTION.CONTEXT_TOO_SMALL });
      continue;
    }
    usable.push(model);
  }
  return { usable, rejected };
}

/**
 * Stable ordering for the picker: cheapest first, so free and local models sit
 * nearest the top and unpriced models last.
 *
 * @param {AgentModel[]} models
 * @returns {AgentModel[]}
 */
function sortModelsForPicker(models) {
  const rank = (model) => {
    if (!model.pricing) return 2;
    return model.pricing.promptPerMTok === 0 ? 0 : 1;
  };
  return [...(Array.isArray(models) ? models : [])].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    const priceA = a.pricing?.promptPerMTok ?? Number.POSITIVE_INFINITY;
    const priceB = b.pricing?.promptPerMTok ?? Number.POSITIVE_INFINITY;
    if (priceA !== priceB) return priceA - priceB;
    return a.id.localeCompare(b.id);
  });
}

export {
  AGENT_PROVIDERS,
  AGENT_PROVIDER_IDS,
  DEFAULT_AGENT_PROVIDER,
  MAX_MODEL_ID_CHARS,
  MIN_TOOL_CONTEXT_TOKENS,
  MODEL_REJECTION,
  OPENAI_NON_CHAT_PATTERNS,
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
};
