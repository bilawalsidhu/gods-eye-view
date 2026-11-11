/**
 * Realtime train proxy for the Rail data layer.
 *
 * Only URLs registered in `src/data/railFeeds.js` are ever fetched: the browser
 * names a registered id, never a URL. The request policy is the Transit
 * proxy's (src/sources/transitService.js), applied to the rail registry: hop-by-hop
 * redirects on the feed's own https origin, a byte cap, a memory cache with
 * single-flight refresh (15 s unless the feed sets its own window),
 * serve-stale-on-failure for up to 10 minutes, a fixed-window admission
 * limiter and a per-feed cooldown ladder. No disk cache and no history store.
 *
 * Every registered feed is open: no request carries a credential.
 */

import { coalesceProxyRequest, readResponseBytesCapped } from './httpBody.js';
import { makeRateLimiter } from './rateLimit.js';
import {
  publicRailCatalog,
  railEnabledFeeds,
  railFeedNeedsSchedulePack,
} from '../data/railFeeds.js';
import {
  TRANSIT_MAX_REDIRECTS,
  isTransitRedirectStatus,
  transitRedirectDecision,
} from '../data/transitProxy.js';
import {
  RAIL_ADMISSION_MAX_PER_FEED,
  RAIL_ADMISSION_WINDOW_MS,
  RAIL_PATH_PACK_MAX_BYTES,
  RAIL_PROXY_TIMEOUT_MS,
  RailFeedShapeError,
  buildRailSnapshot,
  buildRailTripUpdatesSnapshot,
  railAdmissionGlobalMax,
  isAcceptableRailUpstreamUrl,
  nextRailBackoffMs,
  railCacheStateFor,
  railFeedTtlMs,
  railMaxBodyBytes,
  railResponseHeaders,
  railUpstreamHeaders,
  resolveRailRoute,
} from '../data/railProxy.js';
import {
  RAIL_SCHEDULE_PACK_VERSION,
  liveDelaySec,
  schedulePackEndMs,
} from '../data/railSchedule.js';
import { createRunIndex } from '../data/railScheduleIndex.js';

const JSON_NO_STORE = Object.freeze({
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
});

/**
 * A request header, from a Fetch Request's Headers or a Node-style headers
 * object (lowercase names), or null.
 * @param {{headers?: Headers|Record<string, string|string[]|undefined>}} incoming
 * @param {string} name Lowercase.
 * @returns {string|null}
 */
function requestHeader(incoming, name) {
  const headers = incoming?.headers;
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const value = headers[name];
  if (Array.isArray(value)) return value.join(', ');
  return typeof value === 'string' ? value : null;
}

/**
 * The strong entity tag of a pack version (a build stamp, or a file's time
 * and size): percent-encoded, so any version is a valid tag and two versions
 * never share one.
 * @param {string} version
 * @returns {string}
 */
function packEtag(version) {
  return `"${encodeURIComponent(version)}"`;
}

/** Whether an If-None-Match header names this tag (weak comparison). */
function etagMatches(header, etag) {
  if (!header) return false;
  const own = etag.replace(/^W\//, '');
  return header
    .split(',')
    .map((tag) => tag.trim())
    .some((tag) => tag === '*' || tag.replace(/^W\//, '') === own);
}

/**
 * Fetch a registered feed URL, resolving each redirect hop BEFORE following
 * it (the Transit rule, transitRedirectDecision), so a hop that leaves the
 * URL's https origin is refused without being contacted.
 * @param {object} feed Registry entry.
 * @param {AbortSignal} signal Abort signal for the whole hop chain.
 * @param {typeof fetch} [fetchImpl] Injected for tests.
 * @param {{etag?: string|null, lastModified?: string|null}} [validators]
 * @param {{url?: string}} [options] Which registered URL: the positions
 *   `url` by default, or `tripUpdatesUrl`.
 * @returns {Promise<{response: Response, finalUrl: string}>}
 */
export async function fetchRailFeed(
  feed,
  signal,
  fetchImpl = fetch,
  validators = null,
  { url = feed.url } = {},
) {
  let current = url;
  for (let hop = 0; hop <= TRANSIT_MAX_REDIRECTS; hop += 1) {
    const response = await fetchImpl(current, {
      signal,
      method: 'GET',
      headers: railUpstreamHeaders(feed, validators),
      redirect: 'manual',
    });
    // A 304 is the answer to our own conditional request, not a redirect.
    if (!isTransitRedirectStatus(response?.status)) {
      return { response, finalUrl: current };
    }
    const decision = transitRedirectDecision(
      url,
      current,
      response.headers.get('location'),
    );
    try {
      await response.body?.cancel();
    } catch {
      /* no-op */
    }
    if (!decision.ok) throw new Error(`upstream ${decision.reason}`);
    if (hop === TRANSIT_MAX_REDIRECTS) {
      throw new Error('upstream redirected too many times');
    }
    current = decision.url;
  }
  throw new Error('upstream redirected too many times');
}

/**
 * A Response body for a pack as the reader returned it: text as it is,
 * bytes as the one chunk of a stream. A Response made from bytes directly
 * copies them; a stream hands the reader's own buffer on, so a large pack
 * is never decoded or copied on its way out.
 * @param {string|Uint8Array|ArrayBuffer} body
 * @returns {string|ReadableStream<Uint8Array>}
 */
function packBody(body) {
  if (typeof body === 'string') return body;
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** When a viewer asks again for a pack that could not be read (s). */
const PACK_UNREADABLE_RETRY_S = 60;

/** How long an answer to "is this feed's schedule pack built?" is kept. */
export const SCHEDULE_PACK_PROBE_TTL_MS = 60_000;
const SCHEDULE_PACK_PROBE_RETRY_S = SCHEDULE_PACK_PROBE_TTL_MS / 1000;

/**
 * Runtime-agnostic request service for `/api/rail`, shared by the Vite
 * plugin and any other host.
 *
 *   GET /api/rail/feeds            → public catalog (coverage + credit)
 *   GET /api/rail/trains/<feedId>  → decoded, train-only snapshot as JSON
 *   GET /api/rail/updates/<feedId> → the feed's rail trip updates as JSON
 *   GET /api/rail/paths/<feedId>   → the feed's track path pack, when built
 *   GET /api/rail/schedule/<feedId> → the feed's timetable pack, when built
 *
 * Path and schedule packs are offline build output
 * (scripts/build-rail-paths.mjs). The service never touches storage itself:
 * the host injects a pack reader for each, `readPathPack` and
 * `readSchedulePack` (an fs reader in development). A reader receives a
 * registered, enabled feed id and the byte cap, and resolves to the pack's
 * JSON text or bytes, or null when the feed has no pack; a pack over the cap
 * may instead be refused by throwing an error with `code: 'PACK_TOO_LARGE'`.
 * Bytes are served as they are, never decoded or copied here. Null is the
 * only "no pack" (404); a reader that throws is a fault here (503), which a
 * viewer asks again about.
 *
 * Every train is placed where its operator reports it; a schedule pack only
 * adds what the live feed leaves out (line names, stop names, next stops).
 * Packs are opt-in build output: a live feed whose trains are named only
 * through its pack (`railFeedNeedsSchedulePack`: `routesFrom: 'schedule'`)
 * is listed in the catalog, and its trains and trip updates are served, only
 * once the pack is built, so feeds nobody has built stay out of sight
 * instead of reading as unavailable. Whether a pack
 * is built is asked of `hasSchedulePack(feedId)` when given, else of
 * `schedulePackVersion` (null: not built), else of `readSchedulePack` (null:
 * not built); with none of them no such feed is built. Answers are kept for
 * SCHEDULE_PACK_PROBE_TTL_MS; a probe that fails counts the pack as built,
 * so the failure shows where its pack is read.
 *
 * `schedulePackVersion(feedId)` names the pack as it is now (a build stamp,
 * or a file's time and size), or null when there is none. With it, what the
 * realtime routes read from a pack is rebuilt within
 * SCHEDULE_PACK_PROBE_TTL_MS of a new build; without it, within an hour.
 * `pathPackVersion(feedId)` does the same for path packs.
 *
 * A path or schedule pack is served `no-cache`: a feed's two packs are read
 * as a pair (the schedule's `pathsBuiltAt` names its path pack's `builtAt`),
 * so a browser asks again each time instead of keeping one of them for an
 * hour past a rebuild. With the pack's version, the answer carries it as its
 * ETag, and a request whose If-None-Match names it is answered 304 without
 * reading the pack.
 *
 * @param {{fetchImpl?: typeof fetch,
 *   readPathPack?: (feedId: string, options: {maxBytes: number}) =>
 *     Promise<string|Uint8Array|null>,
 *   readSchedulePack?: (feedId: string, options: {maxBytes: number}) =>
 *     Promise<string|Uint8Array|null>,
 *   hasSchedulePack?: (feedId: string) => Promise<boolean>,
 *   schedulePackVersion?: (feedId: string) => Promise<string|null>,
 *   pathPackVersion?: (feedId: string) => Promise<string|null>,
 *   now?: () => number}} [options]
 * @returns {{handle: (request: Request) => Promise<Response>, close: () => void}}
 */
export function createRailService({
  fetchImpl = fetch,
  readPathPack = null,
  readSchedulePack = null,
  hasSchedulePack = null,
  schedulePackVersion = null,
  pathPackVersion = null,
  now: clock = () => Date.now(),
} = {}) {
  /** Whether a feed's timetable pack is built, as the host can tell. */
  const probeSchedulePack =
    typeof hasSchedulePack === 'function'
      ? hasSchedulePack
      : typeof schedulePackVersion === 'function'
        ? async (feedId) => (await schedulePackVersion(feedId)) != null
        : typeof readSchedulePack === 'function'
          ? async (feedId) => {
              try {
                const body = await readSchedulePack(feedId, {
                  maxBytes: RAIL_PATH_PACK_MAX_BYTES,
                });
                return body !== null && body !== undefined;
              } catch (error) {
                // Built, but refused: the pack's own route says so.
                if (error?.code === 'PACK_TOO_LARGE') return true;
                throw error;
              }
            }
          : null;
  /** Probe answers by feed id: {at, built}. */
  const schedulePackProbes = new Map();
  async function schedulePackBuilt(feedId) {
    if (!probeSchedulePack) return false;
    const seen = schedulePackProbes.get(feedId);
    if (seen && clock() - seen.at < SCHEDULE_PACK_PROBE_TTL_MS)
      return seen.built;
    let built;
    try {
      built = (await probeSchedulePack(feedId)) === true;
    } catch (error) {
      console.warn(`[rail] ${feedId}: schedule pack probe failed`, error);
      built = true;
    }
    schedulePackProbes.set(feedId, { at: clock(), built });
    return built;
  }
  /** Whether the feed can be served: it needs no pack, or its pack is built. */
  async function feedServable(feed) {
    return !railFeedNeedsSchedulePack(feed) || schedulePackBuilt(feed.id);
  }
  /** The catalog, with pack-routed feeds whose pack is unbuilt left out. */
  async function catalog() {
    const built = new Set();
    await Promise.all(
      railEnabledFeeds()
        .filter((feed) => railFeedNeedsSchedulePack(feed))
        .map(async (feed) => {
          if (await schedulePackBuilt(feed.id)) built.add(feed.id);
        }),
    );
    return publicRailCatalog({
      schedulePackBuilt: (feedId) => built.has(feedId),
    });
  }
  /**
   * Snapshots by `<route>:<feedId>`, so a feed's positions and its trip
   * updates never share an entry, a cooldown or an admission count.
   * @type {Map<string, {at:number, contactedAt:number, body:string, host:string, etag:string|null, lastModified:string|null}>}
   */
  const cache = new Map();
  let closed = false;
  const inFlight = new Map();
  const controllers = new Set();
  /** @type {Map<string, {failures:number, nextAttemptAt:number, reason:string}>} */
  const cooldown = new Map();
  const admit = makeRateLimiter({
    windowMs: RAIL_ADMISSION_WINDOW_MS,
    max: RAIL_ADMISSION_MAX_PER_FEED,
    // Scales with the registry (railAdmissionGlobalMax): a backstop, while
    // each feed's freshness window protects its operator.
    globalMax: railAdmissionGlobalMax(),
    now: clock,
  });

  /**
   * What the realtime path reads from a feed's schedule pack, built when the
   * pack is read and kept an hour, or until the pack's version changes
   * (retried after five minutes when the pack is missing or unreadable).
   * The pack's text and its parsed form are released once these are built;
   * `runs` keeps the pack's trips, profiles and services for the hour.
   *  - `routes`: trip id to pack route id, for feeds whose realtime trips do
   *    not carry the route their classifier reads (`routesFrom:
   *    'schedule'`). Without it those trains are dropped, not misfiled.
   *  - `runs`: dated runs by train number, for positions that name trains
   *    by number (`positionsByTrainNumber`: Irish Rail's train codes), so a
   *    reported train takes its line and stops. Its position stays the
   *    reported one.
   *  - `endsMs`: when the last run the pack holds arrives (null when it
   *    names no window), past which the pack is stale.
   * A pack is refused, as one that cannot be read, when it is of another
   * format version or another feed, or once its window has ended
   * (`endsMs`): it names no train running now. A feed that cannot be read
   * without its pack answers 503 rather than an empty list when every
   * record was dropped (assertPackRead). With `schedulePackVersion`, an
   * entry is checked against the pack's version once per
   * SCHEDULE_PACK_PROBE_TTL_MS and rebuilt when the pack changed.
   * @type {Map<string, {at: number, checkedAt: number, ttl: number,
   *   version: string|null|undefined, lookups: Promise<object>}>}
   */
  const scheduleLookups = new Map();
  const SCHEDULE_LOOKUPS_TTL_MS = 60 * 60_000;
  const SCHEDULE_LOOKUPS_RETRY_MS = 5 * 60_000;
  const NO_LOOKUPS = Object.freeze({
    routes: new Map(),
    runs: null,
    endsMs: null,
  });

  /** Positions that name trains by number (Irish Rail's train codes). */
  function namesTrains(feed) {
    return feed.positionsByTrainNumber === true;
  }

  /**
   * Feeds that read the pack's trip-to-route lookup (`routes`): their
   * realtime trips do not carry the route their classifier reads, so
   * neither of the feed's routes keeps anything without the pack.
   */
  function readsPackRoutes(feed) {
    return feed.routesFrom === 'schedule';
  }

  function needsSchedule(feed) {
    return readsPackRoutes(feed) || namesTrains(feed);
  }

  /**
   * Refuse a snapshot in which every record was dropped, for a feed whose
   * records are classified by its schedule pack's routes: the pack is
   * missing, unreadable or refused, or names none of the trips the feed runs
   * now (a stale pack: Renfe's trip ids carry their date). That is
   * "unavailable" (503), not a healthy feed with no trains. A snapshot that
   * keeps any train still answers (Irish Rail's train codes classify its
   * trains without the pack).
   */
  function assertPackRead(feed, snapshot) {
    if (!readsPackRoutes(feed)) return;
    if (snapshot.count > 0) return;
    const refused = snapshot.dropped ?? 0;
    if (refused === 0) return;
    const error = new Error(
      `schedule pack unavailable: ${refused} records need it`,
    );
    error.code = 'SCHEDULE_UNAVAILABLE';
    throw error;
  }

  /** Why a decoded schedule pack cannot be read for this feed now, or null. */
  function packRefusal(feed, raw, endsMs, at) {
    if (raw?.version !== RAIL_SCHEDULE_PACK_VERSION)
      return `version ${JSON.stringify(raw?.version ?? null)} is unknown`;
    if (raw.feedId !== feed.id)
      return `it is for ${JSON.stringify(raw.feedId ?? null)}`;
    if (endsMs !== null && at >= endsMs)
      return Number.isFinite(endsMs)
        ? `its window ended ${new Date(endsMs).toISOString()}`
        : 'it holds no run';
    return null;
  }

  async function readScheduleLookups(feed) {
    if (typeof readSchedulePack !== 'function') return null;
    const body = await readSchedulePack(feed.id, {
      maxBytes: RAIL_PATH_PACK_MAX_BYTES,
    });
    if (body === null || body === undefined) return null;
    const text =
      typeof body === 'string' ? body : new TextDecoder().decode(body);
    if (text.length > RAIL_PATH_PACK_MAX_BYTES)
      throw new Error('schedule pack over the cap');
    const raw = JSON.parse(text);
    const endsMs = schedulePackEndMs(raw);
    const refusal = packRefusal(feed, raw, endsMs, clock());
    if (refusal) throw new Error(`schedule pack refused: ${refusal}`);
    const routes = new Map();
    const trips = raw.trips;
    if (readsPackRoutes(feed) && trips && typeof trips === 'object')
      for (const [tripId, trip] of Object.entries(trips))
        if (typeof trip?.route === 'string') routes.set(tripId, trip.route);
    return {
      routes,
      runs: namesTrains(feed) ? createRunIndex(raw) : null,
      endsMs,
    };
  }

  /**
   * A pack's version now, or undefined when the host names none or it
   * cannot be read.
   * @param {'schedule'|'paths'} kind
   * @param {string} feedId
   */
  async function packVersionNow(kind, feedId) {
    const versionOf =
      kind === 'schedule' ? schedulePackVersion : pathPackVersion;
    if (typeof versionOf !== 'function') return undefined;
    try {
      return (await versionOf(feedId)) ?? null;
    } catch (error) {
      console.warn(
        `[rail-proxy] ${feedId} ${kind === 'schedule' ? 'schedule' : 'path'} pack version unreadable: ${error?.message || error}`,
      );
      return undefined;
    }
  }

  /**
   * Build a feed's lookups, tied to the pack version read just before the
   * pack: a build that lands in between is seen at the next check.
   */
  function buildScheduleLookups(feed, at) {
    const fresh = {
      at,
      checkedAt: at,
      ttl: SCHEDULE_LOOKUPS_TTL_MS,
      version: undefined,
      /** The last version check: resolves true while the pack is unchanged. */
      current: true,
      lookups: null,
    };
    fresh.lookups = (async () => {
      fresh.version = await packVersionNow('schedule', feed.id);
      return readScheduleLookups(feed);
    })().then(
      (lookups) => {
        if (!lookups) fresh.ttl = SCHEDULE_LOOKUPS_RETRY_MS;
        return lookups || NO_LOOKUPS;
      },
      (error) => {
        fresh.ttl = SCHEDULE_LOOKUPS_RETRY_MS;
        console.warn(
          `[rail-proxy] ${feed.id} schedule pack unreadable: ${error?.message || error}`,
        );
        return NO_LOOKUPS;
      },
    );
    scheduleLookups.set(feed.id, fresh);
    return fresh;
  }

  /**
   * Whether a kept entry still matches the pack: with a version from the
   * host, asked at most once per SCHEDULE_PACK_PROBE_TTL_MS (concurrent
   * askers share the one check).
   */
  async function lookupsCurrent(feed, entry, at) {
    if (typeof schedulePackVersion !== 'function') return true;
    if (at - entry.checkedAt >= SCHEDULE_PACK_PROBE_TTL_MS) {
      entry.checkedAt = at;
      entry.current = (async () => {
        await entry.lookups;
        const version = await packVersionNow('schedule', feed.id);
        // An unreadable version keeps what is built.
        return version === undefined || version === entry.version;
      })();
    }
    return entry.current;
  }

  async function scheduleLookupsFor(feed) {
    if (!needsSchedule(feed)) return NO_LOOKUPS;
    const at = clock();
    let entry = scheduleLookups.get(feed.id);
    if (!entry || at - entry.at >= entry.ttl) {
      entry = buildScheduleLookups(feed, at);
    } else if (!(await lookupsCurrent(feed, entry, at))) {
      // A rebuilt pack: its trips replace the old pack's at once. Another
      // caller that saw the same change may have rebuilt already.
      const latest = scheduleLookups.get(feed.id);
      entry = latest !== entry ? latest : buildScheduleLookups(feed, clock());
    }
    const lookups = await entry.lookups;
    if (lookups.endsMs !== null && clock() >= lookups.endsMs) {
      // The window ended while the entry was kept: refused from now on, and
      // read again after five minutes, when a new build may be there.
      if (!entry.ended) {
        entry.ended = true;
        entry.ttl = Math.min(
          entry.ttl,
          clock() - entry.at + SCHEDULE_LOOKUPS_RETRY_MS,
        );
        console.warn(
          `[rail-proxy] ${feed.id} schedule pack refused: its window ended ${new Date(lookups.endsMs).toISOString()}`,
        );
      }
      return NO_LOOKUPS;
    }
    return lookups;
  }

  function reply(status, body, headers) {
    return new Response(body, { status, headers });
  }

  function noteFailure(cacheKey, reason, at) {
    const failures = (cooldown.get(cacheKey)?.failures || 0) + 1;
    const wait = nextRailBackoffMs(failures);
    cooldown.set(cacheKey, { failures, nextAttemptAt: at + wait, reason });
    return wait;
  }

  /**
   * Upstream bodies by URL, for a feed whose positions and trip updates are
   * one document (MTA's LIRR and Metro-North): `{at, promise}`, reused for
   * the asking route's own freshness window, so the operator is contacted
   * once per window rather than once per route.
   */
  const sharedUpstream = new Map();

  function sharesUpstream(feed) {
    return typeof feed.url === 'string' && feed.tripUpdatesUrl === feed.url;
  }

  /**
   * GET a registered URL and read its body, capped: `{notModified: true}`
   * for a 304 to our own validators, else `{bytes, finalUrl, etag,
   * lastModified, at}` with `at` the time it was asked for.
   */
  async function fetchUpstream(feed, url, signal, validators, at) {
    const { response, finalUrl } = await fetchRailFeed(
      feed,
      signal,
      fetchImpl,
      validators,
      { url },
    );
    if (closed) throw new Error('Rail provider closed');
    if (!isAcceptableRailUpstreamUrl(finalUrl)) {
      throw new Error('upstream is not https');
    }
    if (response.status === 304 && validators) {
      try {
        await response.body?.cancel();
      } catch {
        /* no-op */
      }
      return { notModified: true };
    }
    if (!response.ok) {
      const error = new Error(`upstream HTTP ${response.status}`);
      error.upstreamStatus = response.status;
      throw error;
    }
    const bytes = await readResponseBytesCapped(
      response,
      railMaxBodyBytes(feed),
    );
    return {
      bytes,
      finalUrl,
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
      at,
    };
  }

  /**
   * The body of a URL both of a feed's routes read: the one fetched within
   * this route's window when there is one (or under way), else a new fetch
   * the other route may reuse. Sent without validators: a 304 would leave
   * the other route, which may hold no snapshot, with nothing to read.
   */
  function sharedBody(resource, signal, at) {
    const { feed, url, ttlMs } = resource;
    const kept = sharedUpstream.get(url);
    if (kept && at - kept.at < ttlMs) return kept.promise;
    const fresh = { at, promise: fetchUpstream(feed, url, signal, null, at) };
    sharedUpstream.set(url, fresh);
    fresh.promise.catch(() => {
      if (sharedUpstream.get(url) === fresh) sharedUpstream.delete(url);
    });
    return fresh.promise;
  }

  async function refresh(resource, at) {
    const { feed, route, url, cacheKey } = resource;
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), RAIL_PROXY_TIMEOUT_MS);
    const previous = cache.get(cacheKey);
    try {
      const validators = previous
        ? { etag: previous.etag, lastModified: previous.lastModified }
        : null;
      const upstream = sharesUpstream(feed)
        ? await sharedBody(resource, controller.signal, at)
        : await fetchUpstream(feed, url, controller.signal, validators, at);
      if (closed) throw new Error('Rail provider closed');
      // Unchanged upstream: keep the snapshot, restart its freshness window,
      // and record that the operator answered. The body keeps the fetch time
      // of the payload it holds.
      if (upstream.notModified) {
        const revalidated = { ...previous, at, contactedAt: at };
        cache.set(cacheKey, revalidated);
        cooldown.delete(cacheKey);
        return revalidated;
      }
      // A shared body is read as of when it was fetched.
      const fetchedAt = upstream.at;
      const lookups = await scheduleLookupsFor(feed);
      // The pack's trip-to-route lookup, for a feed that reads routes from it.
      const routeFor = readsPackRoutes(feed)
        ? (tripId) => lookups.routes.get(tripId) ?? null
        : null;
      // A train named by its number takes the timetable trip it is on now:
      // its line and stops, never a position. A train its report says is
      // late is where its timetable was that long ago.
      const tripFor = lookups.runs
        ? (number, record) =>
            lookups.runs.activeTrip(number, fetchedAt, {
              delayMs: (liveDelaySec(record) ?? 0) * 1000,
            })?.tripId ?? null
        : null;
      const snapshot =
        route === 'updates'
          ? buildRailTripUpdatesSnapshot(feed, upstream.bytes, fetchedAt, {
              routeFor,
            })
          : buildRailSnapshot(feed, upstream.bytes, fetchedAt, {
              routeFor,
              tripFor,
            });
      assertPackRead(feed, snapshot);
      if (closed) throw new Error('Rail provider closed');
      const entry = {
        at: snapshot.fetchedAt,
        contactedAt: snapshot.fetchedAt,
        body: JSON.stringify(snapshot),
        host: new URL(upstream.finalUrl).hostname,
        etag: upstream.etag,
        lastModified: upstream.lastModified,
      };
      cache.set(cacheKey, entry);
      cooldown.delete(cacheKey);
      return entry;
    } finally {
      clearTimeout(timeout);
      controller.abort();
      controllers.delete(controller);
    }
  }

  /**
   * The feed's path or schedule pack as stored: 404 only when the reader
   * says it has none (null), 503 when it is over RAIL_PATH_PACK_MAX_BYTES (a
   * build fault to fix, not a pack that was never built) or cannot be read
   * now (the reader threw, or answered with something that is not a pack),
   * which a viewer asks again about. Both kinds share the reader contract
   * and the byte cap. Bytes from the reader go out as they are (packBody),
   * `no-cache`, with the pack's version as their ETag when the host names
   * one; an If-None-Match that names it is answered 304, unread.
   */
  async function servePack(feed, kind, incoming) {
    const read = kind === 'schedule' ? readSchedulePack : readPathPack;
    const label = kind === 'schedule' ? 'schedule pack' : 'path pack';
    const missing = () =>
      reply(
        404,
        JSON.stringify({
          error: kind === 'schedule' ? 'No rail schedule' : 'No rail paths',
          feedId: feed.id,
        }),
        JSON_NO_STORE,
      );
    const tooLarge = (detail) => {
      console.warn(`[rail-proxy] ${feed.id} ${label} refused: ${detail}`);
      return reply(
        503,
        JSON.stringify({
          error:
            kind === 'schedule'
              ? 'Rail schedule too large'
              : 'Rail paths too large',
          feedId: feed.id,
        }),
        JSON_NO_STORE,
      );
    };
    const unreadable = (detail) => {
      console.warn(`[rail-proxy] ${feed.id} ${label} unreadable: ${detail}`);
      return reply(
        503,
        JSON.stringify({
          error:
            kind === 'schedule'
              ? 'Rail schedule unreadable'
              : 'Rail paths unreadable',
          feedId: feed.id,
          retryInSec: PACK_UNREADABLE_RETRY_S,
        }),
        { ...JSON_NO_STORE, 'Retry-After': String(PACK_UNREADABLE_RETRY_S) },
      );
    };
    if (typeof read !== 'function') return missing();
    // The version is asked before the pack is read: a build landing in
    // between tags newer bytes with the older version, which the next
    // request corrects, and never the reverse.
    const version = await packVersionNow(kind, feed.id);
    const etag = typeof version === 'string' ? packEtag(version) : null;
    const packHeaders = {
      'Cache-Control': 'no-cache',
      ...(etag ? { ETag: etag } : {}),
    };
    if (etag && etagMatches(requestHeader(incoming, 'if-none-match'), etag))
      return reply(304, null, packHeaders);
    let body;
    try {
      body = await read(feed.id, {
        maxBytes: RAIL_PATH_PACK_MAX_BYTES,
      });
    } catch (error) {
      if (error?.code === 'PACK_TOO_LARGE')
        return tooLarge(error?.message || 'over the cap');
      return unreadable(error?.message || String(error));
    }
    if (body === null || body === undefined) return missing();
    // UTF-8 is at most three bytes per UTF-16 unit: only a string near the
    // cap is worth encoding to measure.
    const size =
      typeof body === 'string'
        ? body.length * 3 <= RAIL_PATH_PACK_MAX_BYTES
          ? body.length
          : new TextEncoder().encode(body).byteLength
        : body instanceof Uint8Array || body instanceof ArrayBuffer
          ? body.byteLength
          : NaN;
    if (!Number.isFinite(size)) return unreadable('not a pack');
    if (size > RAIL_PATH_PACK_MAX_BYTES) return tooLarge(`${size} bytes`);
    if (closed)
      return reply(
        503,
        JSON.stringify({ error: 'Rail provider closed' }),
        JSON_NO_STORE,
      );
    return reply(200, packBody(body), {
      'Content-Type': 'application/json; charset=utf-8',
      ...packHeaders,
    });
  }

  /** Positions or trip updates, through the cache/admission/backoff policy. */
  async function serveUpstream(resource) {
    const { feed, cacheKey, ttlMs } = resource;
    const at = clock();
    const cached = cache.get(cacheKey);
    const state = railCacheStateFor(cached, at, ttlMs);
    const ttlSeconds = Math.ceil(ttlMs / 1000);
    // A downstream cache keeps the snapshot only for what is left of its
    // window here.
    const okHeaders = (cacheState, entry) =>
      railResponseHeaders(
        cacheState,
        entry.host,
        entry.contactedAt,
        ttlMs,
        clock() - entry.at,
      );
    if (state === 'fresh')
      return reply(200, cached.body, okHeaders('HIT', cached));

    // The cached snapshot when there is one, otherwise an honest
    // "unavailable, come back in N seconds". The contact time stays as old as
    // it is: a feed served from cache during an outage has not answered.
    const answerWithoutUpstream = (reason, retryAfterS) => {
      if (state === 'stale' && cached) {
        return reply(200, cached.body, okHeaders('STALE-ERROR', cached));
      }
      return reply(
        503,
        JSON.stringify({
          error: 'Rail feed unavailable',
          feedId: feed.id,
          retryInSec: retryAfterS,
        }),
        {
          ...JSON_NO_STORE,
          'X-GEV-Cache': 'NONE',
          'Retry-After': String(retryAfterS),
          'X-Rail-Backoff': reason,
        },
      );
    };

    const waiting = cooldown.get(cacheKey);
    if (waiting && waiting.nextAttemptAt > at && !inFlight.has(cacheKey)) {
      return answerWithoutUpstream(
        'cooldown',
        Math.max(1, Math.ceil((waiting.nextAttemptAt - at) / 1000)),
      );
    }
    if (!inFlight.has(cacheKey) && !admit(cacheKey))
      return answerWithoutUpstream('rate-limited', ttlSeconds);

    const request = coalesceProxyRequest(inFlight, cacheKey, () =>
      refresh(resource, at),
    );
    try {
      const fresh = await request.promise;
      return reply(
        200,
        fresh.body,
        okHeaders(request.shared ? 'INFLIGHT' : 'MISS', fresh),
      );
    } catch (error) {
      const differential = error instanceof RailFeedShapeError;
      // A shape fault condemns the cached copy too: it was decoded as a full
      // snapshot, which the feed has just shown it is not.
      if (differential) cache.delete(cacheKey);
      if (!request.shared) {
        const reason = error?.message || String(error);
        const wait = noteFailure(cacheKey, reason, clock());
        console.warn(
          `[rail-proxy] ${cacheKey} unavailable: ${reason}; next attempt in ${Math.round(wait / 1000)}s`,
        );
      }
      if (state === 'stale' && cached && !differential) {
        return reply(200, cached.body, okHeaders('STALE-ERROR', cached));
      }
      const pending = cooldown.get(cacheKey);
      const retryAfterS = pending
        ? Math.max(1, Math.ceil((pending.nextAttemptAt - clock()) / 1000))
        : ttlSeconds;
      // The operator answered, but this server lacks the schedule pack the
      // answer is read with: unavailable here, not an upstream fault.
      const noSchedule = error?.code === 'SCHEDULE_UNAVAILABLE';
      return reply(
        noSchedule
          ? 503
          : differential ||
              error?.code === 'RESPONSE_TOO_LARGE' ||
              error?.code === 'UPSTREAM_UNREADABLE' ||
              Number.isInteger(error?.upstreamStatus)
            ? 502
            : 504,
        JSON.stringify({
          error: differential
            ? 'Rail feed is differential and is not supported'
            : noSchedule
              ? 'Rail schedule unavailable'
              : 'Rail feed unavailable',
          feedId: feed.id,
          retryInSec: retryAfterS,
        }),
        {
          ...JSON_NO_STORE,
          'X-GEV-Cache': 'NONE',
          'Retry-After': String(retryAfterS),
          ...(noSchedule ? { 'X-Rail-Backoff': 'schedule' } : {}),
        },
      );
    }
  }

  async function handle(incoming) {
    const url = new URL(incoming.url);
    if (!url.pathname.startsWith('/api/rail/'))
      return reply(
        404,
        JSON.stringify({ error: 'Unknown rail feed' }),
        JSON_NO_STORE,
      );
    if (closed)
      return reply(
        503,
        JSON.stringify({ error: 'Rail provider closed' }),
        JSON_NO_STORE,
      );
    if (incoming.method !== 'GET') {
      return reply(405, JSON.stringify({ error: 'Method Not Allowed' }), {
        ...JSON_NO_STORE,
        Allow: 'GET',
      });
    }
    const route = resolveRailRoute(
      url.pathname.slice('/api/rail'.length) + url.search,
    );
    if (!route)
      return reply(
        404,
        JSON.stringify({ error: 'Unknown rail feed' }),
        JSON_NO_STORE,
      );
    if (route.route === 'feeds') {
      // Which pack-routed feeds appear follows the packs built; a short
      // max-age lets a new build show up without a long wait.
      return reply(200, JSON.stringify({ feeds: await catalog() }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      });
    }
    if (route.route === 'paths' || route.route === 'schedule')
      return servePack(route.feed, route.route, incoming);
    const { feed } = route;
    const updates = route.route === 'updates';
    // A pack-routed feed whose pack is not built is not served: the
    // operator is not contacted for trains this server cannot name.
    if (!(await feedServable(feed)))
      return reply(
        503,
        JSON.stringify({
          error: 'Rail schedule unavailable',
          feedId: feed.id,
          retryInSec: SCHEDULE_PACK_PROBE_RETRY_S,
        }),
        {
          ...JSON_NO_STORE,
          'X-GEV-Cache': 'NONE',
          'Retry-After': String(SCHEDULE_PACK_PROBE_RETRY_S),
          'X-Rail-Backoff': 'schedule',
        },
      );
    return serveUpstream({
      feed,
      route: route.route,
      url: updates ? feed.tripUpdatesUrl : feed.url,
      cacheKey: `${route.route}:${feed.id}`,
      ttlMs: railFeedTtlMs(feed, route.route),
    });
  }

  function close() {
    closed = true;
    for (const controller of controllers) controller.abort();
    controllers.clear();
    cache.clear();
    cooldown.clear();
    scheduleLookups.clear();
    sharedUpstream.clear();
  }
  return { handle, close };
}
