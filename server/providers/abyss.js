import { normalizeVentSnapshot } from '../../src/layers/abyss/records.js';
import bundledVents from '../../src/layers/abyss/vents.json' with { type: 'json' };
import { readResponseTextCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

const NOAA_PMEL_VENTS_URL =
  'https://www.pmel.noaa.gov/eoi/PlumeStudies/global-vents/global-vents-text.html';

const CACHE_TTL_MS = 6 * 60 * 60_000; // 6 hours
const TIMEOUT_MS = 12_000;
const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2 MiB

/**
 * Parses raw HTML table from NOAA PMEL global vents text catalog into normalized vent records.
 */
export function parsePmelVentsHtml(html) {
  if (!html || typeof html !== 'string') return [];

  const tableMatch = html.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) return [];

  const rowMatches = [...tableMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  const rawList = [];

  for (let i = 1; i < rowMatches.length; i++) {
    const tr = rowMatches[i][1];
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
      m[1]
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .trim(),
    );
    if (cells.length < 8) continue;

    const name = cells[0].replace(/\s+/g, ' ');
    const lon = parseFloat(cells[1]);
    const lat = parseFloat(cells[2]);
    const siteActivity = cells[3];
    const activity = cells[4].toLowerCase();
    const tectonicSetting = cells[5];
    const spreadingRate = cells[6];
    const rawDepth = cells[7];

    if (Number.isNaN(lon) || Number.isNaN(lat)) continue;

    let depthM = null;
    let minDepthM = null;
    let maxDepthM = null;
    if (rawDepth) {
      const parts = rawDepth
        .split('-')
        .map((p) => parseFloat(p.trim()))
        .filter((n) => !Number.isNaN(n));
      if (parts.length === 1) {
        depthM = parts[0];
        minDepthM = parts[0];
        maxDepthM = parts[0];
      } else if (parts.length >= 2) {
        minDepthM = Math.min(parts[0], parts[1]);
        maxDepthM = Math.max(parts[0], parts[1]);
        depthM = maxDepthM;
      }
    }

    rawList.push({
      id: `vent-${i}`,
      name,
      lon,
      lat,
      siteActivity,
      activity: ['active', 'inactive', 'unconfirmed'].includes(activity)
        ? activity
        : 'unconfirmed',
      tectonicSetting: tectonicSetting || 'other',
      spreadingRate: spreadingRate || 'unknown',
      depthM,
      minDepthM,
      maxDepthM,
      source: 'NOAA PMEL Earth-Ocean Interactions',
      sourceUrl: NOAA_PMEL_VENTS_URL,
    });
  }

  return normalizeVentSnapshot(rawList);
}

/**
 * Abyss provider proxy middleware for development and preview servers.
 * Proxies NOAA PMEL vents dataset with memory caching, coalescing, and bundled fallback.
 */
export function abyssProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  let cachedData = null;
  let cachedAt = 0;
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 1200 });

  async function fetchUpstreamVents() {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetchImpl(NOAA_PMEL_VENTS_URL, {
      signal,
      headers: {
        'User-Agent':
          'GodsEyeView-ABYSS/1.0 (Earth Observation & Deep-Sea Explorer)',
      },
    });

    if (!response.ok) {
      throw new Error(`NOAA PMEL HTTP ${response.status}`);
    }

    const html = await readResponseTextCapped(response, MAX_HTML_BYTES, signal);
    const parsed = parsePmelVentsHtml(html);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('NOAA PMEL empty or unparseable vents table');
    }

    return parsed;
  }

  async function getVents() {
    const currentNow = now();
    if (cachedData && currentNow - cachedAt < CACHE_TTL_MS) {
      return { data: cachedData, stale: false };
    }

    try {
      const { promise } = coalesceProxyRequest(inFlight, 'vents', async () => {
        const fresh = await fetchUpstreamVents();
        cachedData = fresh;
        cachedAt = now();
        return fresh;
      });
      const data = await promise;
      return { data, stale: false };
    } catch (err) {
      // If we have previous cache, return it with stale flag
      if (cachedData) {
        return { data: cachedData, stale: true };
      }
      // Otherwise, return bundled authoritative fallback with stale flag
      const fallback = normalizeVentSnapshot(bundledVents) || [];
      return { data: fallback, stale: true };
    }
  }

  async function handler(req, res) {
    const json = (status, value, stale = false) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
        ...(stale ? { 'X-Data-Stale': 'true' } : {}),
      });
      res.end(JSON.stringify(value));
    };

    if (req.method !== 'GET') {
      return json(405, { error: 'method_not_allowed' });
    }

    const path = (req.url || '/').split('?')[0];
    if (path !== '/vents' && path !== '/vents/') {
      return json(404, { error: 'unknown_route' });
    }

    if (!allow(clientKey(req))) {
      return json(429, { error: 'rate_limited' });
    }

    try {
      const { data, stale } = await getVents();
      return json(200, data, stale);
    } catch {
      return json(502, { error: 'abyss_vents_unavailable' });
    }
  }

  return {
    name: 'abyss',
    configureServer({ middlewares }) {
      middlewares.use('/api/abyss', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/abyss', handler);
    },
  };
}
