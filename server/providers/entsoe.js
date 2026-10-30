/**
 * ENTSO-E Transparency Platform proxy — European electricity grid data.
 *
 * Upstream: the Transparency Platform REST API on web-api.tp.entsoe.eu.
 *
 * THE TOKEN IS NEVER HARDCODED. It comes from the ENTSOE_TOKEN environment
 * variable, which the Provider Settings panel can write (see the key
 * registry entry 'entsoe' in src/keySetupCore.mjs). Without the token the
 * upstream answers 401 with an Acknowledgement_MarketDocument; this proxy
 * detects that BEFORE the request is made and answers 503
 * {error:'no_key', keyRequired:true} instead, so the layer can say 'needs
 * key' rather than 'broken feed'.
 *
 * The upstream speaks XML (MarketDocument). This proxy normalizes the
 * documents it serves into JSON so the browser never parses XML, and it caps
 * every read.
 *
 * Routes (the browser names a route, never a URL):
 *   GET /api/entsoe/load?date=YYYY-MM-DD
 *   GET /api/entsoe/generation?date=YYYY-MM-DD
 *   GET /api/entsoe/prices?date=YYYY-MM-DD
 *   GET /api/entsoe/status  -> whether a token is configured, never its value
 */

import { readResponseTextCapped } from './common/http.js';
import { makeRateLimiter } from './common/rate-limit.js';
import { admitSameSiteRequest } from '../../src/localRequestGate.mjs';

/** The Transparency Platform API endpoint. */
export const ENTSOE_API_ENDPOINT = 'https://web-api.tp.entsoe.eu/api';

/** The environment variable the operator token is read from. */
export const ENTSOE_TOKEN_ENV_VAR = 'ENTSOE_TOKEN';

/** The key-registry id the Provider Settings panel knows this key by. */
export const ENTSOE_KEY_ID = 'entsoe';

/** The domains this proxy serves, and what each one means. */
export const ENTSOE_DOMAINS = Object.freeze([
  Object.freeze({
    id: 'A',
    route: 'load',
    label: 'Total Load',
    unit: 'MW',
    direction: 'consumption',
  }),
  Object.freeze({
    id: 'B',
    route: 'generation',
    label: 'Generation',
    unit: 'MW',
    direction: 'supply',
  }),
  Object.freeze({
    id: 'D',
    route: 'prices',
    label: 'Day-ahead prices',
    unit: 'EUR/MWh',
    direction: 'price',
  }),
]);

const DOMAIN_BY_ROUTE = new Map(ENTSOE_DOMAINS.map((d) => [d.route, d]));

/** A day's worth of XML is small; cap generously but never unbounded. */
export const ENTSOE_MAX_BYTES = 4 * 1024 * 1024;

/** Upstream requests per client IP per minute. */
export const ENTSOE_MAX_PER_MIN = 30;

/** The operator token, or '' when it is not configured. */
export function entsoeToken(env = process.env) {
  return String(env?.[ENTSOE_TOKEN_ENV_VAR] || '').trim();
}

/**
 * Parse a 'YYYY-MM-DD' date parameter into the UTC interval ENTSO-E wants.
 *
 * @param {string|null|undefined} value The `date` query parameter.
 * @returns {{start: string, end: string, day: string}|null} Null when the
 *   parameter is missing or malformed.
 */
export function entsoeDayWindow(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = Date.parse(text + 'T00:00:00Z');
  if (!Number.isFinite(parsed)) return null;
  const start = new Date(parsed);
  // Reject a date the platform would silently roll over (2026-02-31).
  if (start.getUTCDate() !== Number(text.slice(8, 10))) return null;
  if (start.getUTCMonth() + 1 !== Number(text.slice(5, 7))) return null;
  // ENTSO-E's period end covers the whole UTC day.
  const end = new Date(parsed + 24 * 60 * 60 * 1000 - 1000);
  return {
    day: text,
    start: start.toISOString().replace('.000Z', 'Z'),
    end: end.toISOString().replace('.000Z', 'Z'),
  };
}

/**
 * Build the upstream API URL for one domain and day.
 *
 * @param {string} domain ENTSO-E domain code (A, B, D).
 * @param {{start: string, end: string}} window The UTC interval.
 * @param {string} token The operator token.
 * @returns {string} Absolute upstream URL.
 */
export function buildEntsoeUrl(domain, window, token) {
  const params = new URLSearchParams({
    securityToken: String(token),
    domainCode: String(domain),
    periodStart: window.start,
    periodEnd: window.end,
  });
  return ENTSOE_API_ENDPOINT + '?' + params.toString();
}

/**
 * Extract the numeric time series from an ENTSO-E TimeSeries document.
 *
 * ENTSO-E's XML nests the data as TimeSeries > TimeArray > Point (qty,
 * position) under a TimeSeriesObservation. The parser walks for those two
 * elements by name so it survives the namespace prefixes and the ordering
 * differences between documents.
 *
 * @param {string} xml The upstream document.
 * @returns {{unit: string|null, points: Array<{position: number, value: number}>}|null}
 *   Null when the document carries no time series at all.
 */
export function parseEntsoeTimeSeries(xml) {
  const text = String(xml || '');
  if (!text.includes('<') || !text.includes('TimeSeries')) return null;
  const unitMatch = /<(?:\w+:)?unit>\s*([^<]*)\s*<\/(?:\w+:)?unit>/.exec(text);
  const unit = unitMatch ? unitMatch[1].trim() : null;
  const points = [];
  const pointPattern =
    /<(?:\w+:)?Point>\s*<(?:\w+:)?qty>([^<]*)<\/(?:\w+:)?qty>\s*<(?:\w+:)?position>(\d+)<\/(?:\w+:)?position>\s*<\/(?:\w+:)?Point>/g;
  let match;
  while ((match = pointPattern.exec(text)) !== null) {
    const value = Number(match[1]);
    const position = Number(match[2]);
    if (!Number.isFinite(value) || !Number.isFinite(position)) continue;
    points.push({ position, value });
  }
  if (!points.length) return null;
  return { unit, points };
}

/**
 * Pull the reason out of an ENTSO-E Acknowledgement_MarketDocument, so the
 * layer can say what the operator refused instead of 'HTTP 401'.
 *
 * @param {string} xml The upstream document.
 * @returns {string|null} The reason, or null when the document names none.
 */
export function parseEntsoeAcknowledgement(xml) {
  const text = String(xml || '');
  const match =
    /<(?:\w+:)?Reason>([^<]*)<\/(?:\w+:)?Reason>/.exec(text) ||
    /<(?:\w+:)?explanation>([^<]*)<\/(?:\w+:)?explanation>/.exec(text);
  return match ? match[1].trim() : null;
}

/**
 * Normalize an ENTSO-E document into the JSON shape the layer renders.
 *
 * @param {string} xml The upstream document.
 * @param {object} domain The domain descriptor.
 * @param {string} day The requested day.
 * @returns {object} Normalized payload.
 */
export function normalizeEntsoeDocument(xml, domain, day) {
  const series = parseEntsoeTimeSeries(xml);
  return {
    domain: domain.id,
    route: domain.route,
    label: domain.label,
    unit: series?.unit || domain.unit,
    day,
    points: series?.points || [],
    count: series?.points.length || 0,
  };
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}
/**
 * Build the ENTSO-E proxy middleware handler.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] Injected fetch, for tests.
 * @param {NodeJS.ProcessEnv} [options.env] Environment to read the token from.
 * @returns {(req, res) => void}
 */
export function createEntsoeHandler({
  fetchImpl = fetch,
  env = process.env,
  maxPerMin = ENTSOE_MAX_PER_MIN,
} = {}) {
  const allow = makeRateLimiter({
    windowMs: 60_000,
    max: maxPerMin,
    globalMax: maxPerMin * 4,
  });
  return async function handle(req, res) {
    const verdict = admitSameSiteRequest({
      hostHeader: req.headers?.host,
      protocol: req.socket?.encrypted ? 'https:' : 'http:',
      origin: req.headers?.origin,
      secFetchSite: req.headers?.['sec-fetch-site'],
      proxyHeaders: req.headers || {},
    });
    if (!verdict.ok) {
      sendJson(res, verdict.status, { error: verdict.error });
      return;
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    const url = new URL(req.url || '/', 'http://localhost');
    const segments = url.pathname.split('/').filter(Boolean);
    const route = segments[segments.length - 1] || '';
    if (route === 'status') {
      // The token's VALUE never leaves the server; only its presence does.
      sendJson(res, 200, {
        configured: Boolean(entsoeToken(env)),
        keyId: ENTSOE_KEY_ID,
        envVar: ENTSOE_TOKEN_ENV_VAR,
      });
      return;
    }
    const domain = DOMAIN_BY_ROUTE.get(route);
    if (!domain) {
      sendJson(res, 404, { error: 'Unknown data route' });
      return;
    }
    const token = entsoeToken(env);
    if (!token) {
      // No token: the upstream would answer 401. Say so in the shape the
      // layer already understands (the FIRMS pattern).
      sendJson(res, 503, { error: 'no_key', keyRequired: true });
      return;
    }
    const window = entsoeDayWindow(url.searchParams.get('date'));
    if (!window) {
      sendJson(res, 400, { error: 'date must be YYYY-MM-DD' });
      return;
    }
    const clientKey = String(req.socket?.remoteAddress || 'unknown');
    if (!allow(clientKey)) {
      res.setHeader('Retry-After', '10');
      sendJson(res, 429, { error: 'Too many requests', retryAfter: 10 });
      return;
    }
    const upstream = buildEntsoeUrl(domain.id, window, token);
    const left = new AbortController();
    res.on?.('close', () => {
      if (!res.writableEnded) left.abort();
    });
    try {
      const response = await fetchImpl(upstream, {
        signal: left.signal,
        redirect: 'manual',
        headers: { Accept: 'application/xml, text/xml' },
      });
      const body = await readResponseTextCapped(
        response,
        ENTSOE_MAX_BYTES,
        left.signal,
      );
      if (left.signal.aborted) return;
      if (!response.ok) {
        // 401/403 means the operator refused the token.
        if (response.status === 401 || response.status === 403) {
          sendJson(res, 502, {
            error: 'ENTSO-E rejected the security token',
            keyRejected: true,
            reason: parseEntsoeAcknowledgement(body),
          });
          return;
        }
        sendJson(res, 502, {
          error: 'ENTSO-E unavailable',
          status: response.status,
          reason: parseEntsoeAcknowledgement(body),
        });
        return;
      }
      const payload = normalizeEntsoeDocument(body, domain, window.day);
      if (!payload.count) {
        sendJson(res, 502, {
          error: 'ENTSO-E document carried no time series',
          reason: parseEntsoeAcknowledgement(body),
        });
        return;
      }
      sendJson(res, 200, payload);
    } catch (error) {
      if (left.signal.aborted) return;
      sendJson(res, 502, {
        error: 'ENTSO-E unavailable',
        detail: error?.message || String(error),
      });
    }
  };
}

/**
 * Vite plugin wrapping the ENTSO-E proxy.
 * @param {{fetchImpl?: typeof fetch, env?: NodeJS.ProcessEnv}} [options]
 * @returns {import('vite').Plugin}
 */
export function entsoeProxy(options = {}) {
  const handle = createEntsoeHandler(options);
  function install(server) {
    server.middlewares.use('/api/entsoe', (req, res) => {
      void handle(req, res);
    });
  }
  return {
    name: 'entsoe-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
