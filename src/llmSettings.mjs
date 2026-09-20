/**
 * Local-LLM settings — the pure core.
 *
 * God's Eye View talks to exactly three text backends: OpenAI's hosted API
 * (the default, unchanged), a local Ollama server, or a local llama.cpp
 * `llama-server`. Both local options speak the OpenAI chat-completions
 * dialect, so the only real differences are the base URL, the model id, the
 * absence of a key, and where the model list lives.
 *
 * Everything here is pure: no filesystem, no network, no process.env, no
 * browser globals. The dev-server provider (server/providers/llm/) and the
 * in-app Provider Settings panel are both thin shells over this module, so
 * what a provider is called, where it listens, and what it can actually do
 * each live in exactly one place.
 *
 * HONEST CAPABILITY NOTE, encoded below rather than buried in prose: voice
 * control is the OpenAI *Realtime* speech API (WebRTC to
 * api.openai.com/v1/realtime), which neither Ollama nor llama.cpp implements.
 * A local provider therefore carries `realtimeVoice: false`, and the panel
 * renders that fact instead of pretending.
 */

/** Env vars the LLM settings are read from and written to. */
export const LLM_ENV_VARS = Object.freeze({
  provider: 'GEV_LLM_PROVIDER',
  baseUrl: 'GEV_LLM_BASE_URL',
  model: 'GEV_LLM_MODEL',
});

/** Ordered list of every env var this module owns. */
export const LLM_ENV_VAR_NAMES = Object.freeze(Object.values(LLM_ENV_VARS));

/** The provider that runs when nothing is configured — today's behavior. */
export const LLM_PROVIDER_DEFAULT = 'openai';

/**
 * Provider registry, in display order. `api` names the request dialect:
 * 'responses' is OpenAI's Responses API (what the HUD summary already uses),
 * 'chat' is the OpenAI-compatible /v1/chat/completions both local servers
 * expose. `modelsPath` is where a model list can be read without spending
 * tokens, which is also what "Test connection" probes.
 */
export const LLM_PROVIDERS = Object.freeze([
  Object.freeze({
    id: 'openai',
    label: 'OPENAI',
    blurb: 'Hosted OpenAI — the default. Voice + text.',
    kind: 'cloud',
    defaultBaseUrl: 'https://api.openai.com',
    defaultModel: '',
    requiresKey: true,
    api: 'responses',
    modelsPath: '/v1/models',
    chatPath: '/v1/responses',
    capabilities: Object.freeze({
      text: true,
      toolCalling: 'yes',
      realtimeVoice: true,
    }),
  }),
  Object.freeze({
    id: 'ollama',
    label: 'OLLAMA',
    blurb: 'Local Ollama server. Text only — no voice.',
    kind: 'local',
    defaultBaseUrl: 'http://localhost:11434',
    defaultModel: 'llama3.1:8b',
    requiresKey: false,
    api: 'chat',
    modelsPath: '/api/tags',
    chatPath: '/v1/chat/completions',
    capabilities: Object.freeze({
      text: true,
      toolCalling: 'model-dependent',
      realtimeVoice: false,
    }),
  }),
  Object.freeze({
    id: 'llamacpp',
    label: 'LLAMA.CPP',
    blurb: "llama-server's OpenAI-compatible /v1. Text only — no voice.",
    kind: 'local',
    defaultBaseUrl: 'http://localhost:8080',
    defaultModel: '',
    requiresKey: false,
    api: 'chat',
    modelsPath: '/v1/models',
    chatPath: '/v1/chat/completions',
    capabilities: Object.freeze({
      text: true,
      toolCalling: 'model-dependent',
      realtimeVoice: false,
    }),
  }),
]);

/** The one sentence the UI and the status endpoint both tell the truth with. */
export const LLM_VOICE_LIMITATION_NOTE =
  'Voice control needs the OpenAI Realtime speech API. Ollama and llama.cpp do not implement it, so GEV MIC stays on OpenAI and needs OPENAI_API_KEY.';

/** The matching note for what a local model *can* do. */
export const LLM_LOCAL_CAPABILITY_NOTE =
  'A local model powers the text features (the AI HUD summary). Tool calling depends on the model you load.';

/** @returns {string[]} every provider id, in display order. */
export function llmProviderIds() {
  return LLM_PROVIDERS.map((provider) => provider.id);
}

/**
 * Resolve a provider id to its descriptor, tolerating case and stray spaces.
 * @param {unknown} value
 * @returns {(typeof LLM_PROVIDERS)[number]|null}
 */
export function llmProviderDescriptor(value) {
  const id = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!id) return null;
  // `llama.cpp`, `llama-cpp` and `llama_cpp` all mean llamacpp; people type
  // the product name, not the env token.
  const canonical = id.replace(/[.\-_\s]/g, '');
  return (
    LLM_PROVIDERS.find(
      (provider) => provider.id === id || provider.id === canonical,
    ) || null
  );
}

/**
 * Total: an unknown, empty, or hostile provider value resolves to OpenAI, so
 * a typo in `.env` degrades to today's behavior rather than a dead feature.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeLlmProvider(value) {
  return (llmProviderDescriptor(value) || llmProviderDescriptor('openai')).id;
}

/**
 * Normalize a base URL to an origin-plus-path with no trailing slash, or ''
 * when it is not a usable http(s) URL.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeLlmBaseUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  let parsed;
  try {
    // A bare `localhost:11434` is what people paste; give it a scheme rather
    // than refusing it (URL would otherwise read `localhost:` as a protocol).
    parsed = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`,
    );
  } catch {
    return '';
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return '';
  if (parsed.username || parsed.password) return '';
  if (parsed.search || parsed.hash) return '';
  // Collapse repeated separators and drop the trailing slash so the same
  // server typed three ways produces one canonical base.
  const path = parsed.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return `${parsed.origin}${path}`;
}

const LOOPBACK_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
]);

/**
 * Is this hostname on this machine or this LAN?
 *
 * The Provider Settings panel lets someone type a base URL and press "Test
 * connection", which makes the dev server fetch it — a request-forgery
 * primitive if any host were allowed. Probing is therefore restricted to
 * addresses that can only mean "a box I run": loopback, RFC-1918 / CGNAT-free
 * private ranges, link-local, unique-local IPv6, `.local`, and single-label
 * LAN hostnames. A base URL already committed to `.env` is the operator's own
 * decision and is probed as written.
 * @param {unknown} hostname
 */
export function isPrivateLlmHostname(hostname) {
  const host = String(hostname ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (LOOPBACK_HOSTNAMES.has(host)) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return false;
    const [a, b] = octets;
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (host.includes(':')) {
    // Unique-local (fc00::/7) and link-local (fe80::/10) only.
    return (
      /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host)
    );
  }
  if (host.endsWith('.local')) return true;
  return !host.includes('.');
}

/**
 * Whether a caller-supplied base URL may be probed at all.
 * @param {unknown} value
 */
export function isProbeableLlmBaseUrl(value) {
  const normalized = normalizeLlmBaseUrl(value);
  if (!normalized) return false;
  try {
    return isPrivateLlmHostname(new URL(normalized).hostname);
  } catch {
    return false;
  }
}

/**
 * Join a base URL and a provider path without doubling or dropping a slash.
 * @param {string} baseUrl
 * @param {string} path
 */
export function llmEndpointUrl(baseUrl, path) {
  const base = normalizeLlmBaseUrl(baseUrl);
  if (!base) return '';
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Resolve the effective LLM settings from an environment.
 *
 * Never returns a credential — only whether one is present — so the result is
 * safe to serialize straight into the Provider Settings payload.
 * @param {Record<string, string|undefined>} env e.g. process.env
 */
export function resolveLlmSettings(env = {}) {
  const requested = String(env[LLM_ENV_VARS.provider] ?? '').trim();
  const provider = llmProviderDescriptor(requested) || LLM_PROVIDERS[0];
  const providerFallback =
    requested !== '' && !llmProviderDescriptor(requested);
  const configuredBaseUrl = normalizeLlmBaseUrl(env[LLM_ENV_VARS.baseUrl]);
  const baseUrl = configuredBaseUrl || provider.defaultBaseUrl;
  const configuredModel = String(env[LLM_ENV_VARS.model] ?? '').trim();
  const model = configuredModel || provider.defaultModel;
  const apiKeyPresent = String(env.OPENAI_API_KEY ?? '').trim() !== '';
  return {
    provider: provider.id,
    label: provider.label,
    kind: provider.kind,
    api: provider.api,
    baseUrl,
    baseUrlSource: configuredBaseUrl ? 'env' : 'default',
    modelsUrl: llmEndpointUrl(baseUrl, provider.modelsPath),
    chatUrl: llmEndpointUrl(baseUrl, provider.chatPath),
    model,
    modelSource: configuredModel ? 'env' : model ? 'default' : 'unset',
    requiresKey: provider.requiresKey,
    apiKeyPresent,
    // 'configured' means "this backend could be called right now" — a hosted
    // provider needs its key, a local one only needs a usable URL. It says
    // nothing about whether the local server is actually up; that is the
    // probe's job and is reported separately as `reachable`.
    configured: provider.requiresKey ? apiKeyPresent : Boolean(baseUrl),
    capabilities: provider.capabilities,
    providerFallback,
  };
}

/**
 * Read a model list out of whatever the provider's discovery endpoint
 * returned. Total: junk yields an empty list rather than an exception.
 * @param {string} providerId
 * @param {unknown} payload Parsed JSON body.
 * @returns {string[]}
 */
export function parseLlmModelList(providerId, payload) {
  const provider = llmProviderDescriptor(providerId);
  const rows =
    provider?.id === 'ollama'
      ? Array.isArray(payload?.models)
        ? payload.models
        : []
      : Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.models)
          ? payload.models
          : [];
  const names = [];
  for (const row of rows) {
    const name =
      typeof row === 'string'
        ? row
        : String(row?.name ?? row?.id ?? row?.model ?? '');
    const trimmed = name.trim();
    // A model id is a short token. Anything else is a payload we do not
    // understand, and it must never reach the panel as text.
    if (!trimmed || trimmed.length > 200 || names.includes(trimmed)) continue;
    names.push(trimmed);
    if (names.length >= 100) break;
  }
  return names;
}

/**
 * Validate one LLM setting the panel is trying to save. Returns null when the
 * value is acceptable, or the human sentence explaining why it is not.
 * @param {string} envVar
 * @param {string} value Already trimmed, non-empty.
 * @returns {string|null}
 */
export function llmSettingProblem(envVar, value) {
  if (envVar === LLM_ENV_VARS.provider) {
    return llmProviderDescriptor(value)
      ? null
      : `${envVar} must be one of ${llmProviderIds().join(', ')}`;
  }
  if (envVar === LLM_ENV_VARS.baseUrl) {
    return normalizeLlmBaseUrl(value)
      ? null
      : `${envVar} must be an http(s) URL such as http://localhost:11434`;
  }
  if (envVar === LLM_ENV_VARS.model) {
    return value.length <= 200 ? null : `${envVar} is not a model id`;
  }
  return null;
}

/**
 * The serializable payload the Provider Settings panel renders its local-LLM
 * section from. Contains no credential material.
 * @param {Record<string, string|undefined>} env
 */
export function llmSettingsStatus(env = {}) {
  const settings = resolveLlmSettings(env);
  return {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    baseUrlSource: settings.baseUrlSource,
    model: settings.model,
    modelSource: settings.modelSource,
    configured: settings.configured,
    requiresKey: settings.requiresKey,
    apiKeyPresent: settings.apiKeyPresent,
    capabilities: settings.capabilities,
    envVars: { ...LLM_ENV_VARS },
    // Raw stored values, so the panel's fields show exactly what is saved
    // rather than a default it would then re-save as an explicit override.
    values: {
      [LLM_ENV_VARS.provider]: String(env[LLM_ENV_VARS.provider] ?? '').trim(),
      [LLM_ENV_VARS.baseUrl]: String(env[LLM_ENV_VARS.baseUrl] ?? '').trim(),
      [LLM_ENV_VARS.model]: String(env[LLM_ENV_VARS.model] ?? '').trim(),
    },
    providers: LLM_PROVIDERS.map((provider) => ({
      id: provider.id,
      label: provider.label,
      blurb: provider.blurb,
      kind: provider.kind,
      defaultBaseUrl: provider.defaultBaseUrl,
      defaultModel: provider.defaultModel,
      requiresKey: provider.requiresKey,
      capabilities: provider.capabilities,
    })),
    notes: [LLM_VOICE_LIMITATION_NOTE, LLM_LOCAL_CAPABILITY_NOTE],
  };
}
