import {
  ACTIVATION_ALTITUDE_M,
  FEED_STALE_AFTER_MS,
  aggregateTransitFeedHealth,
  transitDetectionClass,
  transitDetectionId,
  transitDetectionMetric,
} from './policy.js';
import {
  TRANSIT_ENABLED_FEEDS,
  getRegisteredTransitFeed,
} from '../../data/transitFeeds.js';
import { transitModeTier } from '../../data/transitPresetStyle.js';

/**
 * The registry entry behind a vehicle. Live feeds answer first so a feed the
 * session disabled stops supplying vocabulary; the registry is the fallback,
 * because a vehicle can outlive the poll that brought it.
 * @param {object} state Layer state.
 * @param {object} entry Vehicle entry.
 * @returns {object|null}
 */
function feedForEntry(state, entry) {
  const id = entry?.feedId;
  if (!id) return null;
  return state._activeFeeds.get(id) || getRegisteredTransitFeed(id) || null;
}

/**
 * The layer row's answer to "what is on screen and is it honest?".
 * @param {object} context
 * @returns {object}
 */
export function createQueries({ state, parts }) {
  const empty = [];
  const defaults = {};
  let requestedMax = Infinity,
    requestedSeed = 0;
  /**
   * A stable 32-bit hash of a vehicle key, mixed with the caller's seed.
   *
   * Selection has to survive ordinary churn. Striding by position in the map
   * meant that one bus leaving at the front renumbered every bus behind it, so
   * a single removal swapped the whole labelled set for its neighbours —
   * visible as every callout jumping one vehicle sideways. A hash of the key
   * belongs to the vehicle, not to its place in a list, so a removal anywhere
   * leaves every other vehicle's standing untouched.
   *
   * @param {string} key
   * @param {number} seed
   * @returns {number} Unsigned 32-bit.
   */
  function selectionRank(key, seed) {
    // FNV-1a, seeded. Cheap, no allocation, and well spread for short ids.
    let hash = (2166136261 ^ seed) >>> 0;
    for (let i = 0; i < key.length; i += 1) {
      hash ^= key.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash >>> 0;
  }

  /**
   * The vehicles the detection overlay may box and label this frame.
   *
   * Detection PULLS this on every paint, not only on label solves, so it must
   * not be a fleet scan: the answer is CACHED and rebuilt only when something
   * that could change it has happened — a poll, a visibility sweep, a
   * removal, a selection — which the rest of the layer signals by bumping
   * `state._detectRevision`. Between those, every paint gets the same array
   * back. Positions inside it are the markers' own Cartesians, which the frame
   * pass writes in place, so they are live without a copy; only the motion
   * word is re-read per paint, and only for the entries actually handed over.
   *
   * Two older rules stand. Visibility is applied FIRST: sampling the whole
   * fleet and then discarding the hidden ones meant a single visible bus in a
   * fleet of five thousand could fall outside the sample and go unlabelled
   * while the overlay had thousands of slots free. And selection among the
   * visible is by hash, not by position, so the labelled set is stable as
   * vehicles come and go. The selected vehicle is handed over with
   * `skipLabel` — it has its own fuller card.
   *
   * @param {{maxCount?: number, seed?: number}} [options]
   * @returns {Array<object>}
   */
  function collectDetectableVehicles(options = defaults) {
    if (!state._enabled || !state._markers?.show) return empty;
    if (state._vehicles.size === 0) return empty;
    const maxCount = Number.isFinite(options.maxCount)
      ? Math.max(1, Math.floor(options.maxCount))
      : Infinity;
    const seed = Number.isFinite(options.seed) ? Math.floor(options.seed) : 0;

    requestedMax = maxCount;
    requestedSeed = seed;
    if (!state._detectCache) refreshDetectCache();
    return state._detectCache?.contacts || empty;
  }
  function refreshDetectCache() {
    if (!state._enabled) return;
    const cache = state._detectCache;
    const now = Date.now();
    const maxCount = requestedMax,
      seed = requestedSeed;
    if (now - state._detectBuiltAt < 250) return;
    state._detectBuiltAt = now;
    if (
      cache &&
      cache.revision === state._detectRevision &&
      cache.maxCount === maxCount &&
      cache.seed === seed
    ) {
      for (const contact of cache.contacts)
        contact.metric = transitDetectionMetric(
          contact._entry,
          contact._entry.mode,
          now,
          feedForEntry(state, contact._entry),
        );
      return;
    }
    if (cache)
      for (const contact of cache.contacts) contact._entry.detectContact = null;
    const visible = [];
    for (const entry of state._visible) {
      const marker = entry.marker;
      if (!marker?.position || marker.show === false) continue;
      visible.push(entry);
    }
    let chosen = visible;
    if (visible.length > maxCount) {
      // Take the lowest-ranked keys. Removing an unselected vehicle cannot
      // change this set at all, and removing a selected one promotes exactly
      // one replacement instead of reshuffling everybody.
      chosen = visible
        .map((entry) => ({ entry, rank: selectionRank(entry.key, seed) }))
        .sort((a, b) => a.rank - b.rank || (a.entry.key < b.entry.key ? -1 : 1))
        .slice(0, maxCount)
        .map((scored) => scored.entry);
    }
    const contacts = [];
    for (const entry of chosen) {
      // Route and operator text change with the record and the mode, both of
      // which arrive on polls — the same events that rebuild this list.
      if (!entry.labelId || entry.labelRecord !== entry.record) {
        entry.labelId = transitDetectionId(
          entry.record,
          feedForEntry(state, entry),
        );
        entry.labelRecord = entry.record;
      }
      if (!entry.labelClass || entry.labelMode !== entry.mode) {
        entry.labelClass = transitDetectionClass(
          entry.mode,
          feedForEntry(state, entry),
        );
        entry.labelMode = entry.mode;
      }
      const contact = {
        position: entry.marker.position,
        bracketHalfWidth: Math.ceil(entry.marker.width / 2) + 2,
        bracketHalfHeight: Math.ceil(entry.marker.height / 2) + 2,
        sourceId: entry.key,
        id: entry.labelId,
        type: 'VEH',
        klass: entry.labelClass,
        metric: transitDetectionMetric(
          entry,
          entry.mode,
          now,
          feedForEntry(state, entry),
        ),
        // The bracket carries the mode colour in every preset: the detection
        // canvas sits above the post-FX chain, where the sprites' own colour
        // is lost under NVG and FLIR. Keyless too — the feeds are keyless.
        tier: transitModeTier(entry.mode),
        skipLabel: entry.key === state._selectedKey,
        _entry: entry,
      };
      entry.detectContact = contact;
      contacts.push(contact);
    }
    state._detectCache = {
      revision: state._detectRevision,
      maxCount,
      seed,
      contacts,
    };
    return contacts;
  }

  const methods = {
    /**
     * Detection contract: buses, trams and trains are contacts like any other.
     * @param {{maxCount?: number, seed?: number}} [options]
     * @returns {Array<object>}
     */
    getDetectableObjects(options = defaults) {
      return collectDetectableVehicles(options);
    },

    getStats() {
      const active = [...state._activeFeeds.values()];
      const statuses = active.map((feed) =>
        parts.ingestion.feedStatus(feed.id),
      );
      const now = Date.now();
      const health = aggregateTransitFeedHealth(statuses, now);
      const count = state._vehicles.size;
      if (state._enabled && active.length === 0) {
        return {
          count: 0,
          lastUpdate: state._lastUpdate,
          error: null,
          source: 'GTFS-RT',
          status: 'zoom-in',
          coverage: state._altitudeGateOpen
            ? `No feed here yet · ${TRANSIT_ENABLED_FEEDS.length} regions available`
            : `Fly below ${Math.round(ACTIVATION_ALTITUDE_M / 1000).toLocaleString()} km to a covered region`,
        };
      }
      // Age is shown by the same rule the row state uses, so the text and the
      // chip can never disagree about which feed has gone quiet.
      const coverage = active
        .map((feed) => {
          const status = parts.ingestion.feedStatus(feed.id);
          const quiet =
            status.stale === true ||
            (Number.isFinite(status.upstreamAt) &&
              now - status.upstreamAt > FEED_STALE_AFTER_MS);
          const aged =
            quiet && Number.isFinite(status.upstreamAt)
              ? ` (${Math.round((now - status.upstreamAt) / 1000)}s old)`
              : '';
          return `${feed.name} ${status.count}${aged}`;
        })
        .join(' · ');
      return {
        count,
        lastUpdate: state._lastUpdate,
        error: count === 0 ? health.error : null,
        ...(count === 0 && Number.isFinite(health.retryInSec)
          ? { retryInSec: health.retryInSec }
          : {}),
        degraded: count > 0 && health.degraded,
        loading: health.loading && count === 0,
        loadingLabel:
          health.loading && count === 0
            ? `Loading ${active.map((feed) => feed.name).join(', ')}`
            : undefined,
        stale: health.stale,
        source: 'GTFS-RT',
        coverage,
        feeds: active.map((feed) => feed.id),
      };
    },
  };

  return { methods, refreshDetectCache };
}
