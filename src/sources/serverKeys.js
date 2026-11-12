/**
 * Server-held credentials, browser side.
 *
 * Cesium ion and Mapillary credentials stay on the server (see
 * server/providers/keyIsolation). The browser never receives CESIUM_ION_TOKEN
 * or MAPILLARY_CLIENT_TOKEN. The one key it does receive is the Google Maps
 * browser key, which the build defines into the bundle (restricted at Google,
 * see SECURITY.md). For ion and Mapillary it holds instead:
 *  - ION_SERVER_MANAGED: a marker (not a credential) meaning "ask this
 *    app's /api/ion/ for asset endpoints". CesiumJS then receives only the
 *    short-lived per-asset token ion issues for the asset it is loading.
 *  - for Mapillary, one boolean: whether the server holds a token. The
 *    Mapillary source resolves the Graph address itself: this origin's
 *    route, which adds the token.
 */

import { appBaseHref } from './appBaseUrl.js';

/** Stands in for an ion token in the app's credential plumbing. */
export const ION_SERVER_MANAGED = 'server-managed';

const ION_API_PATH = '/api/ion/';

/** How long the app waits for the server to say whether it holds an ion token. */
export const ION_STATUS_TIMEOUT_MS = 15_000;

/** Absolute URL of this app's ion API stand-in (trailing slash required by CesiumJS). */
export function ionServerUrl(base = appBaseHref()) {
  return new URL(ION_API_PATH, base).href;
}

/**
 * Options for IonResource.fromAssetId / IonImageryProvider.fromAssetId.
 * An explicit token (embedders, tests) is passed through unchanged; the
 * server-managed marker routes the endpoint request to this app instead and
 * sends no token at all (so the SDK's built-in default is not used either).
 * @param {string} credential
 * @param {string} [base]
 */
export function ionRequestOptions(credential, base) {
  const value = String(credential ?? '').trim();
  if (value === ION_SERVER_MANAGED)
    return { accessToken: '', server: ionServerUrl(base) };
  return { accessToken: value };
}

const MAPILLARY_API_PATH = '/api/mapillary/';

/**
 * Ask a same-origin status route whether the server holds a credential.
 * Never throws and never waits longer than `timeoutMs`: a missing route, a
 * refusal, an unreachable server, an answer that is not JSON and no answer at
 * all all read as false.
 * @param {string} path
 * @param {Function} fetchImpl
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function askConfigured(path, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const gaveUp = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(false);
    }, timeoutMs);
  });
  const asked = (async () => {
    try {
      const response = await fetchImpl(`${path}status`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) return false;
      const status = await response.json();
      return status?.configured === true;
    } catch {
      return false;
    }
  })();
  try {
    return await Promise.race([asked, gaveUp]);
  } finally {
    clearTimeout(timer);
  }
}

const pageFetch = (...args) => globalThis.fetch(...args);

/**
 * Whether the server holds an ion token: the server-managed marker, or ''
 * (which keeps the keyless map stacks) when it does not or cannot say.
 * @param {Function} [fetchImpl]
 * @param {{timeoutMs?: number}} [options]
 */
export async function fetchIonCredential(
  fetchImpl = pageFetch,
  { timeoutMs = ION_STATUS_TIMEOUT_MS } = {},
) {
  return (await askConfigured(ION_API_PATH, fetchImpl, timeoutMs))
    ? ION_SERVER_MANAGED
    : '';
}

/**
 * Whether the server holds a Mapillary token (a boolean, never the token).
 * Street Level reads it when it is constructed, to start on Mapillary or on
 * the first keyless source; false when the server cannot say in time.
 * @param {Function} [fetchImpl]
 * @param {{timeoutMs?: number}} [options]
 */
export function fetchMapillaryConfigured(
  fetchImpl = pageFetch,
  { timeoutMs = ION_STATUS_TIMEOUT_MS } = {},
) {
  return askConfigured(MAPILLARY_API_PATH, fetchImpl, timeoutMs);
}

/**
 * What the application learns from its server before it starts: both status
 * requests go out together, so startup waits for the slower one, not both.
 * @param {Function} [fetchImpl]
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{cesiumToken: string, mapillaryConfigured: boolean}>}
 */
export async function fetchServerKeyStatus(fetchImpl = pageFetch, options) {
  const [cesiumToken, mapillaryConfigured] = await Promise.all([
    fetchIonCredential(fetchImpl, options),
    fetchMapillaryConfigured(fetchImpl, options),
  ]);
  return { cesiumToken, mapillaryConfigured };
}
