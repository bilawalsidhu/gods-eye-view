import { PbfReader } from 'pbf';
import {
  decodeFeedMessage,
  normalizeVehicleEntity,
  decodeVehiclePositions,
  GTFS_INCREMENTALITY_FULL_DATASET,
  GTFS_MAX_ENTITIES,
  GTFS_MAX_STRING_CHARS,
  isPlausibleVehiclePosition,
} from '../../data/gtfsRealtime.js';
import { repairVehicleTimestamps } from '../../data/transitProxy.js';
import { TRANSIT_FEED_REGISTRY } from '../../data/transitFeeds.js';
import {
  UPSTREAM_NOT_ALLOWED,
  createPacer,
  isUpstreamRefusal,
} from '../sourcePolicy.js';

/**
 * On-device transit: GTFS-Realtime VehiclePositions via direct fetch + pbf decode.
 *
 * Mirrors the server's `src/data/transitProxy.js` `buildTransitSnapshot` and
 * `src/data/gtfsRealtime.js` decode logic. The browser names a registered feed id
 * (from `TRANSIT_FEED_REGISTRY`), never a raw URL.
 *
 * @module mobile/adapters/transitDirect
 */

/** Transit registry: id → feed entry (subset of server registry). */
const TRANSIT_FEEDS = new Map(TRANSIT_FEED_REGISTRY.map((f) => [f.id, f]));

/** Default courtesy pacer (one request per 15 s per feed). */
const DEFAULT_MIN_INTERVAL_MS = 15_000;

/**
 * Create the on-device transit direct source.
 * @param {{ fetchImpl?: Function, pacer?: { wait: Function }, registry?: Map<string, object> }} options
 * @returns {{ getSnapshot: Function, getFeed: Function }}
 */
export function createTransitDirectSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  pacer = createPacer(DEFAULT_MIN_INTERVAL_MS),
  registry = TRANSIT_FEEDS,
} = {}) {
  const inFlight = new Map();

  /**
   * Fetch and decode a registered feed.
   * @param {string} feedId Registered feed id.
   * @param {{ signal?: AbortSignal }} options
   * @returns {Promise<object>} Snapshot: { feedId, name, fetchedAt, feedTimestamp, version, entityCount, truncated, count, vehicles }
   */
  async function getSnapshot(feedId, { signal } = {}) {
    const feed = registry.get(feedId);
    if (!feed) throw new Error(`Unknown transit feed: ${feedId}`);

    // Single-flight per feed
    const key = feedId;
    let inflight = inFlight.get(key);
    if (!inflight) {
      inflight = (async () => {
        try {
          await pacer.wait({ signal });
          signal?.throwIfAborted();

          const response = await fetchImpl(feed.url, {
            signal,
            headers: {
              Accept:
                'application/x-protobuf, application/octet-stream;q=0.9, */*;q=0.1',
              'Accept-Encoding': 'gzip',
              ...(feed.headers || {}),
            },
            redirect: 'manual',
          });

          if (!response.ok) {
            throw new Error(`Transit upstream HTTP ${response.status}`);
          }

          const bytes = await readResponseBytesCapped(
            response,
            8 * 1024 * 1024,
            signal,
          );
          signal?.throwIfAborted();

          const snapshot = buildTransitSnapshot(feed, bytes, Date.now());
          return snapshot;
        } catch (error) {
          if (isUpstreamRefusal(error)) {
            return { unavailable: UPSTREAM_NOT_ALLOWED };
          }
          throw error;
        } finally {
          inFlight.delete(key);
        }
      })();
      inFlight.set(key, inflight);
    }

    return inflight;
  }

  /**
   * Get the public catalog of enabled feeds.
   * @returns {Promise<object[]>}
   */
  async function getFeedCatalog() {
    return Array.from(registry.values()).map((f) => ({
      id: f.id,
      name: f.name,
      operator: f.operator,
      region: f.region,
      center: f.center,
      loadRadiusKm: f.loadRadiusKm,
      license: f.license,
      licenseUrl: f.licenseUrl,
      attribution: f.attribution,
      historyRetention: f.historyRetention === true,
    }));
  }

  return { getSnapshot, getFeedCatalog };
}

/**
 * Read response body with a hard byte cap (mirrors server's readResponseBytesCapped).
 * @param {Response} response
 * @param {number} maxBytes
 * @param {AbortSignal} [signal]
 * @returns {Promise<Uint8Array>}
 */
async function readResponseBytesCapped(response, maxBytes, signal) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error('Response too large');
  }
  if (!response.body) return new Uint8Array(0);
  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('Response too large');
      }
      chunks.push(value);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Build transit snapshot from decoded feed (mirrors server's buildTransitSnapshot).
 * @param {object} feed Registry entry
 * @param {Uint8Array|ArrayBuffer} bytes Raw GTFS-RT FeedMessage
 * @param {number} now Fetch time (ms epoch)
 * @returns {object} Snapshot
 */
function buildTransitSnapshot(feed, bytes, now = Date.now()) {
  const decoded = decodeVehiclePositions(bytes);
  if (decoded.incrementality !== GTFS_INCREMENTALITY_FULL_DATASET) {
    throw new Error(
      `feed is differential (incrementality ${decoded.incrementality})`,
    );
  }
  return {
    feedId: feed.id,
    name: feed.name,
    fetchedAt: now,
    feedTimestamp: decoded.timestamp,
    version: decoded.version,
    entityCount: decoded.entityCount,
    truncated: decoded.truncated,
    count: decoded.vehicles.length,
    vehicles: repairVehicleTimestamps(
      decoded.vehicles,
      decoded.timestamp,
      Math.floor(now / 1000),
    ),
  };
}
