/**
 * @file Shared address contract for receiver taps.
 *
 * A "tap" is a layer fed by hardware the user owns and runs themselves. What
 * this module governs is narrower than "tap" in general: it is for taps whose
 * upstream address arrives **from the browser at request time**, which is what
 * makes the route an SSRF surface. Today that is the Rayhunter device (#56),
 * which is addressed as `?base=host:port`, and it would cover an RTL-SDR /
 * dump1090 receiver (#57) if that one is built server-side.
 *
 * It deliberately does NOT cover the other layers in the receiver-taps lane,
 * because they are a different shape and forcing them through this check would
 * be wrong:
 *
 * - Meshtastic (#6) reads a fixed public broker (`mqtt.meshtastic.org`).
 * - WiGLE (#11) reads a fixed public API behind a token.
 * - TAK (#7) takes its host from operator-set env config, not from the
 *   browser, and a TAK server is frequently a legitimate REMOTE host — a
 *   private-only rule would break it.
 *
 * This module is the single place that constraint lives, so taps cannot each
 * re-derive it and disagree. The rule is deliberately narrow:
 *
 *   A tap may address the loopback interface or an RFC1918 private network,
 *   plus the `localhost` and `*.local` (mDNS) names. Nothing else.
 *
 * That is the whole point of a tap — it reads *your* device on *your* network.
 * A tap pointed at a public address is either a mistake or someone using the
 * proxy as a confused deputy, and both deserve the same answer.
 *
 * Two deliberate non-goals, so the next person does not think they were
 * oversights:
 *
 * 1. No general hostname resolution. A name other than `localhost`/`*.local`
 *    is rejected outright rather than resolved-and-pinned. Local devices are
 *    reachable by IP or mDNS, so supporting arbitrary names would buy nothing
 *    and would drag in DNS-rebinding defence (resolve, pin, re-check on every
 *    redirect) that `server/providers/radio/transport.js` already shows is not
 *    small. If a tap ever genuinely needs it, pin it there rather than
 *    loosening the check here.
 * 2. No IPv6. Link-local IPv6 carries a zone index (`%eth0`) whose handling is
 *    platform-specific, and no tap has needed it. Rejected explicitly rather
 *    than half-supported.
 *
 * Lives in `src/data/` rather than under `server/providers/` because both
 * sides need the same answer: the server as a trust boundary, the browser to
 * give immediate feedback on a typed address without a round trip. Sharing one
 * module means they cannot drift — the same reason #274 exists about eight
 * copies of haversine. `server/providers/gbfs.js` importing
 * `src/data/gbfsSource.js` is the established direction for this.
 *
 * Note on reuse: `isNonGlobalIpv4()` in `server/providers/radio/stations.js` answers a
 * neighbouring question and was deliberately NOT reused. It reports malformed
 * input such as `999.1.1.1` as non-global, which is the safe direction for the
 * radio proxy's "is this public enough to fetch?" test but inverts into
 * *allowing* garbage under a tap's "is this local enough to fetch?" test. The
 * positive allowlist below cannot invert that way.
 *
 * @module data/tapAddress
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

/**
 * Build an absolute upstream URL for a tap request.
 *
 * The path is supplied by the tap module, never by the client, so this only
 * has to guarantee the two halves join predictably.
 *
 * @param {{origin: string}} address from {@link parseTapAddress}.
 * @param {string} path absolute path beginning with `/`.
 * @returns {string}
 */
export function tapUrl(address, path) {
  if (!address?.origin)
    throw new TypeError('tapUrl: address must come from parseTapAddress');
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new TypeError('tapUrl: path must be an absolute path');
  }
  return `${address.origin}${path}`;
}
