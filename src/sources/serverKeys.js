/**
 * Server-held credentials, browser side.
 *
 * Cesium ion and Mapillary credentials stay on the server (see
 * server/providers/keyIsolation). The browser never receives CESIUM_ION_TOKEN,
 * MAPILLARY_CLIENT_TOKEN or GOOGLE_MAPS_API_KEY. What it holds instead:
 *  - ION_SERVER_MANAGED: a marker (not a credential) meaning "ask this
 *    app's /api/ion/ for asset endpoints". CesiumJS then receives only the
 *    short-lived per-asset token ion issues for the asset it is loading.
 *  - the Mapillary Graph endpoint on this origin, which adds the token.
 */

/** Stands in for an ion token in the app's credential plumbing. */
export const ION_SERVER_MANAGED = 'server-managed';

const ION_API_PATH = '/api/ion/';
const MAPILLARY_GRAPH_PATH = '/api/mapillary/graph/';

const baseHref = () => globalThis.location?.href ?? 'http://localhost/';

/** Absolute URL of this app's ion API stand-in (trailing slash required by CesiumJS). */
export function ionServerUrl(base = baseHref()) {
  return new URL(ION_API_PATH, base).href;
}

/** Absolute Graph endpoint for MapillaryJS (`new URL(path, endpoint)` needs the slash). */
export function mapillaryGraphEndpoint(base = baseHref()) {
  return new URL(MAPILLARY_GRAPH_PATH, base).href;
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

/**
 * Whether the server holds an ion token. Never throws: any failure reads as
 * "not configured", which keeps the keyless map stacks.
 * @param {Function} [fetchImpl]
 */
export async function fetchIonCredential(
  fetchImpl = (...args) => globalThis.fetch(...args),
) {
  try {
    const response = await fetchImpl(`${ION_API_PATH}status`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) return '';
    const status = await response.json();
    return status?.configured === true ? ION_SERVER_MANAGED : '';
  } catch {
    return '';
  }
}
