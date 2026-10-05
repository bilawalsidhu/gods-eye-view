export const RADIO_DIRECTORY_CACHE_MS = 45 * 60 * 1000;
export const RADIO_DIRECTORY_STALE_MS = 7 * 24 * 60 * 60 * 1000;
export const RADIO_MIRROR_CACHE_MS = 6 * 60 * 60 * 1000;
export const RADIO_FETCH_TIMEOUT_MS = 12_000;
export const RADIO_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
export const RADIO_DIRECTORY_LIMIT = 750;
export const RADIO_CATALOG_MIN_SUCCESSFUL_QUERIES = 5;
export const RADIO_CATALOG_HEALTHY_MIN_STATIONS = Math.ceil(
  RADIO_DIRECTORY_LIMIT / 2,
);
export const RADIO_USER_AGENT =
  'GodsEyeView/1.0 (Radio Browser directory client)';
export { RADIO_UUID_RE } from '../../../src/sources/radioBrowser.js';
export const RADIO_FALLBACK_MIRRORS = Object.freeze([
  'https://de1.api.radio-browser.info',
  'https://de2.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
]);
