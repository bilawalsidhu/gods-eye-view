/**
 * @module atcCustomStreams
 * @description Safe local storage manager and validator for custom ATC stream URLs
 * and LiveATC attribution links.
 *
 * Complies with LiveATC terms of service:
 * 1. Default action links out to LiveATC's page for the tuned airport with attribution.
 * 2. Custom stream URLs are stored in safe localStorage (https: only).
 */

const STORAGE_PREFIX = 'gev_atc_custom_stream_';

/**
 * Access `window.localStorage` safely without throwing SecurityError when
 * third-party storage or cookies are blocked.
 * @returns {Storage|null}
 */
export function safeWindowLocalStorage() {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage || null;
  } catch {
    return null;
  }
}

/**
 * Validate that a URL is a well-formed HTTPS stream endpoint.
 * Insecure HTTP, javascript:, data:, and relative schemes are rejected.
 * @param {string} url
 * @returns {boolean}
 */
export function isValidCustomStreamUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed.toLowerCase().startsWith('https://')) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * Normalize an ICAO identifier for storage indexing.
 * @param {string} icao
 * @returns {string|null}
 */
export function normalizeIcao(icao) {
  if (!icao || typeof icao !== 'string') return null;
  const trimmed = icao.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Generate official LiveATC search/listen URL for an airport.
 * @param {string} icao
 * @returns {string|null}
 */
export function getLiveAtcUrl(icao) {
  const norm = normalizeIcao(icao);
  if (!norm) return null;
  return `https://www.liveatc.net/search/?icao=${encodeURIComponent(norm.toLowerCase())}`;
}

/**
 * Retrieve a saved custom stream URL for an airport.
 * @param {string} icao
 * @param {Storage|null} [storage=safeWindowLocalStorage()]
 * @returns {string|null} Validated HTTPS stream URL or null
 */
export function getCustomStreamUrl(icao, storage = safeWindowLocalStorage()) {
  const norm = normalizeIcao(icao);
  if (!norm || !storage) return null;
  try {
    const raw = storage.getItem(`${STORAGE_PREFIX}${norm}`);
    if (isValidCustomStreamUrl(raw)) {
      return raw.trim();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Persist a custom stream URL for an airport.
 * @param {string} icao
 * @param {string} url Must be HTTPS
 * @param {Storage|null} [storage=safeWindowLocalStorage()]
 * @returns {{ ok: boolean, error?: string }}
 */
export function setCustomStreamUrl(
  icao,
  url,
  storage = safeWindowLocalStorage(),
) {
  const norm = normalizeIcao(icao);
  if (!norm) {
    return { ok: false, error: 'Invalid ICAO identifier' };
  }
  if (!isValidCustomStreamUrl(url)) {
    return {
      ok: false,
      error: 'Custom stream URL must be a valid https:// address',
    };
  }
  if (!storage) {
    return { ok: false, error: 'Local storage is unavailable' };
  }

  try {
    storage.setItem(`${STORAGE_PREFIX}${norm}`, url.trim());
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || 'Storage write failed' };
  }
}

/**
 * Remove a custom stream URL for an airport.
 * @param {string} icao
 * @param {Storage|null} [storage=safeWindowLocalStorage()]
 * @returns {boolean}
 */
export function removeCustomStreamUrl(
  icao,
  storage = safeWindowLocalStorage(),
) {
  const norm = normalizeIcao(icao);
  if (!norm || !storage) return false;
  try {
    storage.removeItem(`${STORAGE_PREFIX}${norm}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read all stored custom streams.
 * @param {Storage|null} [storage=safeWindowLocalStorage()]
 * @returns {Record<string, string>}
 */
export function getAllCustomStreams(storage = safeWindowLocalStorage()) {
  const result = {};
  if (!storage) return result;
  try {
    const len = storage.length || 0;
    for (let i = 0; i < len; i++) {
      const key = storage.key(i);
      if (key && key.startsWith(STORAGE_PREFIX)) {
        const icao = key.slice(STORAGE_PREFIX.length);
        const val = storage.getItem(key);
        if (isValidCustomStreamUrl(val)) {
          result[icao] = val.trim();
        }
      }
    }
  } catch {
    // Ignore storage read failures
  }
  return result;
}
