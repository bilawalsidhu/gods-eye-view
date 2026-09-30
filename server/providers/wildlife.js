import {
  WILDLIFE_STUDIES,
  movebankStudyUrl,
  parseMovebankStudy,
} from '../../src/layers/wildlife/records.js';
import { readResponseTextCapped } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// Movebank's keyless public feed allows one concurrent request per IP and
// large studies take up to two minutes to answer, so the browser never calls
// it. One refresher walks the curated studies strictly one at a time and the
// route serves whatever is cached, naming the studies still on their way.
const MINUTE = 60_000;
/** Tags report every few minutes to hours; an hour-old copy is current enough. */
export const WILDLIFE_TTL_MS = 60 * MINUTE;
/** The largest curated study took 116 s to answer on 2026-09-30. */
const TIMEOUT_MS = 150_000;
/** A study with 20 fixes for 200 animals is about 1 MB today. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** Movebank answers an occasional HTTP 500 that a single retry clears. */
const RETRY_DELAY_MS = 5_000;
/** After a study fails twice, leave it alone this long. */
const FAILURE_BACKOFF_MS = 15 * MINUTE;

/** Keyless, sequential, cached Movebank tracks for dev and preview. */
export function wildlifeProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  studies = WILDLIFE_STUDIES,
} = {}) {
  /** study id -> { animals, fetchedAt } */
  const cache = new Map();
  /** study id -> time of the last failed refresh */
  const failedAt = new Map();
  /** Studies Movebank no longer serves publicly (empty answer). */
  const withdrawn = new Set();
  let refreshing = null;
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 300 });

  const due = (id) =>
    (!cache.has(id) || now() - cache.get(id).fetchedAt >= WILDLIFE_TTL_MS) &&
    now() - (failedAt.get(id) ?? -Infinity) >= FAILURE_BACKOFF_MS;

  async function fetchStudy(id) {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetchImpl(movebankStudyUrl(id), {
      signal,
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'gods-eye-view-wildlife/1.0',
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('upstream_unavailable');
    }
    const body = await readResponseTextCapped(
      response,
      MAX_RESPONSE_BYTES,
      signal,
    );
    // Movebank answers a study that is not (or no longer) public with an
    // empty 200.
    if (!body.trim()) return null;
    const animals = parseMovebankStudy(JSON.parse(body), id);
    if (!animals) throw new Error('malformed_study');
    return animals;
  }

  async function refreshStudy(id) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const animals = await fetchStudy(id);
        if (animals === null) {
          if (attempt === 0) {
            await wait(RETRY_DELAY_MS);
            continue;
          }
          // The owner made the study private: its licence no longer applies,
          // so its cached tracks go too.
          cache.delete(id);
          withdrawn.add(id);
          failedAt.set(id, now());
          return;
        }
        cache.set(id, { animals, fetchedAt: now() });
        withdrawn.delete(id);
        failedAt.delete(id);
        return;
      } catch (error) {
        if (attempt === 0) {
          await wait(RETRY_DELAY_MS);
          continue;
        }
        console.warn(
          `[wildlife] Movebank study ${id} failed:`,
          error?.message || error,
        );
        failedAt.set(id, now());
      }
    }
  }

  /** Walk every due study one at a time; only one walk runs at once. */
  function refresh() {
    if (refreshing) return refreshing;
    if (!studies.some(({ id }) => due(id))) return null;
    refreshing = (async () => {
      try {
        for (const { id } of studies) if (due(id)) await refreshStudy(id);
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  function snapshot() {
    const walking = new Set(
      refreshing ? studies.filter(({ id }) => due(id)).map(({ id }) => id) : [],
    );
    const rows = studies.map(({ id }) => {
      const entry = cache.get(id);
      const status = entry ? 'ok' : walking.has(id) ? 'pending' : 'unavailable';
      return {
        id,
        status,
        fetchedAt: entry?.fetchedAt ?? null,
        ...(withdrawn.has(id) ? { withdrawn: true } : {}),
      };
    });
    const animals = studies.flatMap(({ id }) => cache.get(id)?.animals || []);
    const times = [...cache.values()].map(({ fetchedAt }) => fetchedAt);
    return {
      fetchedAt: times.length ? Math.min(...times) : null,
      studies: rows,
      animals,
      pending: rows
        .filter(({ status }) => status === 'pending')
        .map(({ id }) => id),
    };
  }

  function handler(req, res) {
    const json = (status, value) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const path = (req.url || '/').split('?')[0];
    if (path !== '/' && path !== '')
      return json(404, { error: 'unknown_route' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    // Never wait on Movebank: answer from the cache and let the walk continue.
    refresh()?.catch(() => {});
    json(200, snapshot());
  }

  return {
    name: 'wildlife',
    /** For tests and diagnostics: the walk in progress, if any. */
    get refreshing() {
      return refreshing;
    },
    configureServer({ middlewares }) {
      middlewares.use('/api/wildlife', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/wildlife', handler);
    },
  };
}
