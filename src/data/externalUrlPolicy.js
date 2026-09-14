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
 * @returns {boolean}
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
 * @returns {boolean}
 */
export function isSafeExternalHttpUrl(value, { httpsOnly = false } = {}) {
  if (typeof value !== 'string' || !value) return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
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
 * Validate a client-supplied HTTP Range header before it is forwarded to an
 * upstream (CCTV media proxy). Accepts only well-formed single byte ranges —
 * `bytes=<first>-<last>` with an open end allowed — capped to 19 digits per
 * number so a hostile value cannot be an upstream-breaking novelty (or a
 * multi-range / suffix-form abuse vector). Anything else returns null and
 * the proxy simply omits the header (upstream serves the full body, which
 * the player also handles).
 * @param {string|undefined} raw The client Range header value.
 * @returns {?string} The validated value, or null to drop it.
 */
export function safeRangeHeader(raw) {
  if (typeof raw !== 'string') return null;
  const match = /^bytes=(\d{1,19})(-(\d{1,19})?)$/.exec(raw.trim());
  if (!match) return null;
  const first = match[1];
  const last = match[3]; // undefined for an open-ended range "bytes=N-"
  if (last !== undefined && BigInt(last) < BigInt(first)) return null;
  return `bytes=${first}-${last ?? ''}`;
}
