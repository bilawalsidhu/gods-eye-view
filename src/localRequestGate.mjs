/**
 * Same-site request gate for the cost-bearing and log endpoints.
 *
 * The credential panel has its own stricter gate (`admitKeySetupRequest` in
 * keySetupCore.mjs): loopback socket + local Host + exact Origin + JSON
 * Content-Type. The four endpoints here — `/api/realtime/token` (mints an
 * OpenAI Realtime token = spends money), `/api/openai/hud-summary` (OpenAI
 * spend), `/api/google/nearby-places` (Google spend), and
 * `/api/realtime/debug-log` (appends to a local JSONL) — were previously
 * ungated, so a hostile web page open in the same browser could reach them
 * cross-site: a `fetch` carries a foreign `Origin`, and an `<img>`/navigation
 * carries NO `Origin` at all but does carry `Sec-Fetch-Site: cross-site`.
 *
 * This module is the pure core that refuses those shapes while keeping the
 * documented `HOST=0.0.0.0` LAN opt-in and non-browser loopback tools (the two
 * repo QA harnesses POST the token endpoint from Node with no Origin) working.
 * It deliberately does NOT require a loopback remote address (that belongs only
 * to the credential panel), the presence of an `Origin`, or a JSON
 * Content-Type. It touches nothing but its arguments, so every refusal below is
 * pinned by a unit assertion.
 */
/**
 * Reverse-proxy / CDN forwarding headers. Their presence means the request did
 * not originate on this machine, whatever its socket says. This module owns
 * the list for every local gate (the credential panel and /mcp import
 * `hasProxySignals`), and has no imports so it can sit in any package boundary.
 */
export const PROXY_SIGNALS = Object.freeze([
  'forwarded',
  'via',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-real-ip',
  'cf-connecting-ip',
  'cf-ray',
]);

/**
 * Whether a request carries reverse-proxy or CDN forwarding headers. `headers`
 * is keyed by lower-case header name.
 */
export function hasProxySignals(headers = {}) {
  return PROXY_SIGNALS.some(
    (name) => String(headers[name] || '').trim() !== '',
  );
}

/**
 * Compute a request's own authority (an origin string) from its protocol and
 * Host header. Unlike the credential-panel gate's localhost-restricted
 * `localAuthority`, this returns whatever Host the request actually carries —
 * the LAN opt-in serves a non-loopback Host to LAN browsers, and a same-origin
 * fetch from such a page must still match. Malformed/missing input yields null.
 * @param {string} hostHeader e.g. `req.headers.host`
 * @param {string} protocol `http:` or `https:`
 * @returns {string|null}
 */
function requestAuthority(hostHeader, protocol) {
  const raw = String(hostHeader || '')
    .trim()
    .toLowerCase();
  const scheme = String(protocol || '').toLowerCase();
  if (!raw || !['http:', 'https:'].includes(scheme) || /[\s/?#@]/.test(raw))
    return null;
  try {
    return new URL(`${scheme}//${raw}`).origin;
  } catch {
    return null;
  }
}

/**
 * Decide whether a request to a cost-bearing/log endpoint is same-site enough
 * to admit. Pure: no I/O, no globals.
 *
 * Policy, in order:
 *  1. any reverse-proxy / CDN signal header present (PROXY_SIGNALS) → 403;
 *  2. `Sec-Fetch-Site` present and not `same-origin` / `none` → 403 (this is
 *     what blocks `<img src=...>` and cross-site navigation, which carry no
 *     Origin but do carry `Sec-Fetch-Site: cross-site`);
 *  3. `Origin` present must exactly equal the request's own authority computed
 *     from protocol + Host — the same exact-origin comparison the credential
 *     gate uses (no userinfo, no path/search/hash). The literal string `null`
 *     is an opaque origin (sandboxed iframe / `data:` URL) and is refused;
 *  4. otherwise ok. Non-browser loopback tools and the LAN opt-in (which may
 *     carry neither `Origin` nor `Sec-Fetch-Site`) pass here.
 *
 * @param {{hostHeader?: string, protocol?: string, origin?: string, secFetchSite?: string, proxyHeaders?: Record<string,string>}} req
 * @returns {{ok: true} | {ok: false, status: 403, error: string}}
 */
export function admitSameSiteRequest({
  hostHeader,
  protocol = 'http:',
  origin,
  secFetchSite,
  proxyHeaders = {},
} = {}) {
  // (1) A request carrying reverse-proxy / CDN forwarding headers did not
  // originate on this machine, whatever its socket says.
  if (hasProxySignals(proxyHeaders)) {
    return {
      ok: false,
      status: 403,
      error: 'Proxied requests are not accepted',
    };
  }
  // (2) The browser tells us when a request is cross-site. `none` is a typed
  // URL / bookmark; `same-origin` is the app itself. Anything else (cross-site,
  // same-site but cross-origin) is refused.
  const site = String(secFetchSite || '')
    .trim()
    .toLowerCase();
  if (site !== '' && site !== 'same-origin' && site !== 'none') {
    return {
      ok: false,
      status: 403,
      error: 'Cross-site requests are not accepted',
    };
  }
  // (3) If Origin is present it must exactly equal the request's own authority.
  if (origin !== undefined && origin !== null && origin !== '') {
    if (origin === 'null') {
      return {
        ok: false,
        status: 403,
        error: 'Opaque origins are not accepted',
      };
    }
    const authority = requestAuthority(hostHeader, protocol);
    let parsedOrigin;
    try {
      parsedOrigin = new URL(String(origin));
    } catch {
      return { ok: false, status: 403, error: 'Unrecognized Origin refused' };
    }
    const exactOrigin =
      parsedOrigin.username === '' &&
      parsedOrigin.password === '' &&
      parsedOrigin.pathname === '/' &&
      parsedOrigin.search === '' &&
      parsedOrigin.hash === '' &&
      parsedOrigin.origin === authority;
    if (!exactOrigin) {
      return {
        ok: false,
        status: 403,
        error: 'Cross-origin requests are not accepted',
      };
    }
  }
  return { ok: true };
}

/** Private Serve admission. Forwarding headers alone never establish trust. */
export function admitTrustedTailnetRequest({
  remoteAddress,
  headers = {},
  configuredOrigin,
  ownerLogin,
  method,
  requestUrl,
} = {}) {
  const deny = () => ({
    ok: false,
    status: 403,
    error: 'Private owner access required',
  });
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress))
    return deny();
  let expected;
  try {
    expected = new URL(configuredOrigin);
  } catch {
    return deny();
  }
  if (
    expected.protocol !== 'https:' ||
    !expected.hostname.endsWith('.ts.net') ||
    !/^[a-z0-9][a-z0-9.-]+$/.test(expected.hostname) ||
    expected.origin !== configuredOrigin ||
    expected.username ||
    expected.password ||
    expected.port ||
    expected.pathname !== '/' ||
    expected.search ||
    expected.hash
  )
    return deny();
  if (
    !ownerLogin ||
    typeof headers['tailscale-user-login'] !== 'string' ||
    headers['tailscale-user-login'] !== ownerLogin
  )
    return deny();
  if (headers['x-forwarded-proto'] !== 'https') return deny();
  if (
    PROXY_SIGNALS.some(
      (name) =>
        !['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host'].includes(
          name,
        ) && headers[name],
    )
  )
    return deny();
  if (
    headers['x-forwarded-host'] &&
    headers['x-forwarded-host'] !== headers.host
  )
    return deny();
  let authority;
  try {
    authority = new URL(`https://${headers.host}`);
  } catch {
    return deny();
  }
  if (
    authority.origin !== expected.origin ||
    /[\s/?#@]/.test(headers.host || '')
  )
    return deny();
  // Clicking the app link in another app/site produces a cross-site top-level
  // navigation, with no Origin. This is safe only for the already authenticated
  // owner's GET of the app document, never APIs, frames, POSTs or WebSockets.
  // Match the raw pathname; normalization must not turn an API prefix with
  // dot segments into a document-navigation exception.
  const pathname =
    typeof requestUrl === 'string' ? requestUrl.split(/[?#]/, 1)[0] : '';
  const appDocument = pathname === '/' || pathname === '/index.html';
  const ownerDocumentNavigation =
    method === 'GET' &&
    appDocument &&
    headers['sec-fetch-mode'] === 'navigate' &&
    headers['sec-fetch-dest'] === 'document' &&
    !headers.upgrade &&
    !headers['sec-websocket-key'];
  return admitSameSiteRequest({
    hostHeader: headers.host,
    protocol: 'https:',
    origin: headers.origin,
    secFetchSite: ownerDocumentNavigation ? 'none' : headers['sec-fetch-site'],
  });
}

/** Routes that remain on the desktop, including encoded path spellings. */
export function isDesktopOnlyTailnetPath(requestUrl = '/') {
  if (typeof requestUrl !== 'string' || !requestUrl.startsWith('/'))
    return true;
  let url;
  try {
    url = new URL(`http://localhost${requestUrl}`);
  } catch {
    return true;
  }
  let pathname = url.pathname;
  try {
    for (let n = 0; n < 3 && pathname.includes('%'); n++)
      pathname = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  if (pathname.includes('%') || pathname.includes('\\')) return true;
  pathname = new URL(
    `http://localhost${pathname.replace(/\/+/g, '/')}`,
  ).pathname.toLowerCase();
  if (
    /^\/(?:mcp(?:\/|$)|api\/setup(?:\/|$)|api\/realtime\/(?:oauth-[^/]*|debug-log)(?:\/|$))/.test(
      pathname,
    )
  )
    return true;
  return (
    pathname === '/api/realtime/token' &&
    url.searchParams.has('auth') &&
    url.searchParams.get('auth') !== 'api-key'
  );
}
