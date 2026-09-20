import {
  resolveLlmSettings,
  LLM_ENV_VARS,
  normalizeLlmBaseUrl,
  llmProviderDescriptor,
} from '../../../src/llmSettings.mjs';

/**
 * Server-side view of the LLM settings.
 *
 * src/llmSettings.mjs stays credential-free so its payload can be handed to
 * the browser verbatim. This module is the one place that pairs those
 * settings with the key, and nothing here reads process.env at import time —
 * Vite's loadEnv copies `.env` into process.env AFTER these modules are
 * imported, so a module-scope read would always see it unset.
 */

/** Model-discovery probes must be fast: the panel blocks on them. */
export const LLM_PROBE_TIMEOUT_MS = 4000;

/** A local model on CPU is slow; the HUD summary is five words, not an essay. */
export const LLM_CHAT_TIMEOUT_MS = 20_000;

/**
 * A fetch bound to globalThis. undici's fetch throws "Illegal invocation"
 * when detached from its receiver, so every default in this package is built
 * this way rather than passing `globalThis.fetch` itself.
 */
export function boundFetch() {
  return (...args) => globalThis.fetch(...args);
}

/**
 * Resolve the live LLM configuration, including the key when the provider
 * needs one. Local providers never carry a key.
 * @param {Record<string, string|undefined>} env
 */
export function llmRuntimeConfig(env = process.env) {
  const settings = resolveLlmSettings(env);
  return {
    ...settings,
    apiKey: settings.requiresKey ? String(env.OPENAI_API_KEY ?? '').trim() : '',
  };
}

/**
 * Build a runtime config for an explicitly requested provider/base URL — what
 * "Test connection" uses so the panel can probe a server before committing it
 * to the store. Anything omitted falls back to the live environment.
 * @param {{provider?: unknown, baseUrl?: unknown, env?: Record<string, string|undefined>}} input
 */
export function llmRequestedConfig({
  provider,
  baseUrl,
  env = process.env,
} = {}) {
  const descriptor = llmProviderDescriptor(provider);
  const overrides = { ...env };
  if (descriptor) overrides[LLM_ENV_VARS.provider] = descriptor.id;
  const normalizedBaseUrl = normalizeLlmBaseUrl(baseUrl);
  if (normalizedBaseUrl) overrides[LLM_ENV_VARS.baseUrl] = normalizedBaseUrl;
  return llmRuntimeConfig(overrides);
}

/**
 * Authorization headers for a request to this provider. Local servers accept
 * (and ignore) a missing key, so we simply do not send one.
 * @param {{apiKey?: string}} config
 */
export function llmAuthHeaders(config) {
  return config?.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
}
