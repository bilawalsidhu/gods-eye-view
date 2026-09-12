/**
 * HamRig REST client (Node-only; used by the Vite dev/preview proxy in
 * `src/hamrig/proxy.js`). Contract §1.2.
 *
 * Responsibilities:
 * - build `${baseUrl}${path}?${query}` URLs for `/api/...` routes only,
 * - lazily log in (`POST /api/auth/login`) the first time a call asks for
 *   `auth: true`, cache the bearer token, and renew it when it is about to
 *   expire (the real expiry is the unix-seconds middle segment of the token —
 *   HamRig's `expires_in: 3600` is not the token lifetime, which is 30 days),
 * - retry exactly once after an upstream 401 (re-login in between),
 * - return `{ status, json, text }` for every HTTP answer (non-2xx included),
 *   and throw only on network / timeout / abort errors,
 * - never log or return the token or the password.
 *
 * Login failures never throw: an `auth: true` call whose login failed resolves
 * to `{ status: 401, json: null, text: '', error }` so a proxy route can map it
 * to its own response without a try/catch. A failed login is not retried for
 * `LOGIN_FAILURE_BACKOFF_MS` so a wrong password in `.env` cannot hammer the
 * upstream login endpoint (HamRig logs every attempt).
 */

/** HamRig session token: `user_<id>_<unixExpirySeconds>_<hmac-sha256 hex>`. */
const TOKEN_PATTERN = /^user_(\d+)_(\d+)_([a-f0-9]{64})$/i;

/** Renew a cached token when less than this remains (contract: < 1 day). */
const TOKEN_RENEW_MARGIN_MS = 24 * 60 * 60 * 1000;

/** Documented token lifetime, used only when the token cannot be parsed. */
const TOKEN_DEFAULT_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A token minted less than this long ago is always trusted, even when its
 * parsed expiry looks close or past (clock skew between GEV and HamRig must
 * not cause a login on every call).
 */
const TOKEN_TRUST_FRESH_MS = 5 * 60 * 1000;

/** After a failed login, auth calls answer 401 locally for this long. */
export const LOGIN_FAILURE_BACKOFF_MS = 60 * 1000;

/** Largest upstream body we are willing to buffer (the aurora grid is ~300 KB). */
const RESPONSE_MAX_BYTES = 32 * 1024 * 1024;

const DEFAULT_BASE_URL = 'https://hamrig.com';
const DEFAULT_USER_AGENT = 'GodsEyeView/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)';
const LOGIN_PATH = '/api/auth/login';

/** Loopback hosts that may be reached over plain http (local HamRig checkouts). */
function isLoopbackHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost'
    || host.endsWith('.localhost')
    || host === '127.0.0.1'
    || host === '[::1]'
    || host === '::1';
}

/**
 * Validate and normalise the HamRig base URL. Returns `origin + path` without
 * a trailing slash, or `null` when the value is unusable: not an absolute
 * http(s) URL, plain http to a non-loopback host, or embedded credentials.
 * HAMRIG_BASE_URL is operator configuration, never user input.
 */
export function normalizeHamrigBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) return null;
  if (url.search || url.hash) return null;
  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathname}`;
}

/**
 * Expiry (ms since epoch) encoded in a HamRig session token, or `null` when
 * the token does not follow the `user_<id>_<exp>_<sig>` scheme.
 */
export function parseHamrigTokenExpiry(token) {
  if (typeof token !== 'string') return null;
  const match = TOKEN_PATTERN.exec(token.trim());
  if (!match) return null;
  const seconds = Number(match[2]);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds * 1000;
}

/**
 * Whether `path` is an acceptable HamRig API path: absolute, under `/api/`,
 * no query/fragment (use the `query` option), no dot segments, no
 * backslashes, whitespace or control characters. Percent-encoded segments
 * (e.g. `callsign-db/S79%2FDL2SBY`) are allowed.
 */
export function isValidHamrigApiPath(path) {
  if (typeof path !== 'string') return false;
  if (!path.startsWith('/api/')) return false;
  if (path.length > 2048) return false;
  if (/[?#\\\s\x00-\x1f\x7f]/.test(path)) return false;
  if (path.includes('//')) return false;
  if (/(^|\/)\.\.?(\/|$)/.test(path)) return false;
  return true;
}

/**
 * Serialise a query object into a `?key=value` string (empty string when there
 * is nothing to send). `undefined`/`null` values are skipped, arrays repeat
 * the key, everything else is stringified and URL-encoded.
 */
export function buildHamrigQuery(query) {
  if (query === undefined || query === null) return '';
  let params;
  if (query instanceof URLSearchParams) {
    params = new URLSearchParams(query);
  } else {
    if (typeof query !== 'object') throw new TypeError('HamRig query must be an object');
    params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      const values = Array.isArray(value) ? value : [value];
      for (const entry of values) {
        if (entry === undefined || entry === null) continue;
        params.append(key, String(entry));
      }
    }
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

/** Parse a JSON body leniently; anything that is not a JSON object/array → null. */
function parseJsonText(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trimStart();
  if (!trimmed) return null;
  const first = trimmed[0];
  if (first !== '{' && first !== '[') return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Read the body of a fetch response as text with a size cap. Tolerates
 * minimal fake responses (`{ status, text() }` or `{ status, json() }`).
 */
async function readBodyText(response) {
  const body = response?.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value?.byteLength ?? 0;
      if (total > RESPONSE_MAX_BYTES) {
        try { await reader.cancel(); } catch { /* no-op */ }
        const error = new Error(`HamRig response exceeded ${RESPONSE_MAX_BYTES} bytes`);
        error.code = 'HAMRIG_RESPONSE_TOO_LARGE';
        throw error;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  }
  if (typeof response?.text === 'function') return String(await response.text());
  if (typeof response?.json === 'function') {
    try {
      const value = await response.json();
      return value === undefined ? '' : JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return '';
}

/** Combine an optional caller signal with the per-request timeout. */
function buildRequestSignal(externalSignal, timeoutMs) {
  const timeoutSignal = Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
  if (externalSignal && timeoutSignal) {
    if (typeof AbortSignal.any === 'function') return AbortSignal.any([externalSignal, timeoutSignal]);
    const controller = new AbortController();
    const forward = (signal) => () => controller.abort(signal.reason);
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener('abort', forward(externalSignal), { once: true });
    if (timeoutSignal.aborted) controller.abort(timeoutSignal.reason);
    else timeoutSignal.addEventListener('abort', forward(timeoutSignal), { once: true });
    return controller.signal;
  }
  return externalSignal || timeoutSignal || undefined;
}

/** Trim an error message for logs (no bodies, no headers, bounded length). */
function shortMessage(error) {
  const text = typeof error === 'string' ? error : (error?.message ?? String(error ?? 'unknown error'));
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 200) || 'unknown error';
}

/**
 * Create a HamRig client.
 *
 * @param {object} [options]
 * @param {string} [options.baseUrl='https://hamrig.com'] https only, except loopback hosts
 * @param {string} [options.username='']
 * @param {string} [options.password='']
 * @param {typeof fetch} [options.fetchImpl=globalThis.fetch]
 * @param {() => number} [options.now=Date.now]
 * @param {{ warn?: Function, info?: Function, error?: Function }|null} [options.log=console]
 * @param {number} [options.timeoutMs=20000] per request; ≤ 0 disables the timeout
 * @param {string} [options.userAgent]
 */
export function createHamrigClient({
  baseUrl = DEFAULT_BASE_URL,
  username = '',
  password = '',
  fetchImpl = globalThis.fetch,
  now = Date.now,
  log = console,
  timeoutMs = 20000,
  userAgent = DEFAULT_USER_AGENT,
} = {}) {
  const base = normalizeHamrigBaseUrl(baseUrl);
  const configured = base !== null;
  const loginUser = typeof username === 'string' ? username.trim() : '';
  const loginPassword = typeof password === 'string' ? password : '';
  const canAuthenticate = configured && loginUser.length > 0 && loginPassword.length > 0;
  const agent = typeof userAgent === 'string' && userAgent.trim() ? userAgent.trim() : DEFAULT_USER_AGENT;
  const requestTimeoutMs = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : 20000;

  const state = {
    token: null,
    tokenIssuedAt: 0,
    tokenExpiresAt: 0,
    loginPromise: null,
    loginBlockedUntil: 0,
    lastLoginError: null,
  };

  const warn = (message) => {
    try { log?.warn?.(message); } catch { /* logging must never break a request */ }
  };
  const info = (message) => {
    try { log?.info?.(message); } catch { /* no-op */ }
  };

  function clearToken() {
    state.token = null;
    state.tokenIssuedAt = 0;
    state.tokenExpiresAt = 0;
  }

  /** Whether the cached token can be used without renewing first. */
  function tokenFresh() {
    if (!state.token) return false;
    const current = now();
    if (current - state.tokenIssuedAt < TOKEN_TRUST_FRESH_MS) return true;
    const lifetime = state.tokenExpiresAt - state.tokenIssuedAt;
    const margin = Math.min(TOKEN_RENEW_MARGIN_MS, Math.max(0, lifetime / 2));
    return state.tokenExpiresAt - current > margin;
  }

  function wrapTransportError(error, method, path, externalSignal) {
    if (externalSignal?.aborted) return error;
    if (error?.code === 'HAMRIG_RESPONSE_TOO_LARGE') return error;
    const label = `${method} ${path}`;
    const name = error?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      const wrapped = new Error(`HamRig request timed out after ${requestTimeoutMs} ms (${label})`, { cause: error });
      wrapped.code = 'HAMRIG_TIMEOUT';
      return wrapped;
    }
    const wrapped = new Error(`HamRig request failed (${label}): ${shortMessage(error)}`, { cause: error });
    wrapped.code = 'HAMRIG_NETWORK';
    return wrapped;
  }

  /** One HTTP round trip. Resolves for every HTTP status; throws on transport errors. */
  async function send(method, path, { query, body, token = null, signal } = {}) {
    const url = `${base}${path}${buildHamrigQuery(query)}`;
    const headers = { Accept: 'application/json', 'User-Agent': agent };
    if (token) headers.Authorization = `Bearer ${token}`;
    const init = { method, headers, redirect: 'manual', signal: buildRequestSignal(signal, requestTimeoutMs) };
    if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
      headers['Content-Type'] = 'application/json';
      init.body = typeof body === 'string' ? body : JSON.stringify(body ?? {});
    }
    let response;
    let text;
    try {
      response = await fetchImpl(url, init);
      text = await readBodyText(response);
    } catch (error) {
      throw wrapTransportError(error, method, path, signal);
    }
    const status = Number(response?.status) || 0;
    return { status, json: parseJsonText(text), text };
  }

  /** Perform the login round trip; resolves the token or null (never throws for HTTP failures). */
  async function login() {
    const result = await send('POST', LOGIN_PATH, { body: { username: loginUser, password: loginPassword } });
    const ok = result.status >= 200 && result.status < 300;
    const token = ok && result.json && typeof result.json.token === 'string' ? result.json.token.trim() : '';
    if (!token) {
      state.loginBlockedUntil = now() + LOGIN_FAILURE_BACKOFF_MS;
      state.lastLoginError = ok
        ? `HamRig login failed (HTTP ${result.status}, no token in response)`
        : `HamRig login failed (HTTP ${result.status})`;
      warn(`[hamrig] ${state.lastLoginError}`);
      return null;
    }
    const issuedAt = now();
    const parsedExpiry = parseHamrigTokenExpiry(token);
    const expiresIn = Number(result.json.expires_in);
    let expiresAt;
    if (parsedExpiry !== null) expiresAt = parsedExpiry;
    else if (Number.isFinite(expiresIn) && expiresIn > 0) expiresAt = issuedAt + expiresIn * 1000;
    else expiresAt = issuedAt + TOKEN_DEFAULT_LIFETIME_MS;
    state.token = token;
    state.tokenIssuedAt = issuedAt;
    state.tokenExpiresAt = expiresAt;
    state.loginBlockedUntil = 0;
    state.lastLoginError = null;
    info(`[hamrig] logged in; session valid until ${new Date(expiresAt).toISOString()}`);
    return token;
  }

  /** Resolve a usable token, logging in when needed. Shares one in-flight login. */
  async function ensureToken() {
    if (!canAuthenticate) return null;
    if (tokenFresh()) return state.token;
    if (state.loginBlockedUntil > now()) return null;
    if (!state.loginPromise) {
      state.loginPromise = login().finally(() => { state.loginPromise = null; });
    }
    return state.loginPromise;
  }

  function loginFailureResult() {
    const error = canAuthenticate
      ? (state.lastLoginError || 'HamRig login failed')
      : 'HamRig login not configured';
    return { status: 401, json: null, text: '', error };
  }

  function assertReady(path) {
    if (!configured) {
      const error = new Error('HamRig client is not configured (HAMRIG_BASE_URL must be an https URL)');
      error.code = 'HAMRIG_NOT_CONFIGURED';
      throw error;
    }
    if (!isValidHamrigApiPath(path)) {
      const error = new TypeError(`HamRig path must start with /api/ and carry no query or dot segments: ${String(path).slice(0, 80)}`);
      error.code = 'HAMRIG_BAD_PATH';
      throw error;
    }
  }

  async function request(method, path, { query, body, auth = false, signal } = {}) {
    assertReady(path);
    if (!auth) return send(method, path, { query, body, signal });

    let token = await ensureToken();
    if (!token) return loginFailureResult();
    const first = await send(method, path, { query, body, token, signal });
    if (first.status !== 401) return first;

    // The upstream rejected our session (revoked, rotated secret, clock drift):
    // drop it, log in once more and retry exactly once.
    if (state.token === token) clearToken();
    warn(`[hamrig] session rejected by ${method} ${path}; logging in again`);
    token = await ensureToken();
    if (!token) return loginFailureResult();
    return send(method, path, { query, body, token, signal });
  }

  return {
    configured,
    canAuthenticate,

    /** GET `path` (must start with `/api/`). `query` is URL-encoded; `auth: true` sends the bearer token. */
    get(path, { query, auth = false, signal } = {}) {
      return request('GET', path, { query, auth, signal });
    },

    /** POST a JSON body to `path`. */
    post(path, body, { query, auth = false, signal } = {}) {
      return request('POST', path, { query, body, auth, signal });
    },

    /** Snapshot for `/api/hamrig/status`; never includes the token. */
    status() {
      const current = now();
      return {
        baseUrl: base,
        configured,
        canAuthenticate,
        authenticated: Boolean(state.token) && state.tokenExpiresAt > current,
        tokenExpiresAt: state.token ? new Date(state.tokenExpiresAt).toISOString() : null,
      };
    },

    /** Forget the cached session (and any login backoff); the next auth call logs in again. */
    invalidateToken() {
      clearToken();
      state.loginBlockedUntil = 0;
      state.lastLoginError = null;
    },
  };
}
