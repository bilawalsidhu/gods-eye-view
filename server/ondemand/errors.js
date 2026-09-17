/**
 * Error shaping (contract §1 "Error envelope": `{errorCode, message}`) and
 * secret redaction. Every non-2xx upstream response is turned into
 * `{ error: 'upstream_error', status, upstream }` by shapeUpstreamError();
 * every "we were asked for a surface the live docs don't define" case uses
 * notDocumented() to produce the mandated 501 body instead of guessing.
 */

const MAX_UPSTREAM_TEXT = 2048; // 2 KB cap, per task spec

/**
 * Redact a secret for a LOG LINE: keep only the last 4 characters, replace
 * the rest with `***`. Never send the return value of this function to a
 * client — a redacted value still looks like a partial secret and belongs
 * only in server-side logs.
 * @param {string|undefined|null} secret
 * @returns {string}
 */
export function redactKey(secret) {
  if (secret === undefined || secret === null || secret === '')
    return '(unset)';
  const str = String(secret);
  if (str.length <= 4) return '***';
  return `***${str.slice(-4)}`;
}

/**
 * Build the `{error:'upstream_error', ...}` envelope for a non-2xx upstream
 * response. Reads the body as text (capped at 2 KB) and tries to parse the
 * documented `{errorCode, message}` shape; falls back to the capped raw text
 * when the body isn't JSON.
 * @param {Response} upstream
 * @returns {Promise<{error: string, status: number, upstream: unknown}>}
 */
export async function shapeUpstreamError(upstream) {
  let raw = '';
  try {
    raw = await upstream.text();
  } catch {
    raw = '';
  }
  const capped =
    raw.length > MAX_UPSTREAM_TEXT ? raw.slice(0, MAX_UPSTREAM_TEXT) : raw;
  let envelope = capped;
  try {
    const parsed = JSON.parse(capped);
    if (parsed && typeof parsed === 'object') envelope = parsed;
  } catch {
    // Not JSON — keep the capped text as-is.
  }
  return {
    error: 'upstream_error',
    status: upstream.status,
    upstream: envelope,
  };
}

/**
 * Shape a 501 "not documented" payload. Used whenever docs/ONDEMAND_API_CURRENT.md
 * marks a requested surface **NOT FOUND IN LIVE DOCS** — the handler must
 * refuse rather than invent a request/response schema.
 * @param {string} surface
 * @param {string} reference - contract section, e.g. '§3.3'.
 * @param {Record<string, unknown>} [extra]
 */
export function notDocumented(surface, reference, extra = {}) {
  return { error: 'not documented', surface, reference, ...extra };
}
