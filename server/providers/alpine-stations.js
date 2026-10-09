/**
 * Alpine automatic weather stations — a bounded relay for three keyless,
 * openly licensed national networks.
 *
 * It exists because none of the three upstreams can be called from the browser
 * and each needs more than one round trip to be useful:
 *
 *   SLF IMIS     measurement-api.slf.ch sends no CORS headers at all, and the
 *                measurements endpoint returns the whole network's rolling
 *                window (~9,500 rows, ~3 MB) for ~200 current readings.
 *   SwissMetNet  identity and readings live in two different files, one of
 *                which is ISO-8859-1.
 *   TAWES        observations require an explicit station id list, which only
 *                the metadata response can supply.
 *
 * Doing that work here means the client receives ~650 ready-to-render records
 * instead of four megabytes it would have to join itself.
 *
 * One network being down must never blank the layer, so the three are acquired
 * independently and the response reports each one's state. A visitor in the
 * Austrian Alps keeps a map when a Swiss research API is in maintenance.
 */

import {
  ALPINE_NETWORKS,
  alpineAttribution,
} from '../../src/layers/alpineStations/networks.js';
import { mergeNetworkStations } from '../../src/layers/alpineStations/records.js';
import { coalesceProxyRequest } from './common/http.js';
import { clientKey, makeRateLimiter } from './common/rate-limit.js';
import {
  fetchSlfStations,
  fetchSmnStations,
  fetchTawesStations,
  createUpstreamReader,
} from './alpine-stations/fetchers.js';
import {
  MAX_SERVE_STALE_MS,
  METADATA_CACHE_MS,
  OBSERVATION_CACHE_MS,
  UPSTREAM_TIMEOUT_MS,
} from './alpine-stations/upstreams.js';

/** Reject as soon as the caller goes away, without disturbing `promise`. */
function raceAbort(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('cancelled'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

/** The fetch step for each registered network. */
const FETCHERS = Object.freeze({
  'slf-imis': fetchSlfStations,
  'meteoswiss-smn': fetchSmnStations,
  'geosphere-tawes': fetchTawesStations,
});

/** Wait before retrying a network that just failed, so a dead host is not hammered. */
export const RETRY_AFTER_FAILURE_MS = 60_000;

export const ALPINE_STATIONS_ROUTE = '/api/alpine-stations';

/**
 * Relay the Alpine station networks on a fixed, bounded, cached route.
 *
 * `fetchImpl` and `now` are injected so the whole thing is testable without a
 * socket or a clock.
 */
export function alpineStationsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  timeoutMs = UPSTREAM_TIMEOUT_MS,
} = {}) {
  const reader = createUpstreamReader({ fetchImpl, timeoutMs });
  const caches = new Map();
  const metadata = new Map();
  const failures = new Map();
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 1200 });

  /**
   * Hold a network's identity payload for a day while its readings refresh
   * every few minutes. The loader runs only when the entry has expired, so a
   * metadata outage cannot stop readings from being served.
   */
  function metadataReader(networkId) {
    return async (load) => {
      const held = metadata.get(networkId);
      if (held && now() - held.at < METADATA_CACHE_MS) return held.value;
      try {
        const value = await load();
        metadata.set(networkId, { value, at: now() });
        return value;
      } catch (error) {
        if (held) return held.value;
        throw error;
      }
    };
  }

  async function refresh(networkId, signal) {
    const records = await FETCHERS[networkId](reader, signal, {
      readMetadata: metadataReader(networkId),
    });
    signal.throwIfAborted();
    const entry = { records, fetchedAt: now() };
    caches.set(networkId, entry);
    return entry;
  }

  /**
   * One network's records, fresh or from cache.
   *
   * At most one refresh per network is ever in flight: concurrent callers share
   * it through `coalesceProxyRequest`, and a failure starts a cooldown so a
   * burst of requests cannot turn one dead upstream into a request storm.
   */
  async function acquire(networkId, signal) {
    const held = caches.get(networkId);
    if (held && now() - held.fetchedAt < OBSERVATION_CACHE_MS)
      return { ...held, stale: false };
    // Both the cooldown and the failure path serve the last payload, and BOTH
    // have to stop at the same ceiling. Checking it in only one of them made a
    // long-dead upstream alternate, once a minute, between reporting itself
    // unavailable and serving readings days old.
    const servable = held && now() - held.fetchedAt <= MAX_SERVE_STALE_MS;
    const failedAt = failures.get(networkId) ?? -Infinity;
    if (now() - failedAt < RETRY_AFTER_FAILURE_MS) {
      if (servable) return { ...held, stale: true };
      throw new Error('alpine_retry_later');
    }
    // One refresh per network at a time; concurrent callers share this promise
    // rather than each opening their own copy of a three-megabyte read.
    const shared = coalesceProxyRequest(inFlight, networkId, () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      return refresh(networkId, controller.signal).finally(() =>
        clearTimeout(timer),
      );
    });
    try {
      // A caller going away must not cancel a refresh the others are waiting
      // on, so the request signal races the shared promise instead of aborting it.
      return { ...(await raceAbort(shared.promise, signal)), stale: false };
    } catch (error) {
      if (!signal.aborted) failures.set(networkId, now());
      if (servable) return { ...held, stale: true };
      throw error;
    }
  }

  /** Acquire every network independently and describe the result honestly. */
  async function acquireAll(signal) {
    const settled = await Promise.allSettled(
      ALPINE_NETWORKS.map(async (network) => ({
        network,
        ...(await acquire(network.id, signal)),
      })),
    );
    const groups = [];
    const networks = [];
    let newestFetch = null;
    for (const [index, result] of settled.entries()) {
      const network = ALPINE_NETWORKS[index];
      const state = {
        id: network.id,
        label: network.label,
        name: network.name,
        country: network.country,
        attribution: network.attribution,
        licence: network.licence,
        licenceUrl: network.licenceUrl,
        homepage: network.homepage,
        parameters: [...network.parameters],
        cadenceMinutes: network.cadenceMinutes,
      };
      if (result.status === 'fulfilled') {
        groups.push(result.value.records);
        networks.push({
          ...state,
          status: result.value.stale ? 'stale' : 'ok',
          fetchedAt: new Date(result.value.fetchedAt).toISOString(),
          stationCount: result.value.records.length,
        });
        if (newestFetch === null || result.value.fetchedAt > newestFetch)
          newestFetch = result.value.fetchedAt;
      } else {
        networks.push({
          ...state,
          status: 'unavailable',
          fetchedAt: null,
          stationCount: 0,
        });
      }
    }
    const stations = mergeNetworkStations(groups);
    const present = networks
      .filter((network) => network.status !== 'unavailable')
      .map((network) => network.id);
    const unavailable = present.length === 0;
    return {
      schemaVersion: 1,
      stations,
      networks,
      attribution: alpineAttribution(present),
      fetchedAt:
        newestFetch === null ? null : new Date(newestFetch).toISOString(),
      stale: networks.some((network) => network.status === 'stale'),
      unavailable,
      reason: unavailable
        ? 'No Alpine station network is reachable'
        : present.length < networks.length
          ? `${networks.length - present.length} of ${networks.length} networks unavailable`
          : null,
    };
  }

  async function handler(req, res) {
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once?.('close', close);
    const json = (status, value) => {
      if (controller.signal.aborted || res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.method !== 'GET')
        return json(405, { error: 'method_not_allowed' });
      if ((req.url || '/').split('?')[0] !== '/' && req.url !== '')
        return json(404, { error: 'unknown_route' });
      if (allow && !allow(clientKey(req)))
        return json(429, { error: 'rate_limited' });
      json(200, await acquireAll(controller.signal));
    } catch (error) {
      // Never relay an upstream's own wording, and never fail the layer with a
      // status it would treat as fatal: the envelope already says what is
      // unavailable and why.
      json(error?.status === 429 ? 429 : 200, {
        schemaVersion: 1,
        stations: [],
        networks: [],
        attribution: '',
        fetchedAt: null,
        stale: false,
        unavailable: true,
        reason: 'Alpine station networks unavailable',
      });
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name: 'alpine-stations',
    configureServer({ middlewares }) {
      middlewares.use(ALPINE_STATIONS_ROUTE, handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use(ALPINE_STATIONS_ROUTE, handler);
    },
  };
}
