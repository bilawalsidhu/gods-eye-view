/**
 * Low-level upstream fetch wrapper for every api/ondemand/*.js handler.
 *
 * Contract reference: docs/ONDEMAND_API_CURRENT.md §1 "Authentication" — the
 * header name is literally `apikey` (every OpenAPI security scheme; the one
 * "Authorization: Bearer" sentence in the guide has no matching example
 * anywhere in the fetched docs, so it is NOT used here).
 *
 * This module is the ONLY place that reads `config.apiKey` into a request.
 * It never logs it and never returns it to a caller.
 *
 * Per-request key override (added 2026-09-18, docs/ENTITY_CHAT.md "Key
 * override"): a browser may send its OWN OnDemand key as the request header
 * `x-ondemand-key`. `resolveRequestKey(req)` validates it (non-empty, at most
 * KEY_OVERRIDE_MAX_LEN chars, printable ASCII) and the resolved value is
 * threaded into `ondemandFetch(url, { apiKeyOverride })`, which uses it as
 * the upstream `apikey` INSTEAD of `config.apiKey` for that one call. This
 * is the single place the substitution happens. The value is never logged,
 * never echoed and never stored; callers only ever expose its SOURCE
 * ('request' | 'server') through the `X-OnDemand-Key-Source` response
 * header. health.js and selftest.js deliberately never call
 * resolveRequestKey, so the override cannot influence a diagnostic.
 */

import { config, requestTimeoutMs } from './config.js';

/** Request header carrying a caller-supplied OnDemand key (lower-case: Node
 * lower-cases every incoming header name). */
export const KEY_OVERRIDE_HEADER = 'x-ondemand-key';
/** Response header naming WHICH key was used: 'request' | 'server'. A name,
 * never a value. */
export const KEY_SOURCE_HEADER = 'X-OnDemand-Key-Source';
export const KEY_OVERRIDE_MAX_LEN = 128;
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

/**
 * Validate a candidate override key: a non-empty printable-ASCII string of
 * at most KEY_OVERRIDE_MAX_LEN characters (no spaces, no control bytes).
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidKeyOverride(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= KEY_OVERRIDE_MAX_LEN &&
    PRINTABLE_ASCII.test(value)
  );
}

/**
 * Read the `x-ondemand-key` header off a Node request.
 * @param {{ headers?: Record<string, string|string[]|undefined> }} req
 * @returns {{ apiKeyOverride: string|undefined, source: 'request'|'server', rejected: boolean }}
 *   `apiKeyOverride` is the validated key (undefined when absent/invalid);
 *   `rejected` is true when a header WAS present but failed validation, so a
 *   handler can answer 400 instead of silently falling back to the server key.
 */
export function resolveRequestKey(req) {
  const raw = req?.headers?.[KEY_OVERRIDE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null || value === '') {
    return { apiKeyOverride: undefined, source: 'server', rejected: false };
  }
  const trimmed = String(value).trim();
  if (!isValidKeyOverride(trimmed)) {
    return { apiKeyOverride: undefined, source: 'server', rejected: true };
  }
  return { apiKeyOverride: trimmed, source: 'request', rejected: false };
}

/**
 * Stamp the `X-OnDemand-Key-Source` response header (a NAME, never a value).
 * @param {{ setHeader: (k: string, v: string) => unknown }} res
 * @param {'request'|'server'} source
 */
export function setKeySourceHeader(res, source) {
  try {
    res.setHeader(
      KEY_SOURCE_HEADER,
      source === 'request' ? 'request' : 'server',
    );
  } catch {
    // headers already sent — nothing to stamp
  }
}

/**
 * `ondemandFetch` pre-bound to one request's key override, for code paths
 * that receive a fetch function rather than calling ondemandFetch directly
 * (the capability loop). Without an override this is ondemandFetch itself.
 * @param {string|undefined} apiKeyOverride
 * @returns {typeof ondemandFetch}
 */
export function bindOndemandFetch(apiKeyOverride) {
  if (!apiKeyOverride) return ondemandFetch;
  return (url, init = {}) => ondemandFetch(url, { ...init, apiKeyOverride });
}

function isPlainJsonBody(body) {
  if (body === undefined || body === null) return false;
  if (typeof body !== 'object') return false;
  if (typeof FormData !== 'undefined' && body instanceof FormData) return false;
  if (body instanceof ArrayBuffer) return false;
  if (ArrayBuffer.isView(body)) return false; // Buffer, Uint8Array, ...
  if (typeof Blob !== 'undefined' && body instanceof Blob) return false;
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream)
    return false;
  return true;
}

/**
 * @param {string} url - fully-qualified upstream URL.
 * @param {object} [init]
 * @param {string} [init.method] - default 'GET'.
 * @param {object|string|Buffer|FormData|undefined} [init.body] - a plain
 *   object is JSON-encoded and given `Content-Type: application/json`;
 *   anything else (Buffer/FormData/string) is sent as-is so multipart
 *   uploads keep their exact bytes and boundary (contract §5.2).
 * @param {Record<string,string>} [init.headers] - merged under the `apikey`
 *   header (never overridable by a caller).
 * @param {AbortSignal} [init.signal] - overrides the default timeout signal;
 *   used only by the chat SSE stream path, which aborts on client
 *   disconnect instead of a fixed timeout (contract §4).
 * @param {number} [init.timeoutMs] - overrides ONDEMAND_REQUEST_TIMEOUT_MS
 *   for this call only (used by health.js's short probe timeouts).
 * @param {string} [init.apiKeyOverride] - a caller-supplied key (already
 *   validated by resolveRequestKey) used as the upstream `apikey` for THIS
 *   call only, instead of config.apiKey. Anything that is not a valid
 *   override is ignored and the server key is used.
 * @returns {Promise<Response>} the raw upstream Response — never parsed
 *   here so callers can choose sync-JSON, SSE-pipe, or raw-bytes handling.
 */
export async function ondemandFetch(url, init = {}) {
  const {
    method = 'GET',
    body,
    headers = {},
    signal,
    timeoutMs,
    apiKeyOverride,
  } = init;

  const apikey = isValidKeyOverride(apiKeyOverride)
    ? apiKeyOverride
    : config.apiKey;
  const finalHeaders = { ...headers, apikey };
  let finalBody = body;
  if (isPlainJsonBody(body)) {
    finalHeaders['Content-Type'] = 'application/json';
    finalBody = JSON.stringify(body);
  }

  const effectiveSignal =
    signal ?? AbortSignal.timeout(timeoutMs ?? requestTimeoutMs());

  return fetch(url, {
    method,
    headers: finalHeaders,
    body: finalBody,
    signal: effectiveSignal,
  });
}
