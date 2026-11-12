import { admitSameSiteRequest } from '../../../src/localRequestGate.mjs';

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
  const verdict = admitSameSiteRequest({
    hostHeader: req.headers?.host,
    protocol: req.socket?.encrypted ? 'https:' : 'http:',
    origin: req.headers?.origin,
    secFetchSite: req.headers?.['sec-fetch-site'],
    proxyHeaders: req.headers || {},
  });
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

/**
 * Proxy header values arrive client-controlled; read one only when it is a
 * single scheme token, never a comma-separated chain.
 * @param {import('node:http').IncomingMessage} req
 * @returns {'http:'|'https:'}
 */
function forwardedProtocol(req) {
  if (req.socket?.encrypted) return 'https:';
  const proto = String(req.headers?.['x-forwarded-proto'] || '')
    .trim()
    .toLowerCase();
  return proto === 'https' ? 'https:' : 'http:';
}

/**
 * Cross-site gate for routes the map needs in order to render and that may be
 * reached through the reverse proxy the README documents. It refuses the same
 * cross-site browser shapes as `admitSameSite` (a `Sec-Fetch-Site` other than
 * same-origin/none, a foreign or opaque `Origin`) but does not refuse
 * reverse-proxy forwarding headers: refusing them would break rendering for
 * an instance served behind a proxy. A single `X-Forwarded-Proto` supplies
 * the scheme an `Origin` is compared against. It only picks which scheme of
 * the request's own `Host` that comparison uses; a page on another origin is
 * refused by `Sec-Fetch-Site` (a cross-site or same-site fetch) and by the
 * `Origin` comparison (a foreign host matches under neither scheme) whatever
 * the header says. A client that is not a browser can send any header, and is
 * not what this gate defends against.
 *
 * Use it for keyless routes (`admitSameSiteKeyless` is the same gate under
 * the name those routes use: they hold no credential and spend nothing, which
 * is what the forwarding-header refusal protects) and for the one keyed
 * exception, `/api/ion/*`: Cesium ion has to answer for the page to render.
 * What that route hands out is ion's endpoint document for an allow-listed
 * asset (see server/providers/keyIsolation/ionEndpoint.js for what each
 * holds), never the account token.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {boolean} True when a 403 was sent.
 */
export function admitSameSiteBehindProxy(req, res) {
  const verdict = admitSameSiteRequest({
    hostHeader: req.headers?.host,
    protocol: forwardedProtocol(req),
    origin: req.headers?.origin,
    secFetchSite: req.headers?.['sec-fetch-site'],
    proxyHeaders: {},
  });
  if (verdict.ok) return false;
  res.statusCode = verdict.status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ error: verdict.error }));
  return true;
}

/**
 * Gate for keyless routes the map needs in order to render
 * (`/api/terrain/heights`, `/api/overpass`, ...). Forwarding headers are not
 * refused because those protect credentials and spend, which a keyless route
 * has neither of. See `admitSameSiteBehindProxy` for the checks that remain.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {boolean} True when a 403 was sent.
 */
export function admitSameSiteKeyless(req, res) {
  return admitSameSiteBehindProxy(req, res);
}

/**
 * Wrap a middleware handler with `admitSameSiteBehindProxy`: cross-site
 * browser requests get a 403, requests carrying forwarding headers do not.
 * For a route that holds a key only when what it returns cannot be used
 * outside the page (see `admitSameSiteBehindProxy`); everything else keeps
 * `sameSiteGated`.
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next?: Function) => unknown} handler
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next?: Function) => unknown}
 */
export function sameSiteGatedBehindProxy(handler) {
  return (req, res, next) => {
    if (admitSameSiteBehindProxy(req, res)) return undefined;
    return handler(req, res, next);
  };
}
