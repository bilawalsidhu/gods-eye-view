import {
  admitTrustedTailnetRequest,
  hasProxySignals,
  isDesktopOnlyTailnetPath,
} from '../../src/localRequestGate.mjs';
import { markTrustedTailnetRequest } from '../providers/common/same-site.js';

/** Optional owner-only Tailscale Serve gate; no identity or host is hardcoded. */
export function privateTailnetPlugin({ origin, ownerLogin } = {}) {
  if (!origin && !ownerLogin) return null;
  if (!origin || !ownerLogin)
    throw new Error(
      'Private Serve requires both configured origin and owner login',
    );
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  const directLocal = (req) => {
    let hostname;
    try {
      hostname = new URL(`http://${req.headers.host}`).hostname;
    } catch {
      return false;
    }
    return (
      ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
        req.socket?.remoteAddress,
      ) &&
      localHosts.has(hostname) &&
      !hasProxySignals(req.headers) &&
      !Object.keys(req.headers).some((name) => name.startsWith('tailscale-'))
    );
  };
  const admit = (req) => {
    if (directLocal(req)) return true;
    const verdict = admitTrustedTailnetRequest({
      remoteAddress: req.socket?.remoteAddress,
      headers: req.headers,
      configuredOrigin: origin,
      ownerLogin,
      method: req.method,
      requestUrl: req.url,
    });
    if (!verdict.ok || isDesktopOnlyTailnetPath(req.url)) return false;
    markTrustedTailnetRequest(req);
    return true;
  };
  const install = (server) => {
    server.middlewares.use((req, res, next) => {
      if (admit(req)) return next();
      res.writeHead(403, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(
        JSON.stringify({
          error: 'Private owner access required; settings remain desktop-only',
        }),
      );
    });
    const upgrade = (req, socket) => {
      if (!admit(req)) socket.destroy();
    };
    server.httpServer?.prependListener('upgrade', upgrade);
    server.httpServer?.once('close', () =>
      server.httpServer.removeListener('upgrade', upgrade),
    );
  };
  return {
    name: 'private-tailnet-access',
    enforce: 'pre',
    configureServer: install,
    configurePreviewServer: install,
  };
}
