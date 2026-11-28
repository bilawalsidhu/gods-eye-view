/**
 * @file Address rule for a receiver tap on the user's network. Accept loopback, RFC1918
 * private IPv4, localhost and *.local (mDNS). Reject other names without resolving them
 * (see radio/transport.js for DNS pinning). IPv6 is unsupported because link-local
 * zone indexes are platform-specific. The isNonGlobalIpv4 predicate in radio/stations.js
 * treats malformed IPv4 as non-global, so it cannot serve as a local address allowlist.
 * @module server/providers/tapAddress
 */

/** Link-local (169.254/16) is excluded wholesale, which also covers the cloud
 * metadata address at 169.254.169.254 by construction rather than by blocklist. */
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
/** Single mDNS label or dotted name ending in `.local`, e.g. `rayhunter.local`. */
const MDNS_RE = /^(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})*\.local$/;
const MAX_PORT = 65535;

/**
 * Whether a dotted-quad string is a loopback or RFC1918 private address.
 *
 * Written as a positive allowlist: every octet must parse and be in range
 * before any range test runs, so malformed input can never fall through to
 * "allowed".
 *
 * @param {string} host
 * @returns {boolean}
 */
export function isLocalIpv4(host) {
  const match = IPV4_RE.exec(host);
  if (!match) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  const octets = match.slice(1).map(Number);
  if (
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  )
    return false;
  return (
    a === 127 || // loopback
    a === 10 || // 10/8
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 168) // 192.168/16
  );
}

/**
 * Parse and validate a user-supplied `host:port` tap address.
 *
 * @param {unknown} raw e.g. `"192.168.1.1:8080"`, `"localhost:8080"`.
 * @returns {{host: string, port: number, origin: string}|null} null when the
 *   address is malformed or not local. Callers must treat null as a 400 and
 *   must not fall back to a default host — a tap with no valid address has
 *   nothing to read.
 */
export function parseTapAddress(raw) {
  const value = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!value || value.length > 263) return null;
  // Reject a scheme, credentials, path, or query outright rather than
  // stripping them: each is a sign the caller meant a URL, not an address,
  // and quietly repairing it is how a parser ends up disagreeing with the
  // thing that later builds the request.
  if (/[/\\?#@]/.test(value) || value.includes('://')) return null;

  const colon = value.lastIndexOf(':');
  if (colon <= 0 || colon === value.length - 1) return null;
  const host = value.slice(0, colon);
  const portText = value.slice(colon + 1);

  if (!/^\d{1,5}$/.test(portText)) return null;
  const port = Number(portText);
  if (port < 1 || port > MAX_PORT) return null;

  const hostOk =
    host === 'localhost' || MDNS_RE.test(host) || isLocalIpv4(host);
  if (!hostOk) return null;

  return { host, port, origin: `http://${host}:${port}` };
}
