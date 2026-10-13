import { CapacitorHttp } from '@capacitor/core';
import {
  readResponseBytesCapped,
  readResponseJsonCapped,
  readResponseTextCapped,
} from '../sources/httpBody.js';
import { FAMILY_HOSTS, isUrlAllowedByRegistry } from './upstreamRegistry.js';

/**
 * `fetchImpl`-compatible fetch over core `CapacitorHttp` (native, bypasses
 * CORS) with per-family host+path allowlists and byte caps.
 *
 * The allowlist is checked before any network traffic: unknown hosts,
 * non-HTTP(S) schemes, and key-carrying query strings over plain HTTP are
 * refused with `{ code: 'UPSTREAM_NOT_ALLOWED' }` without touching the
 * transport. Bodies always travel as `arraybuffer` (base64 on the native
 * bridge) and are decoded once, then every accessor (`json` / `text` /
 * `arrayBuffer`) re-enforces the byte cap through the shared capped
 * readers in `src/sources/httpBody.js` — caps are never reimplemented
 * here. This module attaches no credentials; adapters (Tasks 3-5) add
 * vault keys to URLs that are always HTTPS by this point.
 *
 * Transport shape (mirrors `CapacitorHttp`): an object with
 * `request({ url, method, headers, data, responseType })` resolving to
 * `{ data, status, headers, url }`, where `data` is a base64 string for
 * `responseType: 'arraybuffer'`. Transport rejections propagate to the
 * caller untouched (never swallowed, never retried here).
 *
 * @module mobile/nativeFetch
 */

/** Default ceiling applied to any response body (bytes) when no cap is given. */
export const DEFAULT_CAP_BYTES = 2 * 1024 * 1024;

/**
 * Lowercase query-parameter names treated as credentials. Any URL carrying
 * one of these over plain HTTP is refused before network.
 */
export const KEY_QUERY_PARAMS = Object.freeze([
  'key',
  'api_key',
  'apikey',
  'api-key',
  'access_token',
  'token',
  'auth',
  'map_key',
  'mapkey',
  'client_secret',
]);

/**
 * Whether a URL carries a credential-like query parameter. The check is
 * name-only and never logs or echoes parameter values.
 * @param {string|URL} url Request URL.
 * @returns {boolean} True when a known key parameter is present.
 */
export function carriesQueryKey(url) {
  let parsed;
  try {
    parsed = url instanceof URL ? url : new URL(String(url));
  } catch {
    return false;
  }
  const names = new Set(KEY_QUERY_PARAMS);
  for (const name of parsed.searchParams.keys()) {
    if (names.has(String(name).toLowerCase())) return true;
  }
  return false;
}

/**
 * Build a refusal error. Messages name only the host — never the query
 * string, which may carry a key.
 * @param {string} hostname Request hostname.
 * @param {string} reason Short refusal reason (no secrets, no query).
 * @returns {Error} Error with `code: 'UPSTREAM_NOT_ALLOWED'`.
 */
function refuseUpstream(hostname, reason) {
  return Object.assign(
    new Error(`Upstream not allowed for host "${hostname}": ${reason}`),
    { code: 'UPSTREAM_NOT_ALLOWED' },
  );
}

/**
 * Normalize fetch-style headers (Headers instance, pair list, or object)
 * to the plain object `CapacitorHttp` expects.
 * @param {Headers|Array<[string, string]>|Record<string, string>|undefined} headers Fetch-style headers.
 * @returns {Record<string, string>} Plain header object.
 */
function normalizeRequestHeaders(headers) {
  if (!headers) return {};
  if (typeof headers.forEach === 'function') {
    const out = {};
    headers.forEach((value, name) => {
      out[String(name)] = String(value);
    });
    return out;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(
      headers.map(([name, value]) => [String(name), String(value)]),
    );
  }
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([name, value]) => [String(name), String(value)]),
  );
}

/**
 * Decode a base64 string to bytes without Node builtins (portable to the
 * Android WebView, where `Buffer` does not exist).
 * @param {string} base64 Base64-encoded payload.
 * @returns {Uint8Array} Decoded bytes.
 */
function base64ToBytes(base64) {
  const binary = atob(String(base64));
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    out[index] = binary.charCodeAt(index);
  }
  return out;
}

/**
 * Normalize a transport `data` payload to bytes. Real `CapacitorHttp`
 * `arraybuffer` responses arrive base64-encoded; objects and text are
 * accepted defensively for stub transports.
 * @param {*} data Transport response payload.
 * @returns {Uint8Array} Response body bytes.
 */
function transportDataToBytes(data) {
  if (data === null || data === undefined) return new Uint8Array(0);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data !== 'string') {
    return new TextEncoder().encode(JSON.stringify(data));
  }
  if (data === '') return new Uint8Array(0);
  return base64ToBytes(data);
}

/**
 * Normalize a transport headers object to a `Headers` instance.
 * @param {Record<string, *>|undefined} headers Transport response headers.
 * @returns {Headers} Header map.
 */
function toHeaders(headers) {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === null || value === undefined) continue;
    result.set(String(name), String(value));
  }
  return result;
}

/**
 * Create a `fetchImpl`-compatible fetch over a `CapacitorHttp`-shaped
 * transport with registry allowlists and shared byte caps.
 * @param {{ transport?: { request: Function }, registry?: Record<string, { hosts: string[], paths: RegExp[] }>, defaultCapBytes?: number }} options Transport, registry, and default byte cap.
 * @returns {(url: string|URL, init?: { method?: string, headers?: *, body?: string, signal?: AbortSignal, capBytes?: number }) => Promise<{ status: number, ok: boolean, headers: Headers, url: string, json: Function, text: Function, arrayBuffer: Function }>} fetchImpl with `(url, init)` signature.
 */
export function createNativeFetch({
  transport = CapacitorHttp,
  registry = FAMILY_HOSTS,
  defaultCapBytes = DEFAULT_CAP_BYTES,
} = {}) {
  if (!transport || typeof transport.request !== 'function') {
    throw new TypeError('createNativeFetch needs a transport with request()');
  }
  /**
   * Fetch a URL through the native transport after allowlist checks.
   * @param {string|URL} url Request URL.
   * @param {{ method?: string, headers?: *, body?: string, signal?: AbortSignal, capBytes?: number }} init Fetch-style options plus an optional per-request `capBytes` override.
   * @returns {Promise<{ status: number, ok: boolean, headers: Headers, url: string, json: Function, text: Function, arrayBuffer: Function }>} Response-like with capped body accessors.
   */
  async function nativeFetch(url, init = {}) {
    init.signal?.throwIfAborted();
    let parsed;
    try {
      parsed = url instanceof URL ? url : new URL(String(url));
    } catch {
      throw refuseUpstream('(unparseable)', 'unparseable URL');
    }
    if (!isUrlAllowedByRegistry(parsed, registry)) {
      throw refuseUpstream(parsed.hostname, 'host or path not registered');
    }
    if (parsed.protocol !== 'https:' && carriesQueryKey(parsed)) {
      throw refuseUpstream(parsed.hostname, 'keyed traffic requires HTTPS');
    }
    const capBytes =
      Number.isFinite(init.capBytes) && init.capBytes >= 0
        ? init.capBytes
        : defaultCapBytes;
    const result = await transport.request({
      url: parsed.href,
      method: init.method ?? 'GET',
      headers: normalizeRequestHeaders(init.headers),
      data: init.body ?? undefined,
      responseType: 'arraybuffer',
      // Follow/fetch semantics are the transport's to honor; adapters that
      // pin origins (HLS, TxDOT, same-host images) require the refusal to
      // reach the transport instead of being silently followed.
      redirect: init.redirect ?? 'follow',
    });
    const bytes = transportDataToBytes(result?.data);
    const status = Number(result?.status);
    const headers = toHeaders(result?.headers);
    const bodyOf = () => new Response(bytes, { headers });
    return {
      status,
      ok: status >= 200 && status < 300,
      headers,
      url: typeof result?.url === 'string' ? result.url : parsed.href,
      json: () => readResponseJsonCapped(bodyOf(), capBytes, init.signal),
      text: () => readResponseTextCapped(bodyOf(), capBytes, init.signal),
      arrayBuffer: async () => {
        const out = await readResponseBytesCapped(
          bodyOf(),
          capBytes,
          init.signal,
        );
        return out.slice().buffer;
      },
    };
  }
  return nativeFetch;
}
