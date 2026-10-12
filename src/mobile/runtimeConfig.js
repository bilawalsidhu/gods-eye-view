/** Storage and env key for the mobile API base override. */
export const API_BASE_STORAGE_KEY = 'GEV_API_BASE';

/** Same-origin service paths shared with `createApplicationRequestServices`. */
const SERVICE_PATHS = {
  boundaries: '/api/overpass',
  terrain: '/api/terrain/heights',
  regional: '/api/regional-brief',
  weather: '/api/weather-effects',
  summary: '/api/openai/hud-summary',
};

/**
 * Normalize a raw API base into `''` (same-origin) or `https://host[:port]`.
 * @param {string | undefined} raw Untrusted base value.
 * @returns {string} Trimmed base with no trailing slash, or `''` when unset
 * or not an http(s) host.
 */
export function resolveApiBase(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+$/i.test(trimmed)) return '';
  return trimmed;
}

/**
 * Prefix a service path with a resolved API base.
 * @param {string} base Resolved base (`''` for same-origin).
 * @param {string} path Service path starting with `/api/`.
 * @returns {string} Absolute URL when based, otherwise the path unchanged.
 */
export function joinApi(base, path) {
  if (typeof path !== 'string' || !path.startsWith('/api/')) {
    throw new TypeError('API path must start with /api/');
  }
  if (!base) return path;
  return `${base}${path}`;
}

/**
 * Map each request-service key to its URL for the given base.
 * @param {string} base Resolved base (`''` for same-origin).
 * @returns {Record<string, string>} Endpoints accepted by
 * `createApplicationRequestServices({ endpoints })`.
 */
export function endpointSet(base) {
  const prefix = resolveApiBase(base);
  return {
    boundaries: joinApi(prefix, SERVICE_PATHS.boundaries),
    terrain: joinApi(prefix, SERVICE_PATHS.terrain),
    regional: joinApi(prefix, SERVICE_PATHS.regional),
    weather: joinApi(prefix, SERVICE_PATHS.weather),
    summary: joinApi(prefix, SERVICE_PATHS.summary),
  };
}

/** Read a stored string without throwing outside a browser. */
function readStoredValue(key) {
  try {
    const storage = globalThis.localStorage;
    if (!storage || typeof storage.getItem !== 'function') return undefined;
    return storage.getItem(key);
  } catch {
    return undefined;
  }
}

/**
 * Read the stored API base override and resolve it. Build env wins, then
 * Node env, then `localStorage`; unset or invalid means same-origin.
 * @returns {string} Resolved base, or `''` (same-origin) when unset.
 */
export function storedApiBase() {
  const raw =
    import.meta.env?.[API_BASE_STORAGE_KEY] ??
    globalThis.process?.env?.[API_BASE_STORAGE_KEY] ??
    readStoredValue(API_BASE_STORAGE_KEY) ??
    '';
  return resolveApiBase(raw);
}
