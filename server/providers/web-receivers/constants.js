export const WEB_RECEIVERS_CACHE_MS = 30 * 60 * 1000;
export const WEB_RECEIVERS_STALE_MS = 7 * 24 * 60 * 60 * 1000;
export const WEB_RECEIVERS_FETCH_TIMEOUT_MS = 15_000;
export const WEB_RECEIVERS_RESPONSE_MAX_BYTES = 3 * 1024 * 1024;
/** A merged catalog smaller than this is treated as a failed refresh, not a directory. */
export const WEB_RECEIVERS_MIN_CATALOG = 50;
export const WEB_RECEIVERS_USER_AGENT =
  'GodsEyeView/1.0 (web receiver directory client)';
/**
 * The only two upstreams the proxy will ever fetch. Receiverbook's map page
 * embeds every listed OpenWebRX / WebSDR / KiwiSDR site with coordinates and
 * URLs; the community KiwiSDR map feed (a dyatlov map-maker instance) carries
 * the dynamic KiwiSDR data: band coverage, user slots, antenna, online state.
 * websdr.org's own list forbids reuse without permission and is NOT fetched.
 */
export const WEB_RECEIVERS_SOURCES = Object.freeze({
  receiverbook: 'https://www.receiverbook.de/map',
  kiwisdr: 'http://rx.linkfanel.net/kiwisdr_com.js',
});
