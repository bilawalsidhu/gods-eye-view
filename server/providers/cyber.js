import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { readResponseTextCapped } from './common/http.js';
import { admitKeySetupRequest } from '../../src/keySetupCore.mjs';
import { createCyberEnrichmentProviders } from './cyber/enrichment.js';

const RADAR_BASE = 'https://api.cloudflare.com/client/v4/radar';
const DSHIELD_URLS = Object.freeze({
  ips: 'https://feeds.dshield.org/feeds/topips.txt',
  ports: 'https://feeds.dshield.org/feeds/topports_source.txt',
});
const RADAR_TTL_MS = 15 * 60_000;
const DSHIELD_TTL_MS = 60 * 60_000;
const MAX_STALE_MS = 6 * 60 * 60_000;
const HTTP_TIMEOUT_MS = 12_000;
const JSON_BODY_LIMIT = 256 * 1024;
const TEXT_BODY_LIMIT = 128 * 1024;

function failure(code, status = 503) {
  return Object.assign(new Error(code), { code, status });
}

function text(value, max = 100) {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  return candidate &&
    candidate.length <= max &&
    !/[\u0000-\u001f<>]/.test(candidate)
    ? candidate
    : null;
}

function percent(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 100
    ? number
    : null;
}

function locationCodes(rows, kind) {
  const codeName =
    kind === 'origin' ? 'originCountryAlpha2' : 'targetCountryAlpha2';
  const nameName =
    kind === 'origin' ? 'originCountryName' : 'targetCountryName';
  const seen = new Set();
  return rows
    .map((row) => {
      const code = String(row?.[codeName] || '').toUpperCase();
      const name = text(row?.[nameName], 100);
      const value = percent(row?.value);
      const rank = Number(row?.rank);
      if (
        !/^[A-Z]{2}$/.test(code) ||
        !name ||
        value === null ||
        !Number.isInteger(rank) ||
        rank < 1
      )
        throw failure('invalid_radar_data');
      if (seen.has(code)) return null;
      seen.add(code);
      return { code, name, value, rank };
    })
    .filter(Boolean);
}

function parseRadarLocations(payload, expected) {
  const values = payload?.result?.locations;
  if (payload?.success !== true || !Array.isArray(values) || values.length > 32)
    throw failure('invalid_radar_data');
  const byCode = new Map();
  for (const item of values) {
    const code = String(item?.alpha2 || '').toUpperCase();
    const latitude = Number(item?.latitude);
    const longitude = Number(item?.longitude);
    const name = text(item?.name, 100);
    if (
      !/^[A-Z]{2}$/.test(code) ||
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90 ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180 ||
      !name
    )
      throw failure('invalid_radar_data');
    byCode.set(code, { code, latitude, longitude, name });
  }
  if (expected.some(({ code }) => !byCode.has(code)))
    throw failure('invalid_radar_data');
  return byCode;
}

function radarObservations(topPayload, kind, locations, window) {
  const rows = topPayload?.result?.top_0;
  if (topPayload?.success !== true || !Array.isArray(rows) || rows.length > 10)
    throw failure('invalid_radar_data');
  return locationCodes(rows, kind).map((item) => {
    const geo = locations.get(item.code);
    return {
      id: `cloudflare-radar:${kind}:${item.code}`,
      provider: 'cloudflare-radar',
      category: `layer7-attack-${kind}`,
      source: 'Cloudflare Radar',
      observedAt: window.end,
      windowStart: window.start,
      windowEnd: window.end,
      latitude: geo.latitude,
      longitude: geo.longitude,
      geographicPrecision: 'country',
      geographicMethod: 'Cloudflare Radar country reference coordinate',
      geographicProvenance: `${geo.name} (${item.code}); country-level aggregation`,
      locationCode: item.code,
      locationName: geo.name,
      share: item.value,
      rank: item.rank,
      detail:
        kind === 'origin'
          ? 'Mitigated requests; source country associated with client IP, not the human operator.'
          : 'Mitigated requests; target country based on the attacked zone billing country when available.',
    };
  });
}

function radarFlows(payload, locations, window) {
  const rows = payload?.result?.top_0;
  if (payload?.success !== true || !Array.isArray(rows) || rows.length > 10)
    throw failure('invalid_radar_data');
  return rows.map((row, index) => {
    const originCode = String(row?.originCountryAlpha2 || '').toUpperCase();
    const targetCode = String(row?.targetCountryAlpha2 || '').toUpperCase();
    const originName = text(row?.originCountryName, 100);
    const targetName = text(row?.targetCountryName, 100);
    const share = percent(row?.value);
    const rank = Number(row?.rank ?? index + 1);
    const origin = locations.get(originCode);
    const target = locations.get(targetCode);
    if (
      !/^[A-Z]{2}$/.test(originCode) ||
      !/^[A-Z]{2}$/.test(targetCode) ||
      !originName ||
      !targetName ||
      !origin ||
      !target ||
      share === null ||
      !Number.isInteger(rank) ||
      rank < 1
    )
      throw failure('invalid_radar_data');
    return {
      id: `cloudflare-radar:flow:${originCode}:${targetCode}`,
      provider: 'cloudflare-radar',
      origin: {
        code: originCode,
        name: originName,
        latitude: origin.latitude,
        longitude: origin.longitude,
      },
      target: {
        code: targetCode,
        name: targetName,
        latitude: target.latitude,
        longitude: target.longitude,
      },
      share,
      rank,
      observedAt: window.end,
      windowStart: window.start,
      windowEnd: window.end,
      geographicPrecision: 'country',
      geographicMethod: 'Cloudflare Radar country reference coordinates',
      geographicProvenance:
        'Cloudflare Radar country-level origin/target pair; origin by client IP country, target by attacked zone billing country when available.',
    };
  });
}

function getWindow(payload, now) {
  const range = payload?.result?.meta?.dateRange;
  const item = Array.isArray(range) ? range[0] : range;
  const start =
    typeof item?.startTime === 'string' ? new Date(item.startTime) : null;
  const end = typeof item?.endTime === 'string' ? new Date(item.endTime) : null;
  if (
    !start ||
    !end ||
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    start > end ||
    end > new Date(now + 5 * 60_000)
  )
    throw failure('invalid_radar_data');
  return { start: start.toISOString(), end: end.toISOString() };
}

async function fetchBounded(
  url,
  { fetchImpl, signal, token = null, cap, json = true },
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'error',
      headers: {
        Accept: json ? 'application/json' : 'text/plain',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'User-Agent': 'Gods Eye View (Cyber activity layer)',
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403)
        throw failure('invalid_credentials', 401);
      if (response.status === 429) throw failure('rate_limited', 429);
      throw failure('upstream_unavailable');
    }
    const body = await readResponseTextCapped(response, cap, controller.signal);
    signal?.throwIfAborted();
    if (!json) return body;
    try {
      return JSON.parse(body);
    } catch {
      throw failure('invalid_radar_data');
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? new Error('cancelled');
    if (error?.code) throw error;
    throw failure('upstream_unavailable');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function parseDshieldIps(body, fetchedAt) {
  const observations = [];
  const seen = new Set();
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [rawIp, rawHost] = line.split(/\s+/, 2);
    const ip = String(rawIp || '').trim();
    if (isIP(ip) === 0 || seen.has(ip)) continue;
    seen.add(ip);
    const hostname = text(String(rawHost || '').replace(/\.$/, ''), 253);
    observations.push({
      id: `dshield:top-ip:${observations.length + 1}:${ip}`,
      provider: 'dshield',
      category: 'reported-top-source-ip',
      source: 'SANS ISC / DShield top IP feed',
      observedAt: null,
      latitude: null,
      longitude: null,
      geographicPrecision: null,
      geographicMethod: null,
      geographicProvenance: null,
      rank: observations.length + 1,
      indicator: { type: isIP(ip) === 4 ? 'ipv4' : 'ipv6', value: ip },
      hostname,
      detail: `DShield top-IP feed entry; feed retrieved ${fetchedAt}. Not a blocklist or a finding about an individual.`,
    });
    if (observations.length === 10) break;
  }
  return observations;
}

function parseDshieldPorts(body) {
  const ports = [];
  const seen = new Set();
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [rawPort, rawProtocol, ...rawLabel] = line.split(/\s+/);
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 0 || port > 65535 || seen.has(port))
      continue;
    seen.add(port);
    ports.push({
      rank: ports.length + 1,
      port,
      protocol: text(rawProtocol, 16) || 'unknown',
      label:
        text(rawLabel.join(' '), 100) ||
        text(rawProtocol, 100) ||
        `Port ${port}`,
    });
    if (ports.length === 10) break;
  }
  if (!ports.length) throw failure('invalid_dshield_data');
  return ports;
}

function makeProxyCache() {
  return { entries: new Map(), pending: new Map() };
}

function serveJson(res, status, payload, cacheControl = 'no-store') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(payload));
}

/** Local server boundary for fixed Cloudflare Radar and public DShield feeds. */
export function cyberProxy({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  const radarCache = makeProxyCache();
  const dshieldCache = makeProxyCache();
  const enrichment = createCyberEnrichmentProviders({ fetchImpl, now });

  async function requestRadarSnapshot({ token, signal, force = false }) {
    const secret = String(
      token || process.env.CLOUDFLARE_RADAR_API_TOKEN || '',
    ).trim();
    if (!secret) throw failure('missing_credentials', 401);
    const fingerprint = createHash('sha256').update(secret).digest('hex');
    const cached = radarCache.entries.get(fingerprint);
    if (!force && cached && now() - cached.fetchedAt < RADAR_TTL_MS)
      return cached;
    if (radarCache.pending.has(fingerprint))
      return radarCache.pending.get(fingerprint);
    const operation = (async () => {
      try {
        const originUrl = new URL(
          `${RADAR_BASE}/attacks/layer7/top/locations/origin`,
        );
        originUrl.search = new URLSearchParams({
          dateRange: '1d',
          limit: '10',
          format: 'JSON',
        });
        const targetUrl = new URL(
          `${RADAR_BASE}/attacks/layer7/top/locations/target`,
        );
        targetUrl.search = originUrl.search;
        const pairsUrl = new URL(`${RADAR_BASE}/attacks/layer7/top/attacks`);
        pairsUrl.search = new URLSearchParams({
          dateRange: '1d',
          limit: '10',
          magnitude: 'MITIGATED_REQUESTS',
          format: 'JSON',
        });
        const [origin, target, pairs] = await Promise.all([
          fetchBounded(originUrl.href, {
            fetchImpl,
            signal,
            token: secret,
            cap: JSON_BODY_LIMIT,
          }),
          fetchBounded(targetUrl.href, {
            fetchImpl,
            signal,
            token: secret,
            cap: JSON_BODY_LIMIT,
          }),
          fetchBounded(pairsUrl.href, {
            fetchImpl,
            signal,
            token: secret,
            cap: JSON_BODY_LIMIT,
          }),
        ]);
        const originRows = locationCodes(origin?.result?.top_0, 'origin');
        const targetRows = locationCodes(target?.result?.top_0, 'target');
        const pairRows = pairs?.result?.top_0;
        if (
          pairs?.success !== true ||
          !Array.isArray(pairRows) ||
          pairRows.length > 10
        )
          throw failure('invalid_radar_data');
        const allRows = [...originRows, ...targetRows];
        for (const row of pairRows) {
          allRows.push(
            { code: String(row?.originCountryAlpha2 || '').toUpperCase() },
            { code: String(row?.targetCountryAlpha2 || '').toUpperCase() },
          );
        }
        const locationMap = new Map();
        if (allRows.length) {
          const locationUrl = new URL(`${RADAR_BASE}/entities/locations`);
          locationUrl.search = new URLSearchParams({
            location: [...new Set(allRows.map(({ code }) => code))].join(','),
            limit: '20',
            format: 'JSON',
          });
          const locationsPayload = await fetchBounded(locationUrl.href, {
            fetchImpl,
            signal,
            token: secret,
            cap: JSON_BODY_LIMIT,
          });
          for (const [code, location] of parseRadarLocations(
            locationsPayload,
            allRows,
          ))
            locationMap.set(code, location);
        }
        const reference = pairs?.result?.meta?.dateRange?.[0]
          ? pairs
          : origin?.result?.meta?.dateRange?.[0]
            ? origin
            : target;
        const window = getWindow(reference, now());
        const observations = [
          ...radarObservations(origin, 'origin', locationMap, window),
          ...radarObservations(target, 'target', locationMap, window),
        ];
        const flows = radarFlows(pairs, locationMap, window);
        const value = {
          schemaVersion: 1,
          provider: 'cloudflare-radar',
          attribution:
            'Cloudflare Radar · mitigated HTTP requests · 24-hour window',
          fetchedAt: new Date(now()).toISOString(),
          windowStart: window.start,
          windowEnd: window.end,
          stale: false,
          observations,
          flows,
        };
        const entry = { value, fetchedAt: now() };
        radarCache.entries.set(fingerprint, entry);
        return entry;
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error?.code === 'invalid_credentials') throw error;
        const current = radarCache.entries.get(fingerprint);
        if (current && now() - current.fetchedAt <= MAX_STALE_MS) {
          return {
            ...current,
            value: { ...current.value, stale: true },
          };
        }
        throw error?.code ? error : failure('upstream_unavailable');
      } finally {
        radarCache.pending.delete(fingerprint);
      }
    })();
    radarCache.pending.set(fingerprint, operation);
    return operation;
  }

  async function requestDshieldSnapshot({ signal, force = false } = {}) {
    const key = 'public-feeds';
    const cached = dshieldCache.entries.get(key);
    if (!force && cached && now() - cached.fetchedAt < DSHIELD_TTL_MS)
      return cached;
    if (dshieldCache.pending.has(key)) return dshieldCache.pending.get(key);
    const operation = (async () => {
      try {
        const [ips, ports] = await Promise.all([
          fetchBounded(DSHIELD_URLS.ips, {
            fetchImpl,
            signal,
            cap: TEXT_BODY_LIMIT,
            json: false,
          }),
          fetchBounded(DSHIELD_URLS.ports, {
            fetchImpl,
            signal,
            cap: TEXT_BODY_LIMIT,
            json: false,
          }),
        ]);
        const fetchedAt = new Date(now()).toISOString();
        const value = {
          schemaVersion: 1,
          provider: 'dshield',
          attribution: 'SANS Internet Storm Center / DShield',
          fetchedAt,
          stale: false,
          observations: parseDshieldIps(ips, fetchedAt),
          ports: parseDshieldPorts(ports),
          notice:
            'Observed/reported source data; may include false positives and is not a blocklist.',
        };
        const entry = { value, fetchedAt: now() };
        dshieldCache.entries.set(key, entry);
        return entry;
      } catch (error) {
        if (signal?.aborted) throw error;
        const current = dshieldCache.entries.get(key);
        if (current && now() - current.fetchedAt <= MAX_STALE_MS)
          return { ...current, value: { ...current.value, stale: true } };
        throw error?.code ? error : failure('upstream_unavailable');
      } finally {
        dshieldCache.pending.delete(key);
      }
    })();
    dshieldCache.pending.set(key, operation);
    return operation;
  }

  async function testRadarConnection({ token, signal } = {}) {
    const secret = String(
      token || process.env.CLOUDFLARE_RADAR_API_TOKEN || '',
    ).trim();
    if (!secret) throw failure('missing_credentials', 401);
    const url = new URL(`${RADAR_BASE}/attacks/layer7/top/attacks`);
    url.search = new URLSearchParams({
      dateRange: '1d',
      limit: '1',
      format: 'JSON',
    });
    const payload = await fetchBounded(url.href, {
      fetchImpl,
      signal,
      token: secret,
      cap: JSON_BODY_LIMIT,
    });
    if (payload?.success !== true || !Array.isArray(payload?.result?.top_0))
      throw failure('invalid_radar_data');
    return { ok: true };
  }

  async function handler(provider, req, res) {
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once?.('close', close);
    try {
      if (req.method !== 'GET')
        return serveJson(res, 405, { error: 'method_not_allowed' });
      if (req.url && req.url !== '/' && req.url !== '')
        return serveJson(res, 400, { error: 'invalid_cyber_query' });
      const entry =
        provider === 'cloudflare-radar'
          ? await requestRadarSnapshot({ signal: controller.signal })
          : await requestDshieldSnapshot({ signal: controller.signal });
      serveJson(res, 200, entry.value);
    } catch (error) {
      if (controller.signal.aborted) return;
      const code = [
        'missing_credentials',
        'invalid_credentials',
        'rate_limited',
        'invalid_radar_data',
        'invalid_dshield_data',
      ].includes(error?.code)
        ? error.code
        : 'upstream_unavailable';
      const status =
        code === 'rate_limited'
          ? 429
          : code.includes('credentials')
            ? 401
            : code.startsWith('invalid_')
              ? 502
              : 503;
      serveJson(res, status, { error: code });
    } finally {
      res.removeListener?.('close', close);
    }
  }

  function admitEnrichment(req) {
    return admitKeySetupRequest({
      method: req.method,
      remoteAddress: req.socket?.remoteAddress,
      hostHeader: req.headers?.host,
      protocol: req.socket?.encrypted ? 'https:' : 'http:',
      origin: req.headers?.origin,
      contentType: req.headers?.['content-type'],
      proxyHeaders: req.headers || {},
      env: process.env,
    });
  }

  function enrichmentHandler(operation) {
    return (req, res) => {
      const admission = admitEnrichment(req);
      if (!admission.ok)
        return serveJson(res, admission.status, {
          error: 'local_request_required',
        });
      if (req.method !== 'POST')
        return serveJson(res, 405, { error: 'method_not_allowed' });
      let body = '';
      let overflow = false;
      req.on('data', (chunk) => {
        if (overflow) return;
        body += chunk.toString('utf8');
        if (Buffer.byteLength(body) > 2048) {
          overflow = true;
          body = '';
        }
      });
      req.on('end', async () => {
        if (overflow)
          return serveJson(res, 413, { error: 'request_too_large' });
        let input;
        try {
          input = JSON.parse(body || '{}');
        } catch {
          return serveJson(res, 400, { error: 'invalid_request' });
        }
        const controller = new AbortController();
        const abort = () => {
          if (!res.writableEnded) controller.abort();
        };
        req.once?.('aborted', abort);
        res.once?.('close', abort);
        try {
          const result = await operation(input, { signal: controller.signal });
          if (!controller.signal.aborted) serveJson(res, 200, result);
        } catch (error) {
          if (controller.signal.aborted) return;
          const code = [
            'missing_credentials',
            'invalid_credentials',
            'insufficient_credits',
            'rate_limited',
            'invalid_ip',
            'invalid_query',
            'invalid_page',
            'invalid_area',
            'not_found',
          ].includes(error?.code)
            ? error.code
            : 'upstream_unavailable';
          const status =
            {
              missing_credentials: 401,
              invalid_credentials: 401,
              insufficient_credits: 402,
              rate_limited: 429,
              invalid_ip: 400,
              invalid_query: 400,
              invalid_page: 400,
              invalid_area: 400,
              not_found: 404,
            }[code] || 503;
          serveJson(res, status, { error: code });
        } finally {
          req.removeListener?.('aborted', abort);
          res.removeListener?.('close', abort);
        }
      });
    };
  }

  return {
    name: 'cyber-providers',
    configureServer({ middlewares }) {
      middlewares.use('/api/cyber/radar', (req, res) =>
        handler('cloudflare-radar', req, res),
      );
      middlewares.use('/api/cyber/dshield', (req, res) =>
        handler('dshield', req, res),
      );
      middlewares.use(
        '/api/cyber/enrich/shodan/host',
        enrichmentHandler(({ ip }, options) =>
          enrichment.lookupShodanHost(ip, options),
        ),
      );
      middlewares.use(
        '/api/cyber/enrich/shodan/search',
        enrichmentHandler(({ query, page }, options) =>
          enrichment.searchShodan(query, page, options),
        ),
      );
      middlewares.use(
        '/api/cyber/enrich/shodan/area',
        enrichmentHandler(({ latitude, longitude, radiusKm }, options) =>
          enrichment.searchShodanArea(latitude, longitude, radiusKm, options),
        ),
      );
      middlewares.use(
        '/api/cyber/enrich/greynoise/ip',
        enrichmentHandler(({ ip }, options) =>
          enrichment.lookupGreyNoise(ip, options),
        ),
      );
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/cyber/radar', (req, res) =>
        handler('cloudflare-radar', req, res),
      );
      middlewares.use('/api/cyber/dshield', (req, res) =>
        handler('dshield', req, res),
      );
      middlewares.use(
        '/api/cyber/enrich/shodan/host',
        enrichmentHandler(({ ip }, options) =>
          enrichment.lookupShodanHost(ip, options),
        ),
      );
      middlewares.use(
        '/api/cyber/enrich/shodan/search',
        enrichmentHandler(({ query, page }, options) =>
          enrichment.searchShodan(query, page, options),
        ),
      );
      middlewares.use(
        '/api/cyber/enrich/shodan/area',
        enrichmentHandler(({ latitude, longitude, radiusKm }, options) =>
          enrichment.searchShodanArea(latitude, longitude, radiusKm, options),
        ),
      );
      middlewares.use(
        '/api/cyber/enrich/greynoise/ip',
        enrichmentHandler(({ ip }, options) =>
          enrichment.lookupGreyNoise(ip, options),
        ),
      );
    },
    requestRadarSnapshot,
    requestDshieldSnapshot,
    testRadarConnection,
    testShodanConnection: enrichment.testShodanConnection,
    testGreyNoiseConnection: enrichment.testGreyNoiseConnection,
  };
}
