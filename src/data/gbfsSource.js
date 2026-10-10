/** Allowlisted GBFS hostnames; wildcard *.publicbikesystem.net also accepted. */
const GBFS_ALLOWED_HOSTS = new Set([
  'gbfs.lyft.com',
  'gbfs.bluebikes.com',
  'gbfs.bcycle.com',
  'gbfs.biketownpdx.com',
  'gbfs.cogobikeshare.com',
  'austin.publicbikesystem.net',
  'hon.publicbikesystem.net',
  'chat.publicbikesystem.net',
  'gbfs.urbansharing.com',
  'api.entur.io',
  'api.cyclocity.fr',
]);

/**
 * Hosts that serve more than GBFS keep the proxy to their GBFS tree: Entur's
 * api.entur.io fronts every Entur API, and api.cyclocity.fr every JCDecaux
 * contract endpoint.
 */
const GBFS_HOST_PATH_PREFIXES = new Map([
  ['api.entur.io', '/mobility/v2/gbfs/'],
  ['api.cyclocity.fr', '/contracts/'],
]);

/**
 * Identifying headers an operator asks every GBFS client to send. Entur rate
 * limits or blocks consumers that do not send ET-Client-Name, in the form
 * "company-application".
 */
const GBFS_HOST_HEADERS = new Map([
  [
    'api.entur.io',
    Object.freeze({ 'ET-Client-Name': 'gods-eye-view-bikeshare' }),
  ],
]);

/**
 * Check whether a hostname is in the GBFS allowlist.
 *
 * Also accepts any subdomain of publicbikesystem.net.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
export function isAllowedGbfsHost(hostname) {
  const host = String(hostname || '')
    .trim()
    .toLowerCase();
  if (!host) return false;
  if (GBFS_ALLOWED_HOSTS.has(host)) return true;
  return host.endsWith('.publicbikesystem.net');
}

/**
 * Only allow station_information and station_status endpoints. The `.json`
 * suffix is optional because Entur serves its feeds without one. When a
 * hostname is given and that host serves more than GBFS, the path must also
 * sit under the host's GBFS prefix.
 *
 * @param {string} pathname
 * @param {string} [hostname]
 * @returns {boolean}
 */
export function isAllowedGbfsPath(pathname, hostname = '') {
  const path = String(pathname || '');
  if (!/\/station_(information|status)(\.json)?$/i.test(path)) return false;
  const prefix = GBFS_HOST_PATH_PREFIXES.get(
    String(hostname || '')
      .trim()
      .toLowerCase(),
  );
  return !prefix || path.startsWith(prefix);
}

/**
 * Extra request headers an upstream GBFS host asks clients to send.
 *
 * @param {string} hostname
 * @returns {Record<string, string>}
 */
export function gbfsUpstreamHeaders(hostname) {
  return (
    GBFS_HOST_HEADERS.get(
      String(hostname || '')
        .trim()
        .toLowerCase(),
    ) || {}
  );
}

/**
 * Return an appropriate Cache-Control header for a GBFS endpoint.
 *
 * station_information is semi-static (5 min cache); station_status is
 * real-time (no-store).
 *
 * @param {string} pathname
 * @returns {string} Cache-Control header value.
 */
export function gbfsCacheControl(pathname) {
  if (/\/station_information(\.json)?$/i.test(String(pathname || ''))) {
    return 'public, max-age=300';
  }
  return 'no-store';
}
