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
 * Parse an allowlist of trusted proxy IP addresses from a configuration string.
 * Supports comma- and space-separated exact IPv4, exact IPv6, IPv4-mapped IPv6,
 * and valid IPv4 CIDR blocks (e.g. 172.16.0.0/12). Malformed tokens fail closed.
 * @param {string} envValue e.g. process.env.GEV_TRUSTED_PROXY_IPS
 * @returns {Set<string>}
 */
export function parseTrustedProxyIps(envValue) {
  if (!envValue || typeof envValue !== 'string') return new Set();
  const tokens = envValue
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const ips = new Set();
  for (const token of tokens) {
    if (token.includes('/')) {
      if (parseIpv4Cidr(token) !== null) {
        ips.add(token);
      }
      continue;
    }
    if (token.startsWith('::ffff:')) {
      const rest = token.slice(7);
      if (ipv4ToUint32(rest) !== null) {
        ips.add(token);
        ips.add(rest);
      }
      continue;
    }
    if (ipv4ToUint32(token) !== null) {
      ips.add(token);
      continue;
    }
    // Strict exact IPv6 address (requires colon, hexadecimal characters only, no ':::')
    if (
      token.includes(':') &&
      /^[0-9a-f:]+$/i.test(token) &&
      !token.includes(':::')
    ) {
      ips.add(token);
    }
  }
  return ips;
}

function ipv4ToUint32(ip) {
  if (typeof ip !== 'string') return null;
  const raw = ip.trim();
  const parts = raw.split('.');
  if (parts.length !== 4) return null;
  const nums = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    if (part.length > 1 && part.startsWith('0')) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    nums.push(n);
  }
  return ((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0;
}

function parseIpv4Cidr(cidr) {
  if (typeof cidr !== 'string') return null;
  const parts = cidr.trim().split('/');
  if (parts.length !== 2) return null;
  const [base, prefixStr] = parts;
  if (!/^\d+$/.test(prefixStr)) return null;
  if (prefixStr.length > 1 && prefixStr.startsWith('0')) return null;
  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const baseNum = ipv4ToUint32(base);
  if (baseNum === null) return null;
  return { baseNum, prefix };
}

function matchIpv4Cidr(ip, cidr) {
  const parsed = parseIpv4Cidr(cidr);
  if (!parsed) return false;
  const ipNum = ipv4ToUint32(ip);
  if (ipNum === null) return false;
  if (parsed.prefix === 0) return true;
  const mask = (~0 << (32 - parsed.prefix)) >>> 0;
  return (ipNum & mask) === (parsed.baseNum & mask);
}

/**
 * Determine whether a remote socket address is in the trusted proxy allowlist.
 * Supports exact IP matches (IPv4, IPv6) and IPv4 CIDR blocks (e.g. 172.16.0.0/12).
 * @param {string} remoteAddress
 * @param {Set<string>} trustedIps
 * @returns {boolean}
 */
export function isTrustedProxyPeer(remoteAddress, trustedIps) {
  if (!remoteAddress || !(trustedIps instanceof Set) || trustedIps.size === 0) {
    return false;
  }
  let raw = String(remoteAddress).trim().toLowerCase();
  if (raw.startsWith('::ffff:')) {
    raw = raw.slice(7);
  }
  if (trustedIps.has(raw)) return true;
  for (const item of trustedIps) {
    if (item.includes('/') && matchIpv4Cidr(raw, item)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a request carries reverse-proxy or CDN forwarding headers. `headers`
 * is keyed by lower-case header name. When `isTrustedProxy` is true, exactly
 * single-hop `x-forwarded-for` and single-scheme `x-forwarded-proto` are allowed;
 * multi-hop or extraneous proxy signals remain refused.
 */
export function hasProxySignals(headers = {}, { isTrustedProxy = false } = {}) {
  if (isTrustedProxy) {
    const prohibited = [
      'forwarded',
      'via',
      'x-forwarded-host',
      'x-forwarded-port',
      'x-real-ip',
      'cf-connecting-ip',
      'cf-ray',
    ];
    if (prohibited.some((name) => String(headers[name] || '').trim() !== '')) {
      return true;
    }
    const xff = String(headers['x-forwarded-for'] || '').trim();
    if (xff && xff.includes(',')) {
      return true;
    }
    const proto = String(headers['x-forwarded-proto'] || '')
      .trim()
      .toLowerCase();
    if (proto !== '') {
      if (proto !== 'http' && proto !== 'https') {
        return true;
      }
    }
    return false;
  }
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
 *  1. any reverse-proxy / CDN signal header present (PROXY_SIGNALS) → 403
 *     (unless the socket peer is an explicitly trusted proxy, in which case
 *     one-hop x-forwarded-proto/for are admitted and derive the protocol);
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
 * @param {{hostHeader?: string, protocol?: string, origin?: string, secFetchSite?: string, proxyHeaders?: Record<string,string>, isTrustedProxy?: boolean}} req
 * @returns {{ok: true} | {ok: false, status: 403, error: string}}
 */
export function admitSameSiteRequest({
  hostHeader,
  protocol = 'http:',
  origin,
  secFetchSite,
  proxyHeaders = {},
  isTrustedProxy = false,
} = {}) {
  // (1) A request carrying reverse-proxy / CDN forwarding headers did not
  // originate on this machine, whatever its socket says.
  if (hasProxySignals(proxyHeaders, { isTrustedProxy })) {
    return {
      ok: false,
      status: 403,
      error: 'Proxied requests are not accepted',
    };
  }

  // If from an explicitly trusted proxy, derive the scheme from X-Forwarded-Proto
  if (isTrustedProxy) {
    const proto = String(proxyHeaders['x-forwarded-proto'] || '')
      .trim()
      .toLowerCase();
    if (proto === 'http' || proto === 'https') {
      protocol = `${proto}:`;
    }
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
