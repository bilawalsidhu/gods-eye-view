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
 *   GET /api/entsoe/load[?date=YYYY-MM-DD][&zone=FR]
 *   GET /api/entsoe/generation[?date=YYYY-MM-DD][&zone=FR]
 *   GET /api/entsoe/prices[?date=YYYY-MM-DD][&zone=FR]
 *   GET /api/entsoe/status  -> whether a token is configured, never its value
 *
 * `date` defaults to today (UTC) and `zone` to France. Each answer is the day
 * as HOURLY points (position 1..24 from UTC midnight): the platform publishes
 * 15-, 30- or 60-minute series, and they are averaged into the hour here so
 * the layer reads one shape.
 *
 * NOT VERIFIED AGAINST THE LIVE PLATFORM: the request parameters (document
 * type, process type, bidding-zone EIC codes, `yyyyMMddHHmm` period format)
 * and the document shape follow the Transparency Platform's published
 * guide; they have only been exercised against fixtures. One call with a real
 * token is the check.
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

/**
 * The bidding zones this proxy will ask for, by the short code the browser
 * names. The EIC codes are the platform's; a code not listed here is refused,
 * so the browser can never make the proxy ask for an arbitrary domain.
 * `price` is the zone's day-ahead market area where it differs from the load
 * area (Germany trades as DE-LU), or null where this table does not carry one.
 */
export const ENTSOE_ZONES = Object.freeze({
  FR: Object.freeze({ load: '10YFR-RTE------C', price: '10YFR-RTE------C' }),
  DE: Object.freeze({ load: '10Y1001A1001A83F', price: '10Y1001A1001A82H' }),
  ES: Object.freeze({ load: '10YES-REE------0', price: '10YES-REE------0' }),
  IT: Object.freeze({ load: '10YIT-GRTN-----B', price: null }),
  GB: Object.freeze({ load: '10YGB----------A', price: null }),
  BE: Object.freeze({ load: '10YBE----------2', price: '10YBE----------2' }),
  NL: Object.freeze({ load: '10YNL----------L', price: '10YNL----------L' }),
  PT: Object.freeze({ load: '10YPT-REN------W', price: '10YPT-REN------W' }),
  AT: Object.freeze({ load: '10YAT-APG------L', price: '10YAT-APG------L' }),
  CH: Object.freeze({ load: '10YCH-SWISSGRIDZ', price: '10YCH-SWISSGRIDZ' }),
  PL: Object.freeze({ load: '10YPL-AREA-----S', price: '10YPL-AREA-----S' }),
});

/** The zone used when the browser names none. */
export const ENTSOE_DEFAULT_ZONE = 'FR';

/**
 * The documents this proxy serves, and how each is asked for.
 *
 *  - load: A65 "system total load", process A16 "realised", by outBiddingZone;
 *  - generation: A75 "actual generation per type", process A16, by inDomain.
 *    The per-type series are SUMMED into one total; series that are
 *    consumption (pumped storage) carry an outBiddingZone and are skipped;
 *  - prices: A44 "day-ahead prices", in and out domain both the market area.
 */
export const ENTSOE_DOMAINS = Object.freeze([
  Object.freeze({
    id: 'A',
    route: 'load',
    label: 'Total Load',
    unit: 'MW',
    direction: 'consumption',
    documentType: 'A65',
    processType: 'A16',
    zoneParams: (zone) => ({ outBiddingZone_Domain: zone.load }),
    zoneOf: (zone) => zone.load,
    combine: 'first',
  }),
  Object.freeze({
    id: 'B',
    route: 'generation',
    label: 'Generation',
    unit: 'MW',
    direction: 'supply',
    documentType: 'A75',
    processType: 'A16',
    zoneParams: (zone) => ({ in_Domain: zone.load }),
    zoneOf: (zone) => zone.load,
    combine: 'sum',
  }),
  Object.freeze({
    id: 'D',
    route: 'prices',
    label: 'Day-ahead prices',
    unit: 'EUR/MWh',
    direction: 'price',
    documentType: 'A44',
    processType: null,
    zoneParams: (zone) => ({
      in_Domain: zone.price,
      out_Domain: zone.price,
    }),
    zoneOf: (zone) => zone.price,
    combine: 'first',
  }),
]);

const DOMAIN_BY_ROUTE = new Map(ENTSOE_DOMAINS.map((d) => [d.route, d]));

/** A day's worth of XML is small; cap generously but never unbounded. */
export const ENTSOE_MAX_BYTES = 4 * 1024 * 1024;

/** A day's series for today still grows; a finished day never changes. */
export const ENTSOE_TTL_TODAY_MS = 15 * 60_000;
export const ENTSOE_TTL_PAST_MS = 6 * 60 * 60_000;
/** Most answers kept; the oldest goes first. */
export const ENTSOE_CACHE_MAX = 64;

/** Upstream requests per client IP per minute. */
export const ENTSOE_MAX_PER_MIN = 30;

/** The operator token, or '' when it is not configured. */
export function entsoeToken(env = process.env) {
  return String(env?.[ENTSOE_TOKEN_ENV_VAR] || '').trim();
}

/** `yyyyMMddHHmm`, the only period format the platform accepts. */
function periodParam(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}` +
    `${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`
  );
}

/** Today's UTC date, `YYYY-MM-DD`. */
export function entsoeToday(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Parse a 'YYYY-MM-DD' date parameter into the UTC day ENTSO-E is asked for.
 *
 * @param {string|null|undefined} value The `date` query parameter.
 * @returns {{start: string, end: string, day: string, startParam: string,
 *   endParam: string, startMs: number}|null} Null when malformed.
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
  const end = new Date(parsed + 24 * 60 * 60 * 1000);
  return {
    day: text,
    startMs: parsed,
    start: start.toISOString().replace('.000Z', 'Z'),
    end: end.toISOString().replace('.000Z', 'Z'),
    startParam: periodParam(start),
    endParam: periodParam(end),
  };
}

/**
 * Resolve the `zone` query parameter to a zone entry usable for a domain.
 *
 * @param {string|null|undefined} value The `zone` parameter.
 * @param {object} domain A domain descriptor.
 * @returns {{code: string, zone: object}|{error: string}}
 */
export function entsoeZone(value, domain) {
  const code = String(value || ENTSOE_DEFAULT_ZONE)
    .trim()
    .toUpperCase();
  const zone = Object.hasOwn(ENTSOE_ZONES, code) ? ENTSOE_ZONES[code] : null;
  if (!zone) return { error: 'unknown zone' };
  if (!domain.zoneOf(zone)) return { error: 'zone has no data for this route' };
  return { code, zone };
}

/**
 * Build the upstream API URL for one domain, zone and day.
 *
 * @param {object} domain A domain descriptor from ENTSOE_DOMAINS.
 * @param {object} zone A zone entry from ENTSOE_ZONES.
 * @param {{startParam: string, endParam: string}} window The UTC day.
 * @param {string} token The operator token.
 * @returns {string} Absolute upstream URL.
 */
export function buildEntsoeUrl(domain, zone, window, token) {
  const params = new URLSearchParams({
    securityToken: String(token),
    documentType: domain.documentType,
  });
  if (domain.processType) params.set('processType', domain.processType);
  for (const [key, value] of Object.entries(domain.zoneParams(zone)))
    params.set(key, value);
  params.set('periodStart', window.startParam);
  params.set('periodEnd', window.endParam);
  return ENTSOE_API_ENDPOINT + '?' + params.toString();
}

const tagBody = (name) =>
  new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'g');
const firstTag = (text, name) => {
  const match = new RegExp(
    `<(?:\\w+:)?${name}>\\s*([^<]*?)\\s*</(?:\\w+:)?${name}>`,
  ).exec(text);
  return match ? match[1] : null;
};

/** Minutes in an ISO-8601 resolution ('PT15M', 'PT30M', 'PT60M', 'PT1H'). */
export function entsoeResolutionMinutes(value) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(String(value || '').trim());
  if (!match || (!match[1] && !match[2])) return null;
  const minutes = Number(match[1] || 0) * 60 + Number(match[2] || 0);
  return minutes > 0 && minutes <= 60 ? minutes : null;
}

/**
 * Extract the day's HOURLY series from an ENTSO-E document.
 *
 * A document holds one or more TimeSeries, each with one or more Periods
 * (`timeInterval/start`, `resolution`, then Points of `position` and either
 * `quantity` or `price.amount`). A point's position counts resolution steps
 * from its Period's start, so its hour of the requested UTC day comes from
 * that start, not from the raw position. Sub-hourly points are averaged into
 * their hour. With `combine: 'sum'` the hourly values of the separate
 * TimeSeries are added (generation by type); with 'first' they are averaged
 * (one series in practice).
 *
 * @param {string} xml The upstream document.
 * @param {{startMs: number}} window The requested UTC day.
 * @param {'first'|'sum'} [combine]
 * @param {{skipConsumption?: boolean}} [options]
 * @returns {{unit: string|null, points: Array<{position: number, value: number}>}|null}
 *   Null when the document carries no usable point.
 */
export function parseEntsoeTimeSeries(
  xml,
  window = { startMs: 0 },
  combine = 'first',
  { skipConsumption = false } = {},
) {
  const text = String(xml || '');
  if (!text.includes('<') || !text.includes('TimeSeries')) return null;
  const perSeries = [];
  for (const series of text.matchAll(tagBody('TimeSeries'))) {
    const seriesText = series[1];
    if (skipConsumption && /outBiddingZone_Domain\.mRID/.test(seriesText))
      continue;
    const hours = new Map();
    for (const period of seriesText.matchAll(tagBody('Period'))) {
      const periodText = period[1];
      const minutes = entsoeResolutionMinutes(
        firstTag(periodText, 'resolution'),
      );
      const startText = firstTag(periodText, 'start');
      const startMs = Date.parse(startText || '');
      if (!minutes || !Number.isFinite(startMs)) continue;
      for (const point of periodText.matchAll(tagBody('Point'))) {
        const position = Number(firstTag(point[1], 'position'));
        const raw =
          firstTag(point[1], 'quantity') ??
          firstTag(point[1], 'price.amount') ??
          firstTag(point[1], 'qty');
        const value = Number(raw);
        if (!Number.isInteger(position) || position < 1 || raw == null)
          continue;
        if (!Number.isFinite(value)) continue;
        const offsetMin =
          (startMs - window.startMs) / 60_000 + (position - 1) * minutes;
        const hour = Math.floor(offsetMin / 60) + 1;
        if (hour < 1 || hour > 24) continue;
        const bucket = hours.get(hour) || { sum: 0, n: 0 };
        bucket.sum += value;
        bucket.n += 1;
        hours.set(hour, bucket);
      }
    }
    if (hours.size) perSeries.push(hours);
  }
  if (!perSeries.length) return null;
  const merged = new Map();
  for (const hours of perSeries) {
    for (const [hour, bucket] of hours) {
      const mean = bucket.sum / bucket.n;
      const entry = merged.get(hour) || { sum: 0, n: 0 };
      entry.sum += mean;
      entry.n += 1;
      merged.set(hour, entry);
    }
  }
  const points = [...merged.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([position, entry]) => ({
      position,
      value:
        Math.round(
          (combine === 'sum' ? entry.sum : entry.sum / entry.n) * 100,
        ) / 100,
    }));
  return { unit: null, points };
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
    /<(?:\w+:)?text>([^<]*)<\/(?:\w+:)?text>/.exec(text) ||
    /<(?:\w+:)?Reason>([^<]*)<\/(?:\w+:)?Reason>/.exec(text) ||
    /<(?:\w+:)?explanation>([^<]*)<\/(?:\w+:)?explanation>/.exec(text);
  return match ? match[1].trim() : null;
}

/**
 * Normalize an ENTSO-E document into the JSON shape the layer renders.
 *
 * @param {string} xml The upstream document.
 * @param {object} domain The domain descriptor.
 * @param {{day: string, startMs: number}|string} window The requested day.
 * @param {string} [zoneCode] The zone's short code.
 * @returns {object} Normalized payload.
 */
export function normalizeEntsoeDocument(xml, domain, window, zoneCode = null) {
  const day = typeof window === 'string' ? window : window.day;
  const startMs =
    typeof window === 'string'
      ? Date.parse(`${window}T00:00:00Z`)
      : window.startMs;
  const series = parseEntsoeTimeSeries(xml, { startMs }, domain.combine, {
    skipConsumption: domain.route === 'generation',
  });
  return {
    domain: domain.id,
    route: domain.route,
    label: domain.label,
    unit: domain.unit,
    zone: zoneCode,
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
  now = () => Date.now(),
} = {}) {
  /** @type {Map<string, {at: number, body: object}>} */
  const cache = new Map();
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
    const window = entsoeDayWindow(
      url.searchParams.get('date') || entsoeToday(now()),
    );
    if (!window) {
      sendJson(res, 400, { error: 'date must be YYYY-MM-DD' });
      return;
    }
    const resolved = entsoeZone(url.searchParams.get('zone'), domain);
    if (resolved.error) {
      sendJson(res, 400, { error: resolved.error });
      return;
    }
    // The same answer is served to every tab without spending the token again.
    const cacheKey = `${domain.route}:${resolved.code}:${window.day}`;
    const cached = cache.get(cacheKey);
    const ttl =
      window.day === entsoeToday(now())
        ? ENTSOE_TTL_TODAY_MS
        : ENTSOE_TTL_PAST_MS;
    if (cached && now() - cached.at < ttl) {
      sendJson(res, 200, cached.body);
      return;
    }
    const clientKey = String(req.socket?.remoteAddress || 'unknown');
    if (!allow(clientKey)) {
      res.setHeader('Retry-After', '10');
      sendJson(res, 429, { error: 'Too many requests', retryAfter: 10 });
      return;
    }
    const upstream = buildEntsoeUrl(domain, resolved.zone, window, token);
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
      const payload = normalizeEntsoeDocument(
        body,
        domain,
        window,
        resolved.code,
      );
      if (!payload.count) {
        sendJson(res, 502, {
          error: 'ENTSO-E document carried no time series',
          reason: parseEntsoeAcknowledgement(body),
        });
        return;
      }
      cache.set(cacheKey, { at: now(), body: payload });
      while (cache.size > ENTSOE_CACHE_MAX)
        cache.delete(cache.keys().next().value);
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
