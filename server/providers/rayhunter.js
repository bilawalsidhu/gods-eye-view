import { readResponseTextCapped } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { parseTapAddress, tapUrl } from '../../src/data/tapAddress.js';

/**
 * @file Rayhunter receiver tap (#56).
 *
 * Rayhunter (https://github.com/EFForg/rayhunter) runs on a device the user
 * owns — typically a flashed Orbic mobile hotspot — and flags suspicious
 * cellular behaviour it observes. The device's embedded web server sends no
 * CORS headers, so the browser cannot read it directly; this proxy relays two
 * read-only endpoints same-origin.
 *
 * The device address arrives from the browser as `?base=host:port`, which is
 * the shape that makes a route an SSRF surface. That is handled in exactly one
 * place — `parseTapAddress()` in `src/data/tapAddress.js` — which constrains it
 * to loopback / RFC1918 / `*.local`. Both ways the device is actually reached
 * (USB tether and its own Wi-Fi hotspot) put it on a private address, so the
 * constraint costs nothing in practice.
 *
 * Read-only by construction: two GETs, no method other than GET accepted, and
 * nothing is ever written back to the device.
 *
 * @module server/providers/rayhunter
 */

/** The device is on the LAN, so this is generous; it exists to bound a hung
 * socket rather than to police a slow network. */
const RAYHUNTER_TIMEOUT_MS = 8000;
/** Analysis reports are sparse NDJSON warning rows. The cap is insurance
 * against a wedged device streaming forever, not a real expectation. */
export const RAYHUNTER_MAX_BODY_BYTES = 8 * 1024 * 1024;
/** A recording name, or the literal `live` for the in-progress capture. */
const NAME_RE = /^(live|[A-Za-z0-9_.-]{1,128})$/;

/**
 * Fetch one Rayhunter endpoint with a timeout and a streaming byte cap.
 *
 * Kept apart from the middleware so tests can stand in a recorded device
 * response via `fetchImpl` — CI has no Rayhunter to talk to. See
 * `src/data/fixtures/README.md`.
 *
 * @param {string} url absolute URL built by {@link tapUrl}.
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl=fetch]
 * @param {number} [options.timeoutMs=RAYHUNTER_TIMEOUT_MS]
 * @param {number} [options.maxBytes=RAYHUNTER_MAX_BODY_BYTES]
 * @returns {Promise<{status:number, body:string}>}
 */
export async function fetchRayhunterUpstream(
  url,
  {
    fetchImpl = fetch,
    timeoutMs = RAYHUNTER_TIMEOUT_MS,
    maxBytes = RAYHUNTER_MAX_BODY_BYTES,
  } = {},
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });
    // A device that redirects is not a device we recognise; following it would
    // step outside the address the tap contract just validated.
    if (upstream.status >= 300 && upstream.status < 400) {
      const error = new Error('rayhunter upstream redirect refused');
      error.code = 'RAYHUNTER_REDIRECT';
      throw error;
    }
    const body = await readResponseTextCapped(upstream, maxBytes);
    return { status: upstream.status, body };
  } finally {
    clearTimeout(timeoutId);
  }
}

function sendJson(res, status, payload) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

/**
 * Rayhunter tap proxy.
 *
 * Routes:
 *   GET /api/rayhunter/manifest?base=host:port
 *   GET /api/rayhunter/analysis/:name?base=host:port
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] injected upstream, for tests.
 * @returns {import('vite').Plugin}
 */
export function rayhunterProxy({ fetchImpl = fetch } = {}) {
  // The upstream is the user's own device on their own LAN, so this is not a
  // quota guard like the Google/OpenAI limiters. It stops a runaway client
  // loop from hammering a small embedded web server into unresponsiveness.
  const allow = makeRateLimiter({ windowMs: 60_000, max: 120, globalMax: 600 });

  /** Shared front half of both routes: method, rate limit, address. */
  function accept(req, res) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return null;
    }
    if (!allow(clientKey(req))) {
      sendJson(res, 429, { error: 'Too many Rayhunter requests' });
      return null;
    }
    const url = new URL(req.url || '/', 'http://internal');
    const address = parseTapAddress(url.searchParams.get('base'));
    if (!address) {
      sendJson(res, 400, {
        error:
          'base must be a host:port on your own network (loopback, a private LAN address, or a .local name)',
      });
      return null;
    }
    return { url, address };
  }

  async function relay(res, url, contentType) {
    try {
      const { status, body } = await fetchRayhunterUpstream(url, { fetchImpl });
      if (res.headersSent) return;
      if (status < 200 || status >= 300) {
        sendJson(res, 502, { error: `rayhunter device HTTP ${status}` });
        return;
      }
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch (error) {
      // The address is the user's own device, so an unreachable device is the
      // ordinary case (unplugged, asleep, wrong address), not an incident.
      // Log the reason locally; tell the browser only that it is unreachable.
      console.warn('[rayhunter-proxy]', error?.message || String(error));
      if (error?.code === 'RESPONSE_TOO_LARGE') {
        sendJson(res, 502, { error: 'rayhunter response too large' });
        return;
      }
      sendJson(res, 502, { error: 'rayhunter device unreachable' });
    }
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/rayhunter/manifest', async (req, res) => {
      const accepted = accept(req, res);
      if (!accepted) return;
      await relay(
        res,
        tapUrl(accepted.address, '/api/qmdl-manifest'),
        'application/json',
      );
    });

    server.middlewares.use('/api/rayhunter/analysis', async (req, res) => {
      const accepted = accept(req, res);
      if (!accepted) return;
      // connect() has already stripped the mount path.
      const name = accepted.url.pathname.replace(/^\/+/, '');
      if (!NAME_RE.test(name)) {
        sendJson(res, 400, { error: 'invalid recording name' });
        return;
      }
      await relay(
        res,
        tapUrl(accepted.address, `/api/analysis-report/${name}`),
        'application/x-ndjson',
      );
    });
  };

  return {
    name: 'rayhunter-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
