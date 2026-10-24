/** Local-only transport policy shared by MCP and private provider routes. */
import { isSharingEnabled } from './keySetupCore.mjs';
import { hasProxySignals } from './localRequestGate.mjs';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Whether a request may reach the local MCP server. `localPort` is the port
 * the connection arrived at; `headers` are the request's, keyed by lower-case
 * name; `env` is checked for launcher sharing.
 */
export function isLocalMcpRequest({
  remoteAddress,
  localPort,
  host,
  origin,
  headers = {},
  env = {},
}) {
  if (!LOOPBACK_ADDRESSES.has(remoteAddress)) return false;
  // A proxy or tunnel in front of the server can make a remote request look
  // local, and sharing exposes the server beyond this machine.
  if (hasProxySignals(headers) || isSharingEnabled(env)) return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (!LOOPBACK_HOSTS.has(hostUrl.hostname)) return false;
  // The Host names the port the request reached, so tools are never pointed
  // at another local service.
  if (localPort != null && (hostUrl.port || '80') !== String(localPort))
    return false;
  if (origin == null) return true;
  try {
    const originUrl = new URL(origin);
    return (
      ['http:', 'https:'].includes(originUrl.protocol) &&
      originUrl.host === hostUrl.host
    );
  } catch {
    return false;
  }
}
