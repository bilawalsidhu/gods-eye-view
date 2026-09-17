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
 */

import { config, requestTimeoutMs } from './config.js';

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
 * @returns {Promise<Response>} the raw upstream Response — never parsed
 *   here so callers can choose sync-JSON, SSE-pipe, or raw-bytes handling.
 */
export async function ondemandFetch(url, init = {}) {
  const { method = 'GET', body, headers = {}, signal, timeoutMs } = init;

  const finalHeaders = { ...headers, apikey: config.apiKey };
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
