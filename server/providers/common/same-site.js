import { admitSameSiteRequest } from '../../../src/localRequestGate.mjs';

/**
 * Describe a request for `admitSameSiteRequest`. The hosted entry point
 * (server.js) sets GEV_TRUSTED_PROXY=1 only after its password gate is active;
 * then the host's own reverse-proxy headers are expected rather than refused,
 * and the browser-facing scheme comes from X-Forwarded-Proto. Origin and
 * Sec-Fetch-Site checks still apply unchanged.
 * @param {import('node:http').IncomingMessage} req
 * @param {Record<string, string|undefined>} [env]
 */
export function sameSiteRequestShape(req, env = process.env) {
  const headers = req.headers || {};
  const trusted = env.GEV_TRUSTED_PROXY === '1';
  const forwardedProto = String(headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const protocol =
    trusted && (forwardedProto === 'https' || forwardedProto === 'http')
      ? `${forwardedProto}:`
      : req.socket?.encrypted
        ? 'https:'
        : 'http:';
  return {
    hostHeader:
      headers['x-forwarded-host'] && trusted
        ? String(headers['x-forwarded-host']).split(',')[0].trim()
        : headers.host,
    protocol,
    origin: headers.origin,
    secFetchSite: headers['sec-fetch-site'],
    proxyHeaders: trusted ? {} : headers,
  };
}

/**
 * Cross-site request gate for cost-bearing and log endpoints. Feeds the
 * request to the pure, unit-tested `admitSameSiteRequest` and answers 403
 * itself when the request is refused. Returns true when it has already
 * responded (the caller returns); false when the handler should continue.
 * Refuses cross-site browser requests (foreign or opaque Origin, a
 * Sec-Fetch-Site other than same-origin/none, or reverse-proxy headers) while
 * keeping loopback non-browser tools and the HOST=0.0.0.0 LAN opt-in working.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {boolean} True when a 403 was sent.
 */
export function admitSameSite(req, res) {
  const verdict = admitSameSiteRequest(sameSiteRequestShape(req));
  if (verdict.ok) return false;
  res.statusCode = verdict.status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ error: verdict.error }));
  return true;
}

/**
 * Wrap a middleware handler so cross-site requests are refused with 403
 * before the handler runs. Loopback tools and same-origin browser requests
 * pass straight through.
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next?: Function) => unknown} handler
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next?: Function) => unknown}
 */
export function sameSiteGated(handler) {
  return (req, res, next) => {
    if (admitSameSite(req, res)) return undefined;
    return handler(req, res, next);
  };
}
