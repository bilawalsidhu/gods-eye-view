import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readResponseTextCapped } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { normalizeBudget, isOverBudget } from '../../src/data/tomtomTiles.js';
import {
  isValidWigleViewport,
  normalizeWigleNetwork,
  wiglePacificDayKey,
} from '../../src/data/wigleApi.js';

/**
 * @file WiGLE Wi-Fi network layer proxy (#4).
 *
 * WiGLE requires HTTP Basic auth with a private API name/token, so the browser
 * cannot call `api.wigle.net` directly. Without credentials the layer reports
 * `available:false` and renders UNAVAILABLE rather than simulating data.
 *
 * The credentials are the operator's own. That is not incidental — WiGLE's data
 * licence is granted to the person who registered, for use on a single machine,
 * and forbids distributing the data for commercial benefit. See the
 * DATA_SOURCES.md entry: this layer is only correct when each user brings their
 * own account, and it must not be enabled in a shared or hosted deployment
 * without a commercial licence from WiGLE.
 *
 * WiGLE's daily query allowance is small and account-dependent (new accounts
 * especially), which shapes the whole design here: a tight viewport cap, a 24h
 * memory+disk cache because access points do not move, in-flight coalescing so
 * a burst of pans spends one query, and a soft daily counter as a courtesy
 * backstop.
 *
 * @module server/providers/wigle
 */

const WIGLE_URL = 'https://api.wigle.net/api/v2/network/search';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_DIR = path.join(process.cwd(), '.gev-cache', 'wigle');
const MEM_MAX_ENTRIES = 200;
const DEFAULT_DAILY_BUDGET = 50;
const WIGLE_TIMEOUT_MS = 15000;
/** WiGLE returns at most ~100 rows per page; this is insurance, not a limit
 * we expect to reach. */
export const WIGLE_MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Map an upstream failure to text that is safe to hand the browser.
 *
 * WiGLE's own `message` is deliberately NOT relayed: it is upstream-controlled
 * text and this proxy has no way to vouch for it. The distinctions that
 * actually change what the user should do — bad credentials vs. allowance
 * exhausted vs. everything else — are preserved.
 *
 * @param {number} status
 * @returns {string}
 */
export function wigleClientError(status) {
  if (status === 401 || status === 403) {
    return 'WiGLE rejected these credentials — check WIGLE_API_NAME and WIGLE_API_TOKEN';
  }
  if (status === 429) return "WiGLE's daily query allowance for this account is used up";
  return 'WiGLE request failed';
}

/**
 * WiGLE proxy plugin.
 *
 * Routes:
 *   GET /api/wigle/status  — whether credentials are configured
 *   GET /api/wigle/search?south=&west=&north=&east=
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] injected upstream, for tests.
 * @param {string} [options.cacheDir] overridden in tests so runs stay isolated.
 * @returns {import('vite').Plugin}
 */
export function wigleProxy({ fetchImpl = fetch, cacheDir = CACHE_DIR } = {}) {
  /** @type {Map<string, {at:number, body:object}>} */
  const mem = new Map();
  /** @type {Map<string, Promise<object>>} */
  const inFlight = new Map();
  let budget = { date: '', count: 0 };
  // The upstream allowance is the real constraint; this only stops a runaway
  // client loop from burning it before the daily counter notices.
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 300 });

  function dailyBudgetLimit() {
    const raw = Number.parseInt(process.env.WIGLE_DAILY_QUERY_BUDGET || '', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_BUDGET;
  }

  function currentBudget() {
    // WiGLE's counter rolls at US/Pacific midnight, not UTC, so the day key
    // comes from wiglePacificDayKey() rather than tomtomTiles' utcDayKey().
    budget = normalizeBudget(budget, wiglePacificDayKey());
    return budget;
  }

  const diskPath = (key) =>
    path.join(cacheDir, `${createHash('sha1').update(key).digest('hex')}.json`);

  async function readDisk(key) {
    try {
      const raw = await fsp.readFile(diskPath(key), 'utf8');
      const entry = JSON.parse(raw);
      if (!entry || typeof entry.at !== 'number') return null;
      if (Date.now() - entry.at > CACHE_TTL_MS) return null;
      return entry;
    } catch {
      return null;
    }
  }

  function writeDisk(key, entry) {
    fsp
      .mkdir(cacheDir, { recursive: true })
      .then(() => fsp.writeFile(diskPath(key), JSON.stringify(entry)))
      .catch((error) =>
        console.warn('[WiGLE Proxy] disk cache write failed:', error?.message || error),
      );
  }

  async function fetchUpstream(box) {
    const auth = Buffer.from(
      `${process.env.WIGLE_API_NAME}:${process.env.WIGLE_API_TOKEN}`,
    ).toString('base64');
    // freenet/paynet deliberately omitted — their true/false semantics are not
    // reliably documented and an untested guess risks silently filtering every
    // result. WiGLE's default (no filter) is the safer default.
    const params = new URLSearchParams({
      latrange1: box.south.toFixed(6),
      latrange2: box.north.toFixed(6),
      longrange1: box.west.toFixed(6),
      longrange2: box.east.toFixed(6),
    });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WIGLE_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${WIGLE_URL}?${params}`, {
        headers: { Authorization: `Basic ${auth}` },
        redirect: 'manual',
        signal: controller.signal,
      });
      const text = await readResponseTextCapped(response, WIGLE_MAX_BODY_BYTES);
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        const error = new Error('WiGLE returned a non-JSON body');
        error.status = 502;
        throw error;
      }
      // WiGLE answers 200 with { success: false } for several real failures,
      // so status alone is not enough to tell success from failure.
      if (!response.ok || body?.success === false) {
        console.warn(
          '[WiGLE Proxy] upstream rejected:',
          response.status,
          body?.message || '(no message)',
        );
        const error = new Error(wigleClientError(response.status));
        error.status = response.status >= 400 ? response.status : 502;
        throw error;
      }
      return Array.isArray(body?.results)
        ? body.results.map(normalizeWigleNetwork).filter(Boolean)
        : [];
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function searchWigle(box) {
    const key = [box.south, box.west, box.north, box.east]
      .map((n) => n.toFixed(4))
      .join(',');

    const memHit = mem.get(key);
    if (memHit && Date.now() - memHit.at <= CACHE_TTL_MS) return memHit.body;
    const diskHit = await readDisk(key);
    if (diskHit) {
      mem.set(key, diskHit);
      return diskHit.body;
    }
    const existing = inFlight.get(key);
    if (existing) return existing;

    const request = (async () => {
      if (isOverBudget(currentBudget(), dailyBudgetLimit())) {
        const error = new Error(
          'Local WiGLE query budget for today is used up (WIGLE_DAILY_QUERY_BUDGET)',
        );
        error.status = 429;
        throw error;
      }
      currentBudget().count += 1;
      const networks = await fetchUpstream(box);
      const entry = { at: Date.now(), body: networks };
      mem.set(key, entry);
      if (mem.size > MEM_MAX_ENTRIES) mem.delete(mem.keys().next().value);
      writeDisk(key, entry);
      return networks;
    })();

    inFlight.set(key, request);
    try {
      return await request;
    } finally {
      inFlight.delete(key);
    }
  }

  const hasWigleKey = () =>
    Boolean(process.env.WIGLE_API_NAME && process.env.WIGLE_API_TOKEN);

  function sendJson(res, status, payload) {
    if (res.headersSent) return;
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(payload));
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/wigle/status', (req, res) => {
      sendJson(res, 200, { hasKey: hasWigleKey() });
    });

    server.middlewares.use('/api/wigle/search', async (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { available: false, networks: [], error: 'Method Not Allowed' });
        return;
      }
      if (!hasWigleKey()) {
        sendJson(res, 503, {
          available: false,
          networks: [],
          error: 'WIGLE_API_NAME/WIGLE_API_TOKEN not configured',
        });
        return;
      }
      if (!allow(clientKey(req))) {
        sendJson(res, 429, {
          available: true,
          networks: [],
          error: 'Too many WiGLE requests — slow down',
        });
        return;
      }
      const incoming = new URL(req.url || '/', 'http://localhost');
      const box = {
        south: Number(incoming.searchParams.get('south')),
        west: Number(incoming.searchParams.get('west')),
        north: Number(incoming.searchParams.get('north')),
        east: Number(incoming.searchParams.get('east')),
      };
      if (!isValidWigleViewport(box)) {
        sendJson(res, 400, {
          available: true,
          networks: [],
          error: 'Invalid or oversized viewport',
        });
        return;
      }
      try {
        const networks = await searchWigle(box);
        sendJson(res, 200, { available: true, networks, source: 'WiGLE' });
      } catch (error) {
        if (error?.code === 'RESPONSE_TOO_LARGE') {
          sendJson(res, 502, {
            available: true,
            networks: [],
            error: 'WiGLE response too large',
          });
          return;
        }
        // error.message here is ours (wigleClientError or a budget message),
        // never upstream text — see wigleClientError().
        sendJson(res, error?.status || 502, {
          available: true,
          networks: [],
          error: error?.message || 'WiGLE request failed',
        });
      }
    });
  };

  return {
    name: 'wigle-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
