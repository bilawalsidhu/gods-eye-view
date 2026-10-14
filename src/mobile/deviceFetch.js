import { CapacitorHttp } from '@capacitor/core';
import { createNativeFetch } from './nativeFetch.js';
import { FAMILY_HOSTS } from './upstreamRegistry.js';
import { setCctvCatalog } from './adapters/cctvDirect.js';
import { setOverpassMirrors } from './adapters/overpassDirect.js';

/**
 * Boot seam for on-device fetching: one place builds the native,
 * registry-enforced transport every direct adapter speaks, plus the
 * operator configuration those adapters need (Overpass mirrors, CCTV
 * catalog). Use only when `shouldUseDirect()` holds; the web and
 * backend-pointed paths keep their existing transports byte-identically.
 *
 * The native transport answers response-LIKE objects (no `.body` stream),
 * while the direct adapters read real `Response` bodies — so this seam
 * normalizes each answer into a real `Response` (status, headers, capped
 * bytes) before handing it to adapter code.
 *
 * @module mobile/deviceFetch
 */

/**
 * Resolve the native transport: an explicitly supplied handle wins, then a
 * platform-bridge handle when the host shell provides one, else the
 * Capacitor core handle.
 * @param {{ request: Function }|null|undefined} transport Explicit override.
 * @returns {{ request: Function }} Native transport.
 */
function resolveTransport(transport) {
  return transport ?? globalThis.Capacitor?.Http ?? CapacitorHttp;
}

/**
 * Create the on-device fetch for direct adapters.
 * @param {{ transport?: { request: Function }, registry?: Record<string, { hosts: string[], paths: RegExp[] }>, mirrors?: Array<string>|null, cctvCatalog?: Array<object>|null }} options Native transport override, registry override, and operator init (applied when provided).
 * @returns {(url: string|URL, init?: object) => Promise<Response>} fetchImpl returning real Responses.
 */
export function createDeviceFetch({
  transport,
  registry = FAMILY_HOSTS,
  mirrors = null,
  cctvCatalog = null,
} = {}) {
  if (Array.isArray(mirrors)) setOverpassMirrors(mirrors);
  if (Array.isArray(cctvCatalog)) setCctvCatalog(cctvCatalog);
  const native = createNativeFetch({
    transport: resolveTransport(transport),
    registry,
  });
  /**
   * Fetch through the native registry-enforced transport, normalized to a
   * real Response for adapter body readers. Redirect identity is preserved:
   * the `redirect` init option is forwarded to the transport, and the final
   * URL surfaces on the rebuilt Response (`url`/`redirected`) so origin
   * pins (HLS, TxDOT, same-host images) keep refusing followed redirects.
   * @param {string|URL} url Request URL.
   * @param {object} [init] Fetch init (method, headers, body, signal, redirect).
   * @returns {Promise<Response>} Real Response (status, headers, bytes, url).
   */
  return async function deviceFetch(url, init = {}) {
    init.signal?.throwIfAborted();
    const res = await native(url, init);
    const bytes = new Uint8Array(await res.arrayBuffer());
    init.signal?.throwIfAborted();
    const status = Number.isFinite(res.status) ? res.status : 500;
    const response = new Response(bytes, { status, headers: res.headers });
    const finalUrl = hrefOrNull(res.url) ?? hrefOrNull(url) ?? '';
    const requestedUrl = hrefOrNull(url) ?? '';
    // `Response.url`/`redirected` are prototype getters; shadow them per
    // instance so the transport-reported identity survives the rebuild.
    Object.defineProperties(response, {
      url: { value: finalUrl, enumerable: true },
      redirected: { value: finalUrl !== requestedUrl, enumerable: true },
    });
    return response;
  };
}

/**
 * Normalize a URL value to its href, or null when unparseable.
 * @param {string|URL} value Candidate URL.
 * @returns {string|null} Href, or null.
 */
function hrefOrNull(value) {
  try {
    if (typeof value === 'string' && value) return new URL(value).href;
    if (value instanceof URL) return value.href;
  } catch {
    /* unparseable: caller decides */
  }
  return null;
}
