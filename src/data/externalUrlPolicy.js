/**
 * External-URL safety policy — the SSRF validator every server-side fetch of
 * a DATA-DRIVEN URL must pass, shared by the runtimes that fetch such URLs
 * (radio directory streams, CCTV source packs) so a host-laundering trick
 * rejected in one layer cannot re-enter through another. Pure and
 * worker-safe: `URL` + string ops only, no `process`, no `fs`.
 *
 * The threat: an upstream catalog entry (radio station record, configured
 * CCTV source) names a URL our SERVER will fetch. A hostile or compromised
 * entry must not be able to aim that fetch at loopback, private networks,
 * link-local metadata services (169.254.169.254), or embed credentials in
 * the URL. DNS-rebinding is out of scope by construction: these fetches
 * happen with the deployment's egress, and the catalog itself is
 * server-registered — this gate is about not treating a catalog as a
 * fetch-anything primitive.
 *
 * @module data/externalUrlPolicy
 */

/**
 * True when the hostname is an IPv4 literal outside the globally routable
 * unicast space (loopback, RFC1918 private, CGNAT, link-local, multicast,
 * reserved, broadcast, or simply malformed as 4 dotted decimals).
 * @param {string} hostname Already lowercased, brackets/trailing dot stripped.
 * @returns {boolean} True when the host is four dotted decimals that parse
 *   and at least one octet lands outside globally routable unicast space.
 */
export function isNonGlobalIpv4(hostname) {
  const pieces = hostname.split('.');
  if (pieces.length !== 4 || pieces.some((piece) => !/^\d{1,3}$/.test(piece))) return false;
  const values = pieces.map(Number);
  if (values.some((value) => value > 255)) return true;
  const [a, b, c] = values;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

/**
 * True when `value` parses as an absolute http(s) URL whose host is a public
 * DNS name or public IPv4 literal — no credentials, no localhost/.local, no
 * non-global IPv4, no IPv6 literals (the catalogs that feed this gate are
 * IPv4 DNS territory; a bracketed literal in a camera field is not a
 * legitimate shape).
 * @param {string} value Candidate URL.
 * @param {{httpsOnly?: boolean}} [opts] Require https: (radio streams) —
 *   default false, because plaintext http is a legitimate shape for public
 *   CCTV snapshot endpoints.
 * @returns {boolean} True when the server may fetch `value` as written —
 *   false for anything unparseable, credentialed, or aimed at a local host.
 */
export function isSafeExternalHttpUrl(value, { httpsOnly = false } = {}) {
  if (typeof value !== 'string' || !value) return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replaceAll(/^\[|\]$/g, '').replace(/\.$/, '');
    const protocolOk = httpsOnly ? url.protocol === 'https:' : (url.protocol === 'https:' || url.protocol === 'http:');
    if (!protocolOk || url.username || url.password || !hostname) return false;
    return !(
      hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname.endsWith('.local')
      || isNonGlobalIpv4(hostname)
      || hostname.includes(':')
    );
  } catch {
    return false;
  }
}

/**
 * Default ceiling for the byte span a forwarded Range may ask for — the same
 * 64 MB cap the CCTV media relay applies to a declared response body.
 * @type {number}
 */
export const DEFAULT_RANGE_SPAN_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Validate, canonicalize and BOUND a client-supplied HTTP Range header before
 * it is forwarded to an upstream (CCTV media proxy). Bounding bounds what is
 * ASKED FOR, not what arrives: every accepted form — `bytes=<first>-<last>`,
 * `bytes=<first>-`, `bytes=-<suffix>` — is clamped to `maxBytes` of span,
 * including the open-ended and suffix forms, which otherwise ask an upstream
 * for a whole file of unknown size. A player that wants more than one span's
 * worth asks for the next range, which is ordinary partial-content behavior.
 *
 * Anything that is not a single well-formed `bytes=` range is DROPPED (null)
 * and the proxy sends no Range, which is what RFC 7233 §3.1 prescribes for a
 * Range a server cannot understand: the upstream serves the full body, which
 * the player also handles. Dropped values include multi-range (a comma fails
 * the single-range pattern — its multipart answer would stream uncapped) and
 * any value carrying CR/LF, which an outbound fetch would refuse to carry.
 *
 * @param {string|undefined} raw The client Range header value.
 * @param {number} [maxBytes=DEFAULT_RANGE_SPAN_MAX_BYTES] Ceiling for the
 *   requested span.
 * @returns {?string} The canonical bounded value, or null to drop it.
 */
export function safeRangeHeader(raw, maxBytes = DEFAULT_RANGE_SPAN_MAX_BYTES) {
  if (typeof raw !== 'string') return null;
  // The unit is case-insensitive (RFC 7233 §2.1); `bytes` is the only one the
  // proxy understands, and the anchored digits pattern is what keeps CRLF,
  // commas (multi-range) and junk out.
  const match = /^bytes=(\d{0,19})-(\d{0,19})?$/i.exec(raw.trim());
  if (!match) return null;
  const firstText = match[1];
  // `undefined` (the group never participated) for an open-ended "bytes=N-";
  // `''` only for the meaningless "bytes=-".
  const lastText = match[2];

  // "bytes=-" carries neither position and is meaningless.
  if (firstText === '' && !lastText) return null;

  const cap = Number(maxBytes);
  if (!Number.isSafeInteger(cap) || cap <= 0) return null;

  // Suffix form: the final N bytes. N === 0 is unsatisfiable by definition.
  if (firstText === '') {
    const suffix = Number(lastText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return `bytes=-${Math.min(suffix, cap)}`;
  }

  const first = Number(firstText);
  if (!Number.isSafeInteger(first) || first < 0) return null;
  const ceiling = first + cap - 1;
  if (!Number.isSafeInteger(ceiling)) return null;

  // Open-ended: everything from `first` on, bounded to one span.
  if (lastText === undefined) return `bytes=${first}-${ceiling}`;

  const last = Number(lastText);
  if (!Number.isSafeInteger(last) || last < first) return null;
  return `bytes=${first}-${Math.min(last, ceiling)}`;
}
