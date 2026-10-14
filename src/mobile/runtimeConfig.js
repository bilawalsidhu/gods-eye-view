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
 * Normalize a raw API base into `''` (same-origin) or `http(s)://host[:port]`.
 * Plain `http://` stays allowed: a home server on LAN Wi-Fi is typically
 * plain HTTP. Strict-parse with `new URL`: only `http:`/`https:` with a host
 * and no path, userinfo, query, fragment, or whitespace is accepted;
 * everything else resolves to `''`.
 * @param {string | undefined} raw Untrusted base value.
 * @returns {string} Normalized `protocol//host` base, or `''` when unset
 * or invalid.
 */
export function resolveApiBase(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed || /\s/.test(trimmed)) return '';
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return '';
  }
  if (!parsed.hostname) return '';
  if (parsed.username || parsed.password) return '';
  if (parsed.search || parsed.hash) return '';
  if (parsed.pathname !== '/' && parsed.pathname !== '') return '';
  return `${parsed.protocol}//${parsed.host}`;
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
 * Read the stored API base override and resolve it. The `import.meta.env`
 * lookup is effectively dead in the browser bundle: Vite only inlines
 * `VITE_`-prefixed keys, and `GEV_API_BASE` is not one, so the browser path
 * resolves from the `localStorage`/Preferences mirror below. Node env still
 * applies outside the browser (SSR, tests), then `localStorage`; unset or
 * invalid means same-origin.
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
