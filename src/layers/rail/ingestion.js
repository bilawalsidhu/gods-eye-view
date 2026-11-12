import {
  FIX_FLAGS,
  createLagReservoir,
  destroyTrack,
  readFix,
} from '../../data/contactPlayback.js';
import { createRailPathPack } from '../../data/railPaths.js';
import {
  initializePlayback,
  recordFix,
  syncPlayback,
  updatePlayback,
} from '../transit/movement.js';
import {
  FEED_EVICT_AFTER_MS,
  FEED_STALE_AFTER_MS,
  FUTURE_STAMP_TOLERANCE_MS,
  MAX_TRAINS_TOTAL,
  MISSED_POLLS_TO_DROP,
  isLiveRailPositionSource,
  isStaleTrainFix,
  playbackModeFor,
  railTrainKey,
  trainReportTimeMs,
} from './policy.js';
import { bindTrainPath, followFix, rebindTrainPath } from './pathBinding.js';
import { scheduleRetryDelayMs } from './schedules.js';
import { createDuplicateFilter } from './dedupe.js';

/**
 * Fetching rail feeds through the proxy and turning snapshots into trains.
 * The aging rules are the Transit layer's: a train is drawn from its own
 * report time, a feed is judged by when its operator last answered, and both
 * a quiet train and a quiet feed end in removal rather than a frozen marker.
 *
 * Only live positions are drawn (isLiveRailPositionSource). A feed whose
 * positions fail is shown as unavailable: its trains are never placed from
 * its timetable, and those already drawn age out as any quiet train does.
 * @param {object} context
 * @returns {object}
 */
export function createIngestion({ state, services, parts, source }) {
  const { governorRequestRender } = services.render;
  const { registerDynamicCredit, railFeedCredit } = services.credits;
  // One physical train in several loaded feeds is drawn once (dedupe.js).
  const duplicates = createDuplicateFilter({ state, parts });

  function feedStatus(feedId) {
    let status = state._feedStatus.get(feedId);
    if (!status) {
      status = {
        count: 0,
        lastUpdate: null,
        upstreamAt: null,
        error: null,
        retryInSec: null,
        stale: false,
        pollSeq: 0,
        loading: false,
        lag: null,
        /** New trains its last poll listed that MAX_TRAINS_TOTAL left out. */
        capped: 0,
      };
      state._feedStatus.set(feedId, status);
    }
    return status;
  }

  function removeTrain(key) {
    const entry = state._trains.get(key);
    if (!entry) return;
    if (state._selectedKey === key) parts.selection.clearSelection();
    if (entry.marker) state._markers?.remove(entry.marker);
    entry.marker = null;
    state._moving.delete(entry);
    parts.rendering.cancelWake(entry);
    destroyTrack(entry.track);
    state._trains.delete(key);
    state._revision += 1;
    // A copy it hid may now be the one to draw.
    duplicates.scheduleRefresh();
  }

  /**
   * Remove a feed's trains, except `keepKey` when given (the selected train,
   * whose feed is held for it alone: viewport.js).
   * @param {string} feedId
   * @param {string|null} [keepKey]
   */
  function removeFeedTrains(feedId, keepKey = null) {
    for (const [key, entry] of state._trains) {
      if (entry.feedId === feedId && key !== keepKey) removeTrain(key);
    }
  }

  /**
   * Drop trains whose report aged out and feeds whose operator went quiet.
   * @param {number} nowMs
   * @returns {number} Trains removed.
   */
  function sweepAgedTrains(nowMs) {
    let removed = 0;
    const deadFeeds = new Set();
    for (const [feedId, status] of state._feedStatus) {
      if (
        Number.isFinite(status.upstreamAt) &&
        nowMs - status.upstreamAt > FEED_EVICT_AFTER_MS
      )
        deadFeeds.add(feedId);
    }
    for (const [key, entry] of state._trains) {
      if (
        deadFeeds.has(entry.feedId) ||
        isStaleTrainFix(entry.record, nowMs, entry.fetchedAt)
      ) {
        removeTrain(key);
        removed += 1;
      }
    }
    for (const feedId of deadFeeds) {
      const status = state._feedStatus.get(feedId);
      if (status) {
        status.count = 0;
        status.stale = true;
      }
    }
    if (removed > 0) {
      parts.rendering.syncRenderHold();
      governorRequestRender('rail-evict');
      state._dataManager?.refreshLayerStats?.();
    }
    return removed;
  }

  /**
   * Fetch a feed's path pack once. A 404 means the feed has no paths and its
   * trains keep straight-line motion; any other failure (a 503 from a pack
   * the server cannot read now, say) is retried on the schedule packs'
   * stepped delay, 30 s doubling to ten minutes (scheduleRetryDelayMs).
   * @param {object} feed Registry entry.
   */
  function ensurePaths(feed) {
    const known = state._pathPacks.get(feed.id);
    if (known && !(known.status === 'none' && Date.now() >= known.retryAt))
      return;
    if (typeof source.requestPaths !== 'function') {
      state._pathPacks.set(feed.id, {
        status: 'none',
        pack: null,
        retryAt: Infinity,
      });
      return;
    }
    const slot = {
      status: 'loading',
      pack: null,
      retryAt: Infinity,
      /** Failed loads in a row. */
      failures: known?.failures ?? 0,
    };
    state._pathPacks.set(feed.id, slot);
    void (async () => {
      try {
        const response = await source.requestPaths(feed.id);
        if (!response.ok) {
          const error = new Error(`rail paths HTTP ${response.status}`);
          error.status = response.status;
          throw error;
        }
        const raw = await response.json();
        const pack = createRailPathPack(raw);
        if (pack.feedId !== feed.id)
          throw new Error('rail path pack is for another feed');
        if (state._pathPacks.get(feed.id) !== slot) return;
        slot.pack = pack;
        slot.status = 'ready';
        bindFeedTrains(feed.id);
        // The faint network is drawn from the same pack, built once here.
        parts.routes.buildNetwork(feed.id, raw);
      } catch (error) {
        slot.status = 'none';
        slot.failures += 1;
        slot.retryAt =
          error?.status === 404
            ? Infinity
            : Date.now() + scheduleRetryDelayMs(slot.failures);
        if (error?.status !== 404)
          console.warn(
            `[Data:Rail] ${feed.id} paths unavailable:`,
            error?.message || error,
          );
      }
    })();
  }

  /**
   * Keep a train on its railway line: bind it when its trip or route changes,
   * follow each new report, and move it to another of its route's shapes (or
   * back to straight lines) when a report lands off the bound one.
   */
  function followPath(entry, record, fix) {
    const pack = state._pathPacks.get(entry.feedId)?.pack;
    if (!pack) return;
    const ids = { tripId: record.tripId || '', routeId: record.routeId || '' };
    const key = `${ids.tripId}\n${ids.routeId}`;
    if (entry.pathKey !== key) {
      entry.pathKey = key;
      entry.path = bindTrainPath(pack, ids, fix);
      return;
    }
    if (!entry.path || followFix(entry.path, fix)) return;
    entry.path = rebindTrainPath(pack, ids, entry.path, fix);
  }

  /** Bind the trains a feed already shows once its pack arrives. */
  function bindFeedTrains(feedId) {
    const newest = {};
    for (const entry of state._trains.values()) {
      if (entry.feedId !== feedId || entry.pathKey !== undefined) continue;
      if (!entry.track?.count) continue;
      readFix(entry.track, entry.track.count - 1, newest);
      followPath(entry, entry.record, newest);
      parts.rendering.schedulePlayback(entry);
    }
    governorRequestRender('rail-paths');
  }

  /** A playback fix for one record, with the time it was really reported. */
  function fixFor(record, fetchedAt) {
    const stamped = trainReportTimeMs(record, fetchedAt);
    const reportAt =
      stamped > fetchedAt + FUTURE_STAMP_TOLERANCE_MS ? fetchedAt : stamped;
    return {
      t: reportAt,
      lat: record.lat,
      lon: record.lon,
      bearingDeg: Number.isFinite(record.bearing) ? record.bearing : NaN,
      flags:
        stamped !== reportAt
          ? FIX_FLAGS.RECEIPT_TIME
          : record.timestampSource === 'vehicle'
            ? FIX_FLAGS.VEHICLE_TIME
            : record.timestampSource === 'header'
              ? FIX_FLAGS.FEED_TIME
              : FIX_FLAGS.RECEIPT_TIME,
    };
  }

  /** Record a new report for a train already drawn. */
  function advanceTrain(entry, record, fix, observation) {
    const heard = recordFix(entry, fix, observation);
    if (!heard.accepted) return heard;
    followPath(entry, record, fix);
    if (entry.category !== record.category || entry.railMode !== record.mode) {
      entry.category = record.category;
      entry.railMode = record.mode;
      entry.mode = playbackModeFor(record.mode);
      parts.rendering.paint(entry);
    }
    updatePlayback(entry, observation.wallNowMs, observation.monoNowMs);
    parts.rendering.schedulePlayback(entry);
    return heard;
  }

  /** Create and draw a train the layer has not seen before. */
  function addTrain(key, feed, record, fix, observation, status) {
    const entry = {
      key,
      feedId: feed.id,
      marker: null,
      category: record.category,
      railMode: record.mode,
      mode: playbackModeFor(record.mode),
      // A route the classifier named is a fact about the train, so its
      // speed ceiling applies; the movement module reads this flag.
      modeInferred: false,
      courseDeg: Number.isFinite(record.bearing) ? record.bearing : null,
      courseAt: observation.wallNowMs,
      courseEvalAt: observation.monoNowMs,
      record,
      fetchedAt: observation.fetchedAt,
      pollSeq: status.pollSeq,
      /** Binding to a railway line (pathBinding.js), null for straight lines. */
      path: null,
      /** Trip and route the binding was made for; undefined until tried. */
      pathKey: undefined,
    };
    initializePlayback(entry, state._historyBudget, status.lag);
    const first = recordFix(entry, fix, observation);
    if (!first.accepted) {
      destroyTrack(entry.track);
      return null;
    }
    followPath(entry, record, fix);
    syncPlayback(entry, observation.wallNowMs, observation.monoNowMs);
    entry.marker = parts.rendering.addMarker(entry);
    state._trains.set(key, entry);
    parts.rendering.schedulePlayback(entry);
    return entry;
  }

  function applySnapshot(feed, snapshot, { stale, contactedAt = null }) {
    const now = Date.now();
    const fetchedAt = Math.min(
      Number.isFinite(snapshot?.fetchedAt) ? snapshot.fetchedAt : now,
      now,
    );
    const contacted = Math.min(
      Number.isFinite(contactedAt) ? contactedAt : fetchedAt,
      now,
    );
    const status = feedStatus(feed.id);
    status.upstreamAt = Math.max(contacted, fetchedAt);
    const upstreamAgeMs = now - status.upstreamAt;
    status.loading = false;
    status.error = null;
    status.retryInSec = null;
    status.stale = stale === true || upstreamAgeMs > FEED_STALE_AFTER_MS;
    if (upstreamAgeMs > FEED_EVICT_AFTER_MS) {
      removeFeedTrains(feed.id);
      status.count = 0;
      parts.rendering.syncRenderHold();
      state._dataManager?.refreshLayerStats?.();
      return;
    }
    status.pollSeq += 1;
    if (!status.lag) status.lag = createLagReservoir();
    const replayed = status.snapshotAt === fetchedAt || stale === true;
    status.snapshotAt = fetchedAt;
    const monoNow = performance.now();
    // A feed held only for the selected train (viewport.js) carries it alone,
    // or a train its operator now lists on the same trip.
    const only =
      state._heldFeedId === feed.id
        ? state._trains.get(state._selectedKey)
        : null;
    let seen = 0;
    // The cap counts the trains drawn: a copy another feed draws better
    // (dedupe.js) is hidden and does not count.
    let held = 0;
    for (const entry of state._trains.values())
      if (entry.duplicate !== true) held += 1;
    let capped = 0;
    for (const record of snapshot.trains || []) {
      // Only a reported position is drawn, never one from a timetable.
      if (!isLiveRailPositionSource(record?.positionSource)) continue;
      if (isStaleTrainFix(record, now, fetchedAt)) continue;
      const key = railTrainKey(feed.id, record.id);
      if (
        only &&
        key !== only.key &&
        !(only.record?.tripId && record.tripId === only.record.tripId)
      )
        continue;
      const fix = fixFor(record, fetchedAt);
      const observation = {
        receivedAt: now,
        monoNowMs: monoNow,
        wallNowMs: now,
        fetchedAt,
        replayed,
        modeInferred: false,
        context: {
          trip: record.tripId || '',
          route: record.routeId || '',
          mode: playbackModeFor(record.mode),
        },
      };
      let entry = state._trains.get(key);
      if (entry) {
        const heard = advanceTrain(entry, record, fix, observation);
        entry.pollSeq = status.pollSeq;
        seen += 1;
        if (!heard.accepted) continue;
      } else {
        if (held >= MAX_TRAINS_TOTAL) {
          capped += 1;
          continue;
        }
        entry = addTrain(key, feed, record, fix, observation, status);
        if (!entry) continue;
        held += 1;
        seen += 1;
      }
      entry.record = record;
      entry.fetchedAt = fetchedAt;
    }
    // Said in the layer's stats as a partial snapshot (controls.js).
    status.capped = capped;
    if (capped > 0 && !state._capWarned) {
      state._capWarned = true;
      console.warn(
        `[Data:Rail] train cap ${MAX_TRAINS_TOTAL} reached; ${capped} trains of ${feed.id} are not drawn`,
      );
    }
    for (const [key, entry] of state._trains) {
      if (
        entry.feedId === feed.id &&
        status.pollSeq - entry.pollSeq >= MISSED_POLLS_TO_DROP
      )
        removeTrain(key);
    }
    sweepAgedTrains(now);
    duplicates.scheduleRefresh();
    status.count = seen;
    status.lastUpdate = fetchedAt;
    state._lastUpdate = Math.max(state._lastUpdate || 0, fetchedAt);
    state._error = null;
    if (state._viewer)
      registerDynamicCredit(state._viewer, railFeedCredit(feed));
    if (state._trains.get(state._selectedKey)?.feedId === feed.id)
      parts.selection.refreshSelectedCard(true);
    parts.rendering.warmFloors(feed.id);
    state._revision += 1;
    parts.rendering.syncRenderHold();
    governorRequestRender('rail-poll');
    state._dataManager?.refreshLayerStats?.();
    parts.controls.notify();
  }

  /**
   * A feed whose live positions failed (or that its server has none for):
   * its row says it is unavailable. Nothing takes the place of its trains;
   * those already drawn go as their reports age (sweepAgedTrains).
   * @param {object} feed
   * @param {object} status
   * @param {{retryInSec?: number}|null} [error]
   */
  function markUnavailable(feed, status, error = null) {
    // i18n-ignore: English data, translated on display (ui/statusText.js)
    status.error = `${feed.name} feed unavailable`;
    status.retryInSec = Number.isFinite(error?.retryInSec)
      ? error.retryInSec
      : null;
    status.loading = false;
    state._error = status.error;
    sweepAgedTrains(Date.now());
    state._dataManager?.refreshLayerStats?.();
  }

  /**
   * Poll one feed. A request already in flight is reused rather than aborted,
   * so enable() and the manager's first update() share one request.
   * @param {object} feed Registry entry.
   * @param {number} generation Enable generation the poll belongs to.
   * @returns {Promise<void>}
   */
  function pollFeed(feed, generation) {
    if (!state._enabled || generation !== state._generation)
      return Promise.resolve();
    ensurePaths(feed);
    const status = feedStatus(feed.id);
    const existing = state._inFlight.get(feed.id);
    if (existing) return existing.promise;
    const controller = new AbortController();
    status.loading = status.count === 0;
    const promise = (async () => {
      try {
        const response = await source.requestSnapshot(feed.id, {
          signal: controller.signal,
        });
        if (!response.ok) {
          const detail = await response.json().catch(() => null);
          const error = new Error(`rail proxy HTTP ${response.status}`);
          error.status = response.status;
          if (Number.isFinite(detail?.retryInSec))
            error.retryInSec = detail.retryInSec;
          throw error;
        }
        const snapshot = await response.json();
        if (
          !state._enabled ||
          generation !== state._generation ||
          !state._activeFeeds.has(feed.id)
        )
          return;
        // An answer whose positions are not live (anything but GPS or
        // station reports) has no live data for this feed: none of its
        // trains are drawn, and the feed shows unavailable.
        if (!isLiveRailPositionSource(snapshot?.positions)) {
          console.warn(
            `[Data:Rail] ${feed.id} has no live positions on this server`,
          );
          markUnavailable(feed, status);
          return;
        }
        const contact = Number.parseInt(
          response.headers.get('x-rail-contact') || '',
          10,
        );
        applySnapshot(feed, snapshot, {
          stale: response.headers.get('x-gev-cache') === 'STALE-ERROR',
          contactedAt: Number.isFinite(contact) ? contact : null,
        });
      } catch (error) {
        if (error?.name === 'AbortError') return;
        if (generation !== state._generation) return;
        console.warn(
          `[Data:Rail] ${feed.id} poll failed:`,
          error?.message || error,
        );
        markUnavailable(feed, status, error);
      } finally {
        if (state._inFlight.get(feed.id)?.controller === controller)
          state._inFlight.delete(feed.id);
      }
    })();
    state._inFlight.set(feed.id, { controller, promise });
    return promise;
  }

  function abortAllInFlight() {
    for (const { controller } of state._inFlight.values()) controller.abort();
    state._inFlight.clear();
  }

  return {
    feedStatus,
    removeTrain,
    removeFeedTrains,
    sweepAgedTrains,
    applySnapshot,
    pollFeed,
    abortAllInFlight,
    duplicates,
  };
}
