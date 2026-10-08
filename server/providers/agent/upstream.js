import {
  normalizeOllamaModel,
  normalizeOpenAiModel,
  normalizeOpenRouterModel,
  ollamaNativeRoot,
} from './registry.js';

/**
 * Talks to whichever OpenAI-compatible back end the operator selected.
 *
 * `fetch` is injected rather than imported so every path here runs under
 * `node --test` without a network or a key. The functions are otherwise
 * ordinary: build a URL, attach auth, bound the wait, normalize the answer.
 *
 * Error text crossing back to the browser is sanitized on purpose. Upstream
 * bodies can echo request headers, and this server holds the operator's keys.
 */

/** Upstream wait ceiling for a model listing. Listings are small. */
const MODELS_TIMEOUT_MS = 10_000;

/** Upstream wait ceiling for one completion from a hosted provider. */
const COMPLETION_TIMEOUT_MS = 120_000;

/**
 * Wait ceiling for a local completion.
 *
 * A local daemon's first command after start pays for loading the model into
 * VRAM before it processes a token, on top of a prefix of many thousand
 * tokens. Measured cold on an 8 GB card that exceeded the hosted ceiling
 * outright, so a local provider gets its own budget rather than reporting a
 * timeout that is really a cold start.
 */
const LOCAL_COMPLETION_TIMEOUT_MS = 300_000;

/** Wait ceiling for one Ollama capability probe. */
const CAPABILITY_TIMEOUT_MS = 5_000;

/** Concurrent Ollama capability probes. A local daemon is easy to overwhelm. */
const CAPABILITY_PROBE_CONCURRENCY = 4;

/** Models probed for capabilities before falling back to assumptions. */
const CAPABILITY_PROBE_LIMIT = 40;

/** Longest upstream error snippet echoed to the browser. */
const ERROR_SNIPPET_CHARS = 240;

/** Response body ceiling, guarding against a hostile or broken upstream. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * The completion budget appropriate to a provider.
 *
 * @param {{kind?: string}|null} provider
 * @returns {number}
 */
function completionTimeoutFor(provider) {
  return provider?.kind === 'local'
    ? LOCAL_COMPLETION_TIMEOUT_MS
    : COMPLETION_TIMEOUT_MS;
}

/**
 * Compose the models-listing URL.
 *
 * `modelsPath` may already carry a query string (OpenRouter filters upstream),
 * so this concatenates rather than parsing.
 *
 * @param {{modelsPath: string}} provider
 * @param {string} baseUrl
 * @returns {string}
 */
function modelsUrl(provider, baseUrl) {
  return `${baseUrl}${provider.modelsPath}`;
}

/**
 * Compose the chat-completions URL.
 *
 * @param {string} baseUrl
 * @returns {string}
 */
function chatCompletionsUrl(baseUrl) {
  return `${baseUrl}/chat/completions`;
}

/**
 * Headers for an upstream call.
 *
 * OpenRouter asks callers to identify themselves for attribution; sending a
 * fixed project identity is preferable to leaking the operator's own host.
 *
 * @param {{id?: string}|null} provider
 * @param {string|null} apiKey
 * @returns {Record<string,string>}
 */
function authHeaders(provider, apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (provider?.id === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/bilawalsidhu/gods-eye-view';
    headers['X-Title'] = "God's Eye View";
  }
  return headers;
}

/**
 * Reduce an upstream failure to something safe and useful.
 *
 * Never includes headers or the request body, either of which can carry the
 * key, and never relays the provider's own error wording, which carries
 * request ids, organization hints and quota phrasing.
 *
 * @param {number} status
 * @param {string} body
 * @returns {string}
 */
function normalizeUpstreamError(status, body) {
  if (status === 401 || status === 403) {
    return 'Upstream rejected the credentials for this provider. Check the configured API key.';
  }
  if (status === 404) {
    return 'Upstream has no such model or endpoint. Check the selected model id.';
  }
  if (status === 429) {
    return 'Upstream rate limit reached. Wait a moment and retry.';
  }
  if (status >= 500) {
    return `Upstream provider error (HTTP ${status}).`;
  }
  const snippet =
    typeof body === 'string'
      ? body.slice(0, ERROR_SNIPPET_CHARS).replace(/\s+/g, ' ').trim()
      : '';
  return snippet
    ? `Upstream rejected the request (HTTP ${status}): ${snippet}`
    : `Upstream rejected the request (HTTP ${status}).`;
}

/**
 * Turn a thrown transport error into operator-facing guidance.
 *
 * A refused connection to a local daemon is the single most likely failure in
 * this whole feature, so it gets a specific message rather than a stack trace.
 *
 * @param {unknown} error
 * @param {{provider?: object|null, baseUrl?: string}} [context]
 * @returns {string}
 */
function describeTransportError(error, { provider, baseUrl } = {}) {
  const code = error?.cause?.code || error?.code;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return `Timed out waiting for ${provider?.label || 'the provider'}.`;
  }
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return provider?.kind === 'local'
      ? `Cannot reach ${provider.label} at ${baseUrl}. Is the daemon running?`
      : `Cannot reach ${provider?.label || 'the provider'}.`;
  }
  return `Request to ${provider?.label || 'the provider'} failed.`;
}

/**
 * Read a bounded JSON response.
 *
 * @param {Response} response
 * @returns {Promise<{ok: boolean, status: number, data: any, text: string}>}
 */
async function readJsonResponse(response) {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error('Upstream response exceeded the size limit');
  }
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { ok: response.ok, status: response.status, data, text };
}

/** Run a fetch with a timeout that always clears its own timer. */
async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe one Ollama model's capabilities through the native `/api/show`.
 *
 * Returns null on any failure: a daemon without the endpoint should degrade to
 * assumed capabilities rather than lose the model from the picker entirely.
 *
 * @param {{baseUrl: string, modelId: string, fetchImpl: Function, timeoutMs?: number}} options
 * @returns {Promise<object|null>}
 */
async function fetchOllamaCapabilities({
  baseUrl,
  modelId,
  fetchImpl,
  timeoutMs = CAPABILITY_TIMEOUT_MS,
}) {
  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      `${ollamaNativeRoot(baseUrl)}/api/show`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId }),
      },
      timeoutMs,
    );
    if (!response.ok) return null;
    const { data } = await readJsonResponse(response);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

/** Run tasks with a bounded number in flight, preserving input order. */
async function mapWithConcurrency(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await task(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** Provider id to its normalizer. */
const NORMALIZERS = Object.freeze({
  openai: normalizeOpenAiModel,
  openrouter: normalizeOpenRouterModel,
  ollama: normalizeOllamaModel,
});

/**
 * List the models a provider offers, normalized to the shared shape.
 *
 * Ollama additionally gets a bounded capability probe, because its
 * OpenAI-compatible listing reports neither tool support nor context length,
 * and the context length is what catches the 4096-default trap.
 *
 * @param {{provider: object, baseUrl: string, apiKey: string|null,
 *   fetchImpl: Function, timeoutMs?: number, probeLimit?: number}} options
 * @returns {Promise<{ok: true, models: object[]} | {ok: false, error: string}>}
 */
async function fetchModels({
  provider,
  baseUrl,
  apiKey,
  fetchImpl,
  timeoutMs = MODELS_TIMEOUT_MS,
  probeLimit = CAPABILITY_PROBE_LIMIT,
}) {
  let response;
  try {
    response = await fetchWithTimeout(
      fetchImpl,
      modelsUrl(provider, baseUrl),
      { method: 'GET', headers: authHeaders(provider, apiKey) },
      timeoutMs,
    );
  } catch (error) {
    return {
      ok: false,
      error: describeTransportError(error, { provider, baseUrl }),
    };
  }

  const { ok, status, data, text } = await readJsonResponse(response);
  if (!ok) return { ok: false, error: normalizeUpstreamError(status, text) };

  const rows = Array.isArray(data?.data) ? data.data : [];
  const normalize = NORMALIZERS[provider.id];
  if (!normalize)
    return { ok: false, error: 'No normalizer for this provider.' };

  if (provider.id !== 'ollama') {
    return {
      ok: true,
      models: rows.map((row) => normalize(row)).filter(Boolean),
    };
  }

  const probed = rows.slice(0, probeLimit);
  const details = await mapWithConcurrency(
    probed,
    CAPABILITY_PROBE_CONCURRENCY,
    (row) => fetchOllamaCapabilities({ baseUrl, modelId: row?.id, fetchImpl }),
  );
  const models = probed
    .map((row, index) => normalize(row, details[index]))
    .filter(Boolean);
  // Anything beyond the probe budget still appears, just without metadata.
  const unprobed = rows
    .slice(probeLimit)
    .map((row) => normalize(row, null))
    .filter(Boolean);
  return { ok: true, models: [...models, ...unprobed] };
}

/**
 * Request one chat completion.
 *
 * `tool_choice` is deliberately never sent: Ollama's compatible endpoint does
 * not accept it, and sending it to only some providers would make the tool
 * loop behave differently per back end for no gain. The malformed-call
 * correction loop exists because of exactly that.
 *
 * @param {{provider: object, baseUrl: string, apiKey: string|null, model: string,
 *   messages: object[], tools?: object[], fetchImpl: Function,
 *   timeoutMs?: number}} options
 * @returns {Promise<{ok: true, message: object, finishReason: string|null,
 *   usage: object|null, model: string} | {ok: false, error: string, status?: number}>}
 */
async function requestChatCompletion({
  provider,
  baseUrl,
  apiKey,
  model,
  messages,
  tools,
  fetchImpl,
  timeoutMs,
}) {
  const budget = Number.isFinite(timeoutMs)
    ? timeoutMs
    : completionTimeoutFor(provider);
  const body = { model, messages };
  if (Array.isArray(tools) && tools.length) body.tools = tools;

  let response;
  try {
    response = await fetchWithTimeout(
      fetchImpl,
      chatCompletionsUrl(baseUrl),
      {
        method: 'POST',
        redirect: 'error',
        headers: authHeaders(provider, apiKey),
        body: JSON.stringify(body),
      },
      budget,
    );
  } catch (error) {
    return {
      ok: false,
      error: describeTransportError(error, { provider, baseUrl }),
    };
  }

  const { ok, status, data, text } = await readJsonResponse(response);
  if (!ok)
    return { ok: false, status, error: normalizeUpstreamError(status, text) };

  const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
  if (!choice?.message) {
    return { ok: false, status, error: 'Upstream returned no message.' };
  }

  return {
    ok: true,
    message: choice.message,
    finishReason:
      typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    usage: data?.usage && typeof data.usage === 'object' ? data.usage : null,
    model: typeof data?.model === 'string' ? data.model : model,
  };
}

export {
  CAPABILITY_PROBE_CONCURRENCY,
  CAPABILITY_PROBE_LIMIT,
  CAPABILITY_TIMEOUT_MS,
  COMPLETION_TIMEOUT_MS,
  LOCAL_COMPLETION_TIMEOUT_MS,
  MODELS_TIMEOUT_MS,
  authHeaders,
  chatCompletionsUrl,
  completionTimeoutFor,
  describeTransportError,
  fetchModels,
  fetchOllamaCapabilities,
  modelsUrl,
  normalizeUpstreamError,
  requestChatCompletion,
};
