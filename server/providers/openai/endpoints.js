/**
 * Where the server sends OpenAI API-key traffic.
 *
 * `OPENAI_BASE_URL` (the OpenAI SDK's own variable name) points the HUD
 * summary and Realtime secret minting at an OpenAI-compatible gateway such as
 * LiteLLM instead of api.openai.com. When it is set, the browser's Realtime
 * SDP exchange is relayed through this server too (`/api/realtime/calls`), so
 * the browser never needs to reach the gateway directly.
 *
 * ChatGPT OAuth voice is not affected: that bearer belongs to OpenAI and is
 * only ever sent to OPENAI_DEFAULT_BASE_URL.
 */

const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/** Same-origin path the browser posts its SDP offer to when relayed. */
const REALTIME_CALLS_RELAY_PATH = '/api/realtime/calls';

/**
 * Resolve the configured base URL. An unset, empty, non-http(s), or
 * credential-bearing value falls back to the OpenAI default, so a typo can
 * never send a key somewhere unintended by accident of parsing.
 *
 * @param {Record<string, string|undefined>} [environment]
 * @returns {string} base URL without a trailing slash
 */
function openAiBaseUrl(environment = process.env) {
  const raw = String(environment.OPENAI_BASE_URL ?? '').trim();
  if (!raw) return OPENAI_DEFAULT_BASE_URL;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    console.warn('[openai] OPENAI_BASE_URL is not a URL; using the default');
    return OPENAI_DEFAULT_BASE_URL;
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    console.warn(
      '[openai] OPENAI_BASE_URL must be a plain http(s) URL; using the default',
    );
    return OPENAI_DEFAULT_BASE_URL;
  }
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
}

/** Whether API-key traffic goes somewhere other than api.openai.com. */
function usesCustomOpenAiBaseUrl(environment = process.env) {
  return openAiBaseUrl(environment) !== OPENAI_DEFAULT_BASE_URL;
}

/**
 * @param {string} path endpoint path below the base, e.g. `responses`
 * @param {{ environment?: Record<string, string|undefined>, oauth?: boolean }} [options]
 */
function openAiEndpoint(
  path,
  { environment = process.env, oauth = false } = {},
) {
  const base = oauth ? OPENAI_DEFAULT_BASE_URL : openAiBaseUrl(environment);
  return `${base}/${String(path).replace(/^\/+/, '')}`;
}

export {
  OPENAI_DEFAULT_BASE_URL,
  REALTIME_CALLS_RELAY_PATH,
  openAiBaseUrl,
  openAiEndpoint,
  usesCustomOpenAiBaseUrl,
};
