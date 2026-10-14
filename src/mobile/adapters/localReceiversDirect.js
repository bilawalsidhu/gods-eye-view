import { parseTapAddress } from '../../data/tapAddress.js';
import { normalizeDump1090Aircraft } from '../../sources/adsbRecords.js';

/**
 * On-device local-receiver LAN adapter: the phone sits on the same Wi-Fi as
 * the user's dump1090/readsb/dump978 decoder and reads its `aircraft.json`
 * directly, with no proxy in the middle.
 *
 * Trust model (fail closed, enforced client-side before any fetch):
 *
 * - Every feed URL must be `http(s)`, carry no credentials/query/fragment,
 *   and live under a path ending in `aircraft.json`.
 * - Every feed host must pass the shared tap rule
 *   (`src/data/tapAddress.js`): loopback, RFC1918, `localhost`, `*.local`.
 * - Task 2's registry leaves `localReceivers` empty on purpose, so the
 *   device transport must be built with {@link buildLocalReceiverRegistry}
 *   (explicit override of exactly the validated hosts) — without it every
 *   read refuses, by design.
 *
 * Records reuse `normalizeDump1090Aircraft`, so the renderer cannot tell
 * whether a feed came through the server route or this adapter.
 *
 * @module mobile/adapters/localReceiversDirect
 */

/** Decoder bands, matching the server route's feed contract. */
export const LOCAL_RECEIVER_BANDS = Object.freeze(['1090', '978']);

/** A feed whose own `now` is older than this reports stale. */
export const LOCAL_RECEIVER_STALE_MS = 10_000;

/** At most this many feeds are read (mirrors the server route). */
export const LOCAL_RECEIVER_MAX_FEEDS = 8;

function defaultPort(protocol) {
  return protocol === 'https:' ? 443 : 80;
}

/**
 * Validate one `{ band, url }` feed descriptor without fetching anything.
 * @param {*} feed Candidate descriptor.
 * @returns {{ band: string, label: string, url: string }|{ band: string|null, label: string, reason: string }}
 *   Valid feed or an invalid marker (never fetched).
 */
export function validateLocalReceiverFeed(feed) {
  const band = feed?.band;
  const rawUrl = String(feed?.url ?? '').trim();
  const label = LOCAL_RECEIVER_BANDS.includes(band)
    ? band === '1090'
      ? '1090 MHz'
      : '978 MHz UAT'
    : 'unknown band';
  if (!LOCAL_RECEIVER_BANDS.includes(band)) {
    return { band: null, label, reason: 'band must be 1090 or 978' };
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { band, label, reason: 'not a valid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { band, label, reason: 'scheme must be http or https' };
  }
  if (url.username || url.password) {
    return { band, label, reason: 'credentials are not allowed in the URL' };
  }
  if (url.search || url.hash) {
    return { band, label, reason: 'query and fragment are not allowed' };
  }
  const port = url.port ? Number(url.port) : defaultPort(url.protocol);
  const address = parseTapAddress(`${url.hostname}:${port}`);
  if (!address) {
    return {
      band,
      label,
      reason: 'host must be loopback, RFC1918, localhost or *.local',
    };
  }
  if (!/(?:^|\/)aircraft\.json$/.test(url.pathname)) {
    return { band, label, reason: 'path must end in aircraft.json' };
  }
  return {
    band,
    label,
    url: `${url.protocol}//${address.host}:${address.port}${url.pathname}`,
  };
}

/**
 * Build the explicit `createNativeFetch({ registry })` override for
 * validated feeds. Task 2's `localReceivers` entry is intentionally empty;
 * pass this (merged over `FAMILY_HOSTS`) so the transport admits exactly
 * the LAN hosts the adapter validated — everything else still refuses.
 * @param {Array<{ band: string, url: string }>} feeds Feed descriptors.
 * @returns {{ localReceivers: { hosts: string[], paths: RegExp[] } }} Registry override.
 */
export function buildLocalReceiverRegistry(feeds) {
  const hosts = [];
  for (const feed of Array.isArray(feeds) ? feeds : []) {
    const validated = validateLocalReceiverFeed(feed);
    if (!validated.url) continue;
    const hostname = new URL(validated.url).hostname.toLowerCase();
    if (!hosts.includes(hostname)) hosts.push(hostname);
  }
  return {
    localReceivers: { hosts, paths: [/(?:^|\/)aircraft\.json$/] },
  };
}

/**
 * Create the on-device local-receiver source over caller-configured feeds.
 * @param {{ fetchImpl?: Function, feeds?: Array, now?: Function }} options Transport, feed descriptors, clock.
 * @returns {{ feeds: Array, getSnapshot: Function }} Feed list + snapshot reader.
 */
export function createLocalReceiverDirectSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  feeds = [],
  now = () => Date.now(),
} = {}) {
  const descriptors = (Array.isArray(feeds) ? feeds : [])
    .slice(0, LOCAL_RECEIVER_MAX_FEEDS)
    .map((feed, index) => ({
      id: `feed-${index + 1}`,
      ...validateLocalReceiverFeed(feed),
    }));

  /**
   * Read one feed document into a status + records pair.
   */
  async function readFeed(feed, signal) {
    const summary = { band: feed.band, label: feed.label };
    if (!feed.url) {
      return {
        status: { ...summary, status: 'invalid', aircraft: 0, ageMs: null },
        records: [],
      };
    }
    signal?.throwIfAborted();
    let response;
    try {
      response = await fetchImpl(feed.url, {
        signal,
        headers: { Accept: 'application/json' },
      });
    } catch {
      signal?.throwIfAborted();
      return {
        status: { ...summary, status: 'unreachable', aircraft: 0, ageMs: null },
        records: [],
      };
    }
    signal?.throwIfAborted();
    if (!response.ok) {
      return {
        status: { ...summary, status: 'unreachable', aircraft: 0, ageMs: null },
        records: [],
      };
    }
    let json;
    try {
      json = await response.json();
    } catch {
      return {
        status: { ...summary, status: 'unreachable', aircraft: 0, ageMs: null },
        records: [],
      };
    }
    signal?.throwIfAborted();
    if (!json || typeof json !== 'object' || !Array.isArray(json.aircraft)) {
      return {
        status: { ...summary, status: 'unreachable', aircraft: 0, ageMs: null },
        records: [],
      };
    }
    const receivedAt = now();
    const feedNowS = Number(json.now);
    const ageMs = Number.isFinite(feedNowS)
      ? Math.max(0, Math.round(receivedAt - feedNowS * 1000))
      : 0;
    const status = ageMs > LOCAL_RECEIVER_STALE_MS ? 'stale' : 'live';
    const records = normalizeDump1090Aircraft(json, receivedAt - ageMs, {
      band: feed.band,
    });
    return {
      status: { ...summary, status, aircraft: records.length, ageMs },
      records,
    };
  }

  return {
    /** Validated feed descriptors (invalid ones carry `reason`). */
    feeds: descriptors.map((feed) => ({ ...feed })),
    /**
     * Snapshot every configured feed.
     * @param {{ signal?: AbortSignal }} options Caller signal.
     * @returns {Promise<{ configured: boolean, generatedAt: number, feeds: object[], records: object[] }>}
     */
    async getSnapshot({ signal } = {}) {
      if (!descriptors.length) {
        return {
          configured: false,
          generatedAt: now(),
          feeds: [],
          records: [],
        };
      }
      const results = [];
      for (const feed of descriptors) {
        results.push(await readFeed(feed, signal));
      }
      signal?.throwIfAborted();
      return {
        configured: true,
        generatedAt: now(),
        feeds: results.map((result) => result.status),
        records: results.flatMap((result) => result.records),
      };
    },
  };
}
