/**
 * Browser-origin admission for the local voice endpoints.
 *
 * Browsers do not apply CORS to WebSocket upgrades, so without this check any
 * web page a user visits could open ws://localhost:4173/api/voice/remote,
 * read the mirrored transcript and inject commands (cross-site WebSocket
 * hijacking). The rule: the Host header must name a local address (or the
 * configured HOST, or anything once HOST opts into the LAN), and when the
 * client sends an Origin it must be a local name or the same host the page was
 * served from. Non-browser clients (the `ws` package, curl, peer globes) send
 * no Origin and stay admitted; the Host check still applies to them.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function hostnameOf(value) {
  try {
    return new URL(value).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

function isLocalName(name, host) {
  if (!name) return false;
  if (LOOPBACK.has(name) || name.endsWith('.local')) return true;
  return Boolean(host) && name === String(host).toLowerCase();
}

/**
 * @param {{ headers?: Record<string, string | undefined> }} request
 * @param {{ host?: string }} [options] configured bind address (HOST)
 * @returns {boolean}
 */
export function isTrustedOrigin(request, { host = process.env.HOST } = {}) {
  const headers = request?.headers || {};
  const lan = host === '0.0.0.0' || host === '::';
  const served = headers.host ? hostnameOf(`http://${headers.host}`) : null;
  if (headers.host && !lan && !isLocalName(served, host)) return false;
  const origin = headers.origin;
  if (origin === undefined) return true;
  const originHost = hostnameOf(origin);
  if (!originHost) return false;
  return isLocalName(originHost, host) || originHost === served;
}

/** Refuse a WebSocket upgrade with a plain 403 and close the socket. */
export function rejectUpgrade(socket) {
  try {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  } catch {
    // The socket may already be gone; destroying it below is all that matters.
  }
  socket.destroy();
}
