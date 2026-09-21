import path from 'node:path';
import { promises as fsp } from 'node:fs';

import { clampInt } from './common/query.js';
import { clientKey, makeRateLimiter } from './common/rate-limit.js';
import {
  isOverBudget,
  normalizeBudget,
  utcDayKey,
} from '../../src/data/tomtomTiles.js';
import {
  WORLD_NEWS_REQUEST_POINTS,
  estimateWorldNewsPoints,
  mergeBatchArticles,
  normalizeWorldNewsArticles,
  retainWithinWindow,
} from '../../src/data/worldNewsArticles.js';
import { buildSearchNewsUrl, requestSearchNews } from './world-news/client.js';

/**
 * World News API headline proxy with a memory + disk cache, a retention cap
 * and a daily point governor.
 *
 * Upstream: GET https://api.worldnewsapi.com/search-news with
 * `add-entities=true` (the only way to receive geocoded location entities),
 * newest first, WORLD_NEWS_PAGES pages (default 5, max 5) of
 * WORLD_NEWS_PAGE_SIZE (default 100) articles per refresh, reaching back
 * WORLD_NEWS_WINDOW_HOURS (default 72). Paging is what adds headlines: only
 * a title-mentioned place can be pinned, so roughly a third of any page
 * reaches the map, and a wider window alone changes nothing because results
 * arrive newest-first. Each page costs points — see estimateWorldNewsPoints.
 * The key comes from WORLD_NEWS_API_KEY server-side only and travels
 * in the x-api-key header — the browser polls same-origin /api/world-news.
 *
 * Cache: TTL 30 min (45 min once the provider reports more than 4 points per
 * request — the measured-cost gate, which also halves the page size).
 * Retention: the provider's terms allow caching for at most one hour, so a
 * batch older than 60 min is deleted, never served stale — the one deliberate
 * departure from the FIRMS pattern. Single-flight refresh, sequential pages at
 * ≥1.2 s spacing (free plan: one request per second, one at a time).
 *
 * Budget governor (the TomTom pattern): a persistent counter keyed by UTC day
 * (.gev-cache/world-news/budget.json) adds the provider's X-API-Quota-Request
 * points for every upstream call — or the documented estimate (1 point +
 * 0.01 per result) when the response carries no such header, which the
 * payload reports as `costMeasured: false` — a rejected call still costs the
 * flat point — against WORLD_NEWS_DAILY_POINT_BUDGET (default 40 of the free
 * plan's 50). Over the cap the proxy serves the retained batch (`stale`,
 * `blocked: 'budget'`) or, without one, 429 {error:'budget'}.
 *
 * Routes (one middleware; sub-paths):
 *   GET /api/world-news        → snapshot payload (see buildPayload)
 *   GET /api/world-news/more   → one user-initiated extra page (≤3 per hour)
 *   GET /api/world-news/status → {hasKey, lastFetch, count, stale, blocked, budget, quota, ...}
 *
 * Keyless (no WORLD_NEWS_API_KEY): 503 {error:'no_key'}; upstream is never
 * touched. Upstream 401/403 → bad_key (until the key changes), 402 → quota
 * (until 00:00 UTC), 429 → rate_limited (10 s), other → upstream (60 s);
 * each serves the retained batch when one exists.
 *
 * Only compact records reach the browser (src/data/worldNewsArticles.js):
 * no article text, bylines or person/organization entities. Publisher image
 * URLs are opt-in (WORLD_NEWS_THUMBNAILS, default off) and are only ever a
 * LINK the browser resolves against the publisher — this server never fetches,
 * stores or re-serves an image, which is what keeps a thumbnail a link rather
 * than redistribution of someone else's copyrighted photo.
 *
 * @param {object} [options]
 * @param {number} [options.pageDelayMs=1200] Minimum spacing between upstream calls.
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @returns {import('vite').Plugin}
 */
export const WORLD_NEWS_TTL_MS = 30 * 60_000;
export const WORLD_NEWS_GATED_TTL_MS = 45 * 60_000;
export const WORLD_NEWS_RETENTION_MS = 60 * 60_000;
/**
 * Default age limit for a headline, in hours (`WORLD_NEWS_WINDOW_HOURS`).
 *
 * Widening this does NOT by itself put more pins on the globe: results come
 * back newest-first, so the first pages are the same articles whatever the
 * window. Measured against the live provider on 2026-09-20, a 24-hour window
 * already offered 13,507 English articles and a 72-hour window 52,859, yet
 * both returned an identical first page. The window only decides how far back
 * PAGING can reach; `WORLD_NEWS_PAGES` is what actually adds headlines.
 */
export const WORLD_NEWS_DEFAULT_WINDOW_HOURS = 72;
export const WORLD_NEWS_MIN_WINDOW_HOURS = 1;
export const WORLD_NEWS_MAX_WINDOW_HOURS = 168;
/**
 * Pages fetched per refresh (`WORLD_NEWS_PAGES`). Each page costs points, and
 * paging is the only setting that adds headlines, so this is the coverage/cost
 * dial. At the cost-gated 50-result page that is ~6.5 points a page: five
 * pages is ~32.5 a refresh, which needs a budget well above the 40 that suits
 * the free tier. Drop to 1 on the free plan.
 */
export const WORLD_NEWS_DEFAULT_PAGES = 5;
export const WORLD_NEWS_MAX_PAGES = 5;
export const WORLD_NEWS_DEFAULT_BUDGET = 40;
export const WORLD_NEWS_COST_GATE_POINTS = 4;
export const WORLD_NEWS_GATED_PAGE_SIZE = 50;
export const WORLD_NEWS_MAX_EXTRA_PAGES_PER_HOUR = 3;
const UPSTREAM_RETRY_MS = 60_000;
const RATE_LIMIT_RETRY_MS = 10_000;
const FAILURE_STATUS = Object.freeze({
  bad_key: 502,
  quota: 503,
  rate_limited: 503,
  upstream: 502,
  budget: 429,
});

/**
 * Next 00:00 UTC after `nowMs` — when the provider's daily quota resets.
 * @param {number} nowMs
 * @returns {number}
 */
export function nextUtcMidnight(nowMs) {
  const date = new Date(nowMs);
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1,
  );
}

export function worldNewsProxy({
  pageDelayMs = 1200,
  fetchImpl,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache', 'world-news');
  const LATEST_PATH = path.join(CACHE_DIR, 'latest.json');
  const BUDGET_PATH = path.join(CACHE_DIR, 'budget.json');
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 120 });

  const freshState = (language) => ({
    language,
    /** @type {Array<{at:number, articles:Array<object>, requested:number}>} */
    batches: [],
    offset: 0,
    refreshedAt: null,
    measuredCost: null,
    lastCharge: null,
    quota: null,
  });
  let state = freshState(null);
  let diskChecked = false;
  /** @type {?Promise<{batch?: object, failure?: string}>} single-flight refresh */
  let inflight = null;
  let budget = null;
  let budgetLoaded = false;
  let lastUpstreamAt = 0;
  let chain = Promise.resolve();
  const blockedUntil = { quota: 0, rate_limited: 0, upstream: 0 };
  let rejectedKey = null;
  let extraPageTimes = [];

  const apiKey = () => String(process.env.WORLD_NEWS_API_KEY || '').trim();
  const budgetLimit = () =>
    clampInt(
      process.env.WORLD_NEWS_DAILY_POINT_BUDGET,
      1,
      1_000_000,
      WORLD_NEWS_DEFAULT_BUDGET,
    );
  const pages = () =>
    clampInt(
      process.env.WORLD_NEWS_PAGES,
      1,
      WORLD_NEWS_MAX_PAGES,
      WORLD_NEWS_DEFAULT_PAGES,
    );
  /**
   * Opt-in publisher thumbnail URLs (`WORLD_NEWS_THUMBNAILS`). Off by default:
   * the image is the publisher's, and a link the browser resolves is a very
   * different act from this server fetching and re-serving one.
   */
  const thumbnails = () =>
    /^(1|true|yes|on)$/i.test(
      String(process.env.WORLD_NEWS_THUMBNAILS || '').trim(),
    );
  /** Oldest publish time a headline may carry, as epoch ms. */
  const windowMs = () =>
    clampInt(
      process.env.WORLD_NEWS_WINDOW_HOURS,
      WORLD_NEWS_MIN_WINDOW_HOURS,
      WORLD_NEWS_MAX_WINDOW_HOURS,
      WORLD_NEWS_DEFAULT_WINDOW_HOURS,
    ) * 3_600_000;
  const costGated = () =>
    Number.isFinite(state.measuredCost) &&
    state.measuredCost > WORLD_NEWS_COST_GATE_POINTS;
  const pageSize = () => {
    const size = clampInt(process.env.WORLD_NEWS_PAGE_SIZE, 10, 100, 100);
    return costGated() ? Math.min(size, WORLD_NEWS_GATED_PAGE_SIZE) : size;
  };
  const ttlMs = () =>
    costGated() ? WORLD_NEWS_GATED_TTL_MS : WORLD_NEWS_TTL_MS;
  /** ISO 639-1 code; unset defaults to English, an empty value means all. */
  function language() {
    const raw = process.env.WORLD_NEWS_LANGUAGE;
    if (raw === undefined) return 'en';
    const value = String(raw).trim().toLowerCase();
    return /^[a-z]{2}$/.test(value) ? value : '';
  }
  const hasData = () => state.batches.length > 0;

  async function readDiskOnce() {
    if (diskChecked) return;
    diskChecked = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(LATEST_PATH, 'utf8'));
      if (
        parsed &&
        typeof parsed.language === 'string' &&
        Array.isArray(parsed.batches)
      ) {
        state = {
          language: parsed.language,
          batches: retainWithinWindow(
            parsed.batches,
            Date.now(),
            WORLD_NEWS_RETENTION_MS,
          ),
          offset: Number.isFinite(parsed.offset) ? parsed.offset : 0,
          refreshedAt: Number.isFinite(parsed.refreshedAt)
            ? parsed.refreshedAt
            : null,
          measuredCost: Number.isFinite(parsed.measuredCost)
            ? parsed.measuredCost
            : null,
          lastCharge: Number.isFinite(parsed.lastCharge)
            ? parsed.lastCharge
            : null,
          quota:
            parsed.quota && typeof parsed.quota === 'object'
              ? parsed.quota
              : null,
        };
      }
    } catch {
      /* no disk cache yet */
    }
  }

  async function writeDisk() {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(
        LATEST_PATH,
        JSON.stringify({ version: 1, ...state }),
        'utf8',
      );
    } catch (err) {
      console.warn(
        '[world-news-proxy] cache write failed:',
        err?.message || err,
      );
    }
  }

  async function loadBudgetOnce() {
    if (budgetLoaded) return;
    budgetLoaded = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(BUDGET_PATH, 'utf8'));
      if (
        parsed &&
        typeof parsed.date === 'string' &&
        Number.isFinite(parsed.count)
      )
        budget = parsed;
    } catch {
      /* no budget file yet */
    }
  }

  async function persistBudget() {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(BUDGET_PATH, JSON.stringify(budget), 'utf8');
    } catch (err) {
      console.warn(
        '[world-news-proxy] budget write failed:',
        err?.message || err,
      );
    }
  }

  /** Roll the counter to today (UTC) and return it. */
  function currentBudget() {
    budget = normalizeBudget(budget, utcDayKey(Date.now()));
    return budget;
  }

  /** Add measured (or estimated) points to today's budget (async persist). */
  function recordSpend(points) {
    const current = currentBudget();
    const spent = Math.max(0, Number(points) || 0);
    current.count = Math.round((current.count + spent) * 100) / 100;
    void persistBudget();
  }

  const budgetPayload = () => {
    const current = currentBudget();
    return { spent: current.count, limit: budgetLimit(), date: current.date };
  };

  /** Drop batches past the one-hour retention and stale extra-page marks. */
  function purge(now) {
    if (state.language !== language()) state = freshState(language());
    state.batches = retainWithinWindow(
      state.batches,
      now,
      WORLD_NEWS_RETENTION_MS,
    );
    if (!state.batches.length) state.refreshedAt = null;
    extraPageTimes = extraPageTimes.filter((t) => now - t < 3_600_000);
  }

  function currentBlocked(now, key) {
    if (rejectedKey && rejectedKey === key) return 'bad_key';
    if (now < blockedUntil.quota) return 'quota';
    if (now < blockedUntil.rate_limited) return 'rate_limited';
    if (now < blockedUntil.upstream) return 'upstream';
    if (isOverBudget(currentBudget(), budgetLimit())) return 'budget';
    return null;
  }

  /** Map an upstream failure to a blocked state and remember it. */
  function noteFailure(error, now, key) {
    const code = FAILURE_STATUS[error?.code] ? error.code : 'upstream';
    if (code === 'bad_key') rejectedKey = key;
    else if (code === 'quota') blockedUntil.quota = nextUtcMidnight(now);
    else if (code === 'rate_limited')
      blockedUntil.rate_limited = now + RATE_LIMIT_RETRY_MS;
    else blockedUntil.upstream = now + UPSTREAM_RETRY_MS;
    if (error?.quota) {
      state.quota = { used: error.quota.used, left: error.quota.left };
    }
    // Never log the URL or the provider's body — either can carry the key or
    // article text. The HTTP status and our own message are safe and are what
    // makes a failure diagnosable: "upstream failed (upstream)" alone cannot
    // tell a timeout from a 500 from a dropped connection, which left a real
    // LOAD MORE failure on 2026-09-21 impossible to explain after the fact.
    const detail = [
      Number.isFinite(error?.status) ? `HTTP ${error.status}` : null,
      typeof error?.message === 'string' && error.message
        ? error.message
        : null,
    ]
      .filter(Boolean)
      .join(' — ');
    console.warn(
      `[world-news-proxy] upstream failed (${code})${detail ? `: ${detail}` : ''}`,
    );
    return code;
  }

  /**
   * One upstream page through the serial gate (≥ pageDelayMs apart). Records
   * the measured cost; a rejected request still charges the flat point.
   */
  function upstream(key, offset) {
    const run = async () => {
      const gap = lastUpstreamAt + pageDelayMs - Date.now();
      if (gap > 0) await sleep(gap);
      lastUpstreamAt = Date.now();
      const url = buildSearchNewsUrl({
        number: pageSize(),
        offset,
        language: language(),
        sinceMs: Date.now() - windowMs(),
        extraQuery: process.env.WORLD_NEWS_EXTRA_QUERY,
      });
      try {
        const result = await requestSearchNews({ key, url, fetchImpl });
        const measured = result.quota.request;
        const charged = Number.isFinite(measured)
          ? measured
          : estimateWorldNewsPoints(result.news.length);
        recordSpend(charged);
        if (Number.isFinite(measured)) state.measuredCost = measured;
        state.lastCharge = charged;
        state.quota = { used: result.quota.used, left: result.quota.left };
        rejectedKey = null;
        return result;
      } catch (error) {
        recordSpend(WORLD_NEWS_REQUEST_POINTS);
        throw error;
      }
    };
    const next = chain.then(run, run);
    chain = next.catch(() => {});
    return next;
  }

  /** Full refresh: sequential pages; partial success keeps earlier pages. */
  async function refresh(key, now) {
    const size = pageSize();
    const batch = { at: now, articles: [], requested: 0 };
    let fetchedPages = 0;
    let failure = null;
    for (let page = 0; page < pages(); page++) {
      try {
        const result = await upstream(key, page * size);
        fetchedPages++;
        batch.requested += result.news.length;
        for (const record of normalizeWorldNewsArticles(result.news, {
          thumbnails: thumbnails(),
        }))
          batch.articles.push(record);
        if (result.news.length < size) break;
      } catch (error) {
        failure = error;
        break;
      }
    }
    if (failure && fetchedPages === 0) throw failure;
    return { batch, nextOffset: fetchedPages * size, failure };
  }

  function applyRefresh({ batch, nextOffset }, now) {
    state.batches = [
      ...retainWithinWindow(state.batches, now, WORLD_NEWS_RETENTION_MS),
      batch,
    ];
    state.offset = nextOffset;
    state.refreshedAt = now;
  }

  const morePagesLeft = (blocked) =>
    blocked
      ? 0
      : Math.max(
          0,
          WORLD_NEWS_MAX_EXTRA_PAGES_PER_HOUR - extraPageTimes.length,
        );

  function buildPayload({ stale, blocked }) {
    const articles = mergeBatchArticles(state.batches);
    const requested = state.batches.reduce(
      (total, batch) => total + (batch.requested || 0),
      0,
    );
    return {
      fetchedAt: state.refreshedAt,
      stale,
      ttlMs: ttlMs(),
      retentionMs: WORLD_NEWS_RETENTION_MS,
      pageSize: pageSize(),
      count: articles.length,
      requested,
      placedCount: articles.length,
      unplacedCount: Math.max(0, requested - articles.length),
      blocked,
      budget: budgetPayload(),
      quota: state.quota,
      costPerRequest: state.measuredCost ?? state.lastCharge,
      costMeasured: Number.isFinite(state.measuredCost),
      // Whether records may carry `image`. Cached batches outlive an env
      // change, so the client is told what this payload actually holds
      // rather than inferring it from the presence of a field.
      thumbnails: thumbnails(),
      morePagesLeft: morePagesLeft(blocked),
      articles,
    };
  }

  function statusPayload(key, now) {
    const blocked = key ? currentBlocked(now, key) : null;
    const articles = mergeBatchArticles(state.batches);
    return {
      hasKey: Boolean(key),
      lastFetch: state.refreshedAt,
      count: articles.length,
      stale: hasData() ? now - state.refreshedAt >= ttlMs() : false,
      ttlMs: ttlMs(),
      retentionMs: WORLD_NEWS_RETENTION_MS,
      blocked,
      budget: budgetPayload(),
      quota: state.quota,
      costPerRequest: state.measuredCost ?? state.lastCharge,
      costMeasured: Number.isFinite(state.measuredCost),
      morePagesLeft: key ? morePagesLeft(blocked) : 0,
    };
  }

  /** One explicit extra page beyond the snapshot — user-initiated spend. */
  async function handleMore(key, now, sendJson) {
    if (extraPageTimes.length >= WORLD_NEWS_MAX_EXTRA_PAGES_PER_HOUR) {
      sendJson(429, { error: 'pages' });
      return;
    }
    const blocked = currentBlocked(now, key);
    if (blocked) {
      sendJson(FAILURE_STATUS[blocked], { error: blocked });
      return;
    }
    if (inflight) await inflight;
    try {
      const result = await upstream(key, state.offset);
      state.batches = [
        ...retainWithinWindow(state.batches, now, WORLD_NEWS_RETENTION_MS),
        {
          at: now,
          articles: normalizeWorldNewsArticles(result.news, {
            thumbnails: thumbnails(),
          }),
          requested: result.news.length,
        },
      ];
      state.offset += result.news.length;
      extraPageTimes.push(now);
      await writeDisk();
      sendJson(200, buildPayload({ stale: false, blocked: null }));
    } catch (error) {
      const code = noteFailure(error, now, key);
      sendJson(FAILURE_STATUS[code] || 502, { error: code });
    }
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/world-news', async (req, res) => {
      const sendJson = (status, obj) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(obj));
      };
      try {
        if (req.method && req.method !== 'GET') {
          sendJson(405, { error: 'method_not_allowed' });
          return;
        }
        const subPath = String(req.url || '')
          .split('?')[0]
          .replace(/\/+$/, '');
        const now = Date.now();
        const key = apiKey();
        await readDiskOnce();
        await loadBudgetOnce();
        purge(now);

        if (subPath === '/status') {
          sendJson(200, statusPayload(key, now));
          return;
        }
        if (subPath !== '' && subPath !== '/more') {
          sendJson(404, { error: 'not_found' });
          return;
        }
        if (!key) {
          sendJson(503, { error: 'no_key' });
          return;
        }
        if (!allow(clientKey(req))) {
          sendJson(429, { error: 'rate_limited' });
          return;
        }
        if (subPath === '/more' && hasData()) {
          await handleMore(key, now, sendJson);
          return;
        }
        // Fresh snapshot — never counts against the budget.
        if (hasData() && now - state.refreshedAt < ttlMs()) {
          sendJson(200, buildPayload({ stale: false, blocked: null }));
          return;
        }
        const blocked = currentBlocked(now, key);
        if (blocked) {
          if (hasData()) sendJson(200, buildPayload({ stale: true, blocked }));
          else sendJson(FAILURE_STATUS[blocked], { error: blocked });
          return;
        }
        // Stale or missing → refresh, single-flight. Capture the promise
        // locally BEFORE awaiting: the .finally() nulls `inflight` on settle.
        if (!inflight) {
          inflight = refresh(key, now)
            .then(async (result) => {
              applyRefresh(result, now);
              await writeDisk();
              return {
                batch: result.batch,
                failure: result.failure
                  ? noteFailure(result.failure, now, key)
                  : null,
              };
            })
            .catch((error) => ({ failure: noteFailure(error, now, key) }))
            .finally(() => {
              inflight = null;
            });
        }
        const result = await inflight;
        if (result.batch) {
          sendJson(
            200,
            buildPayload({ stale: false, blocked: result.failure }),
          );
        } else if (hasData()) {
          sendJson(200, buildPayload({ stale: true, blocked: result.failure }));
        } else {
          sendJson(FAILURE_STATUS[result.failure] || 502, {
            error: result.failure || 'upstream',
          });
        }
      } catch (err) {
        console.warn('[world-news-proxy] error:', err?.message || err);
        sendJson(500, { error: 'world-news proxy error' });
      }
    });
  };
  return {
    name: 'world-news-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
