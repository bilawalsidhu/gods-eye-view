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
/**
 * The oldest copy of a study's coordinates ever served. Past the TTL a copy is
 * served as 'stale' while refreshes fail (outage, 5xx, timeout); past this age
 * it is dropped and the study reads 'unavailable' until Movebank answers again.
 * These are exact positions of live animals, so revocation must fail closed:
 * if an owner withdraws a study in a way the proxy cannot see (a new error
 * shape, a long outage), its last public positions disappear within six hours.
 * Six hours is six refresh cycles and about twenty backed-off retries, enough
 * to ride out a Movebank restart or maintenance window, and by then the copy
 * is several report intervals behind the tags anyway.
 */
export const WILDLIFE_MAX_STALE_MS = 6 * 60 * MINUTE;
/**
 * Answers that mean the study is no longer public: drop its tracks at once,
 * without the retry a transient failure gets.
 */
const REVOKED_STATUSES = new Set([401, 403, 404, 410]);

class StudyWithdrawn extends Error {
  constructor(status) {
    super(`study_withdrawn (HTTP ${status})`);
    this.name = 'StudyWithdrawn';
  }
}

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
  /**
   * Studies Movebank no longer serves publicly (empty answer, or 401, 403,
   * 404, 410). Their tracks are purged; cleared by the next good answer.
   */
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
      if (REVOKED_STATUSES.has(response.status))
        throw new StudyWithdrawn(response.status);
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

  /** The owner made the study private: its tracks go with its licence. */
  function withdraw(id) {
    cache.delete(id);
    withdrawn.add(id);
    failedAt.set(id, now());
  }

  /** Drop every copy older than the hard maximum stale age. */
  function expire() {
    for (const [id, { fetchedAt }] of cache)
      if (now() - fetchedAt >= WILDLIFE_MAX_STALE_MS) {
        cache.delete(id);
        console.warn(
          `[wildlife] Movebank study ${id}: cached tracks expired unrefreshed`,
        );
      }
  }

  async function refreshStudy(id) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const animals = await fetchStudy(id);
        if (animals === null) {
          // An empty 200 has once been a hiccup; ask once more before acting.
          if (attempt === 0) {
            await wait(RETRY_DELAY_MS);
            continue;
          }
          withdraw(id);
          return;
        }
        cache.set(id, { animals, fetchedAt: now() });
        withdrawn.delete(id);
        failedAt.delete(id);
        return;
      } catch (error) {
        if (error instanceof StudyWithdrawn) {
          console.warn(`[wildlife] Movebank study ${id}: ${error.message}`);
          withdraw(id);
          return;
        }
        if (attempt === 0) {
          await wait(RETRY_DELAY_MS);
          continue;
        }
        console.warn(
          `[wildlife] Movebank study ${id} failed:`,
          error?.message || error,
        );
        failedAt.set(id, now());
        expire();
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

  /**
   * Each study is 'fresh' (copy younger than the TTL), 'stale' (older, while
   * refreshes fail, never past WILDLIFE_MAX_STALE_MS), 'pending' (first fetch
   * on its way), 'withdrawn' (no longer public; tracks purged) or
   * 'unavailable' (no copy to serve). Only fresh and stale studies have
   * animals.
   */
  function studyStatus(id, entry, walking) {
    if (entry)
      return now() - entry.fetchedAt < WILDLIFE_TTL_MS ? 'fresh' : 'stale';
    if (withdrawn.has(id)) return 'withdrawn';
    return walking.has(id) ? 'pending' : 'unavailable';
  }

  function snapshot() {
    expire();
    const walking = new Set(
      refreshing ? studies.filter(({ id }) => due(id)).map(({ id }) => id) : [],
    );
    const rows = studies.map(({ id }) => {
      const entry = cache.get(id);
      return {
        id,
        status: studyStatus(id, entry, walking),
        fetchedAt: entry?.fetchedAt ?? null,
        // Kept for clients that read the flag rather than the status.
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
