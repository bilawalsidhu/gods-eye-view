import {
  createLagReservoir,
  destroyTrack,
  FIX_FLAGS,
  trimTrack,
} from '../../data/contactPlayback.js';
import {
  FEED_EVICT_AFTER_MS,
  FEED_STALE_AFTER_MS,
  MAX_VEHICLES_TOTAL,
  MISSED_POLLS_TO_DROP,
  TRANSIT_POLL_MS,
  isStaleVehicleFix,
  transitVehicleKey,
  vehicleReportTimeMs,
} from './policy.js';
import {
  transitModeFor,
  transitModeResolved,
} from '../../data/transitFeeds.js';
import {
  attachFloorToPlace,
  initializePlayback,
  recordFix,
  updatePlayback,
  syncPlayback,
} from './movement.js';

/**
 * How far ahead of the snapshot's own fetch time a vehicle stamp may sit
 * before it is a clock fault rather than a report. A stamp an hour ahead once
 * made every honest fix that followed read as out of order, so the marker
 * froze for as long as the clock stayed wrong. Beyond this the fetch time is
 * the honest bound.
 */
export const FUTURE_STAMP_TOLERANCE_MS = 10_000;
/**
 * Consecutive out-of-order refusals after which the history is reset to the
 * incoming fix. A feed whose clock was corrected backwards would otherwise be
 * refused until real time caught up with its old mistake.
 */
export const ORDER_REJECTS_BEFORE_RESET = 3;

/**
 * Fetching feeds through the proxy and turning snapshots into rendered points.
 * @param {object} context
 * @returns {object}
 */
export function createIngestion({ state, services, parts }) {
  const { governorRequestRender } = services.render;
  const { registerDynamicCredit, transitFeedCredit } = services.credits;

  function feedStatus(feedId) {
    let status = state._feedStatus.get(feedId);
    if (!status) {
      status = {
        count: 0,
        lastUpdate: null,
        upstreamAt: null,
        receivedAt: null,
        error: null,
        retryInSec: null,
        stale: false,
        pollSeq: 0,
        loading: false,
      };
      state._feedStatus.set(feedId, status);
    }
    return status;
  }

  function removeVehicle(key) {
    const entry = state._vehicles.get(key);
    if (!entry) return;
    if (state._selectedKey === key) parts.selection.clearSelection();
    if (entry.marker) entry.markerCollection?.remove(entry.marker);
    entry.marker = null;
    entry.detectContact = null;
    state._visible.delete(entry);
    parts.height.releaseVehicle(key, entry.heightCell);
    // A vehicle removed mid-glide takes its share of the hold with it, so the
    // set stays true without waiting for a frame that may never be requested.
    state._moving.delete(entry);
    state._heightDirty.delete(entry);
    parts.rendering.cancelWake(entry);
    destroyTrack(entry.track);
    state._vehicles.delete(key);
    state._detectRevision += 1;
  }

  function removeFeedVehicles(feedId) {
    let removed = 0;
    for (const [key, entry] of state._vehicles) {
      if (entry.feedId === feedId) {
        removeVehicle(key);
        removed += 1;
      }
    }
    if (removed > 0) parts.rendering.syncRenderHold();
    return removed;
  }

  /**
   * Drop what has aged out, whatever the reason.
   *
   * Two independent clocks matter. A single vehicle can go quiet inside a feed
   * that is otherwise healthy, and a whole feed can stop answering while its
   * last snapshot still sits on the globe. The proxy serves a stale snapshot
   * for up to ten minutes and then stops answering at all, and before this
   * sweep existed that silence left the last fleet frozen in place, indefinitely
   * and unlabelled. Both cases now end in removal.
   *
   * @param {number} nowMs
   * @returns {number} Vehicles removed.
   */
  function sweepAgedVehicles(nowMs) {
    let removed = 0;
    const deadFeeds = new Set();
    for (const [feedId, status] of state._feedStatus) {
      // `upstreamAt` — when the OPERATOR last answered — not when this browser
      // last received bytes. The proxy hands back its cached copy every 15 s
      // during an outage, and counting those as updates meant a dead feed never
      // aged at all.
      if (
        Number.isFinite(status.upstreamAt) &&
        nowMs - status.upstreamAt > FEED_EVICT_AFTER_MS
      ) {
        deadFeeds.add(feedId);
      }
    }
    for (const [key, entry] of state._vehicles) {
      if (
        deadFeeds.has(entry.feedId) ||
        isStaleVehicleFix(entry.record, nowMs, entry.fetchedAt)
      ) {
        removeVehicle(key);
        removed += 1;
      }
    }
    if (removed > 0) {
      for (const feedId of deadFeeds) {
        const status = state._feedStatus.get(feedId);
        if (status) {
          status.count = 0;
          status.stale = true;
        }
      }
      // Removing the last vehicle is the moment the layer stops having work.
      // Nothing else would notice: the per-frame pass returns early on an empty
      // fleet, so the hold would sit there held by a fleet that no longer exists.
      parts.rendering.syncRenderHold();
      governorRequestRender('transit-evict');
      state._dataManager?.refreshLayerStats?.();
    }
    return removed;
  }

  function applySnapshot(feed, snapshot, { stale, contactedAt = null }) {
    const now = Date.now();
    // When the OPERATOR produced these positions, not when we received the
    // bytes. A snapshot replayed from the proxy's cache carries its original
    // fetch time, and that is the only honest clock for "how old are these
    // buses".
    const fetchedAt = Math.min(
      Number.isFinite(snapshot?.fetchedAt) ? snapshot.fetchedAt : now,
      now,
    );
    // When the operator last ANSWERED, which is a different question. A feed
    // whose file has not changed answers 304, and the proxy rightly keeps
    // serving the body it already holds — but that body's fetch time stops
    // advancing, so reading it as "when did we last hear from them" aged a
    // perfectly healthy feed into DEGRADED at ninety seconds and emptied it at
    // five minutes while every single request was succeeding. The proxy
    // reports its last successful contact separately; absent that header the
    // fetch time is the best we know.
    const contacted = Math.min(
      Number.isFinite(contactedAt) ? contactedAt : fetchedAt,
      now,
    );
    const status = feedStatus(feed.id);
    const upstreamAgeMs = now - Math.max(contacted, fetchedAt);
    status.upstreamAt = Math.max(contacted, fetchedAt);
    status.receivedAt = now;
    status.loading = false;
    status.error = null;
    status.retryInSec = null;
    status.stale = stale === true || upstreamAgeMs > FEED_STALE_AFTER_MS;

    // Past the eviction window the answer is bytes, not news. Drawing them
    // would put a five-minute-old fleet on the globe with a fresh-looking row.
    if (upstreamAgeMs > FEED_EVICT_AFTER_MS) {
      removeFeedVehicles(feed.id);
      status.count = 0;
      parts.rendering.syncRenderHold();
      governorRequestRender('transit-stale-refused');
      state._dataManager?.refreshLayerStats?.();
      return;
    }

    status.pollSeq += 1;
    const pollSeq = status.pollSeq;
    let seen = 0;
    let rejectedFixes = 0;

    const records = snapshot.vehicles || [];
    if (!status.lag) status.lag = createLagReservoir();
    const replayed = status.snapshotAt === fetchedAt || stale === true;
    status.snapshotAt = fetchedAt;
    const monoNow = performance.now();
    // Under pressure, release hidden retention before visible histories.
    if (
      state._historyBudget.allocatedBytes >
      state._historyBudget.maxBytes * 0.9
    ) {
      for (const vehicle of state._vehicles.values()) {
        if (!vehicle.marker?.show && vehicle.key !== state._selectedKey)
          trimTrack(vehicle.track, now, 2);
      }
    }

    for (const record of records) {
      if (isStaleVehicleFix(record, now, fetchedAt)) continue;
      const key = transitVehicleKey(feed.id, record.id);
      const mode = transitModeFor(feed, record.routeId);
      const modeInferred = !transitModeResolved(feed, record.routeId);
      // A stamp ahead of the fetch is a clock fault; the fetch time bounds it.
      const stamped = vehicleReportTimeMs(record, fetchedAt);
      const reportAt =
        stamped > fetchedAt + FUTURE_STAMP_TOLERANCE_MS ? fetchedAt : stamped;
      const fix = {
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
      let entry = state._vehicles.get(key);
      if (entry) {
        const heard = recordFix(entry, fix, {
          receivedAt: now,
          monoNowMs: monoNow,
          wallNowMs: now,
          replayed,
          modeInferred,
          context: {
            trip: record.tripId || '',
            route: record.routeId || '',
            mode,
          },
        });
        if (!heard.accepted) {
          entry.pollSeq = pollSeq;
          seen += 1;
          if (heard.reason !== 'repeat') rejectedFixes += 1;
          continue;
        }
        if (entry.mode !== mode) parts.rendering.paintMode(entry, mode);
        entry.modeInferred = modeInferred;
        updatePlayback(entry, now, monoNow);
        parts.rendering.schedulePlayback(entry);
        // Ground follows the vehicle, every poll: a mesh floor landing over a
        // DEM one, or a change of map regime, moves a parked vehicle too. A
        // cell still cold takes the lowest neighbour as a prior, as before.
        const priorHeightM = entry.heightM;
        const height = parts.height.requestHeight(record.lat, record.lon);
        if (height.height !== null) {
          entry.heightCell = height.cell;
          entry.heightM = height.height;
          entry.heightResolved = true;
          entry.heightPending = false;
        } else if (height.cell !== entry.heightCell || !entry.heightResolved) {
          entry.heightCell = height.cell;
          entry.heightResolved = false;
          if (height.prior !== null) {
            entry.heightM = height.prior;
            entry.heightPending = false;
          }
        }
        // The floor belongs to the FIX it was asked for: the display may still
        // be drawing an older fix on lower ground, and lifting that one onto
        // the newest fix's surface is the flew-up-then-travelled jump. The
        // frame pass owns the move, for a moving vehicle and a parked one
        // alike.
        const newest = entry.fixes[entry.fixes.length - 1];
        const stood = newest.h;
        if (height.height !== null) {
          attachFloorToPlace(entry, newest, height.height);
        }
        if (entry.heightM !== priorHeightM || newest.h !== stood) {
          state._heightDirty.add(entry);
        }
      } else {
        if (state._vehicles.size >= MAX_VEHICLES_TOTAL) {
          if (!state._limitWarned) {
            state._limitWarned = true;
            console.warn(
              `[Data:Transit] vehicle cap ${MAX_VEHICLES_TOTAL} reached — extra vehicles are not rendered`,
            );
          }
          continue;
        }
        const height = parts.height.requestHeight(record.lat, record.lon);
        // Keep the local prior separate from resolved historical floors.
        // A neighbouring cell is not a guaranteed lower bound.
        const prior = height.height === null ? height.prior : height.height;
        entry = {
          key,
          feedId: feed.id,
          marker: null,
          mode,
          modeInferred,
          heightM: prior === null ? 0 : prior,
          heightCell: height.cell,
          heightResolved: height.height !== null,
          // Nothing trustworthy to stand on and no prior to borrow: the
          // vehicle waits one sample rather than floating.
          heightPending: height.height === null && prior === null,
          from: null,
          to: null,
          fromCart: null,
          toCart: null,
          playT: NaN,
          resets: 0,
          courseDeg: Number.isFinite(record.bearing) ? record.bearing : null,
          courseAt: now,
          courseEvalAt: monoNow,
          record,
          fetchedAt,
          pollSeq,
        };
        initializePlayback(entry, state._historyBudget, status.lag);
        const first = recordFix(entry, fix, {
          receivedAt: now,
          monoNowMs: monoNow,
          wallNowMs: now,
          replayed,
          modeInferred,
          context: {
            trip: record.tripId || '',
            route: record.routeId || '',
            mode,
          },
        });
        if (!first.accepted) {
          destroyTrack(entry.track);
          continue;
        }
        if (height.height !== null)
          attachFloorToPlace(entry, fix, height.height);
        // A new vehicle holds at its only fix; its clock starts a full lag
        // behind, so by the time playback reaches the fix the next one has
        // arrived and the segment can be drawn at 1x.
        syncPlayback(entry, now, monoNow);
        entry.from = entry.segment.from;
        entry.to = entry.segment.to;
        parts.rendering.refreshEndpoints(entry);
        entry.marker = parts.rendering.addMarker(key, entry);
        state._vehicles.set(key, entry);
        parts.rendering.schedulePlayback(entry);
        if (entry.courseDeg !== null) state._rotationDirty = true;
      }
      entry.record = record;
      entry.fetchedAt = fetchedAt;
      entry.pollSeq = pollSeq;
      seen += 1;
    }

    // Drop vehicles this feed stopped reporting.
    for (const [key, entry] of state._vehicles) {
      if (
        entry.feedId === feed.id &&
        pollSeq - entry.pollSeq >= MISSED_POLLS_TO_DROP
      ) {
        removeVehicle(key);
      }
    }
    sweepAgedVehicles(now);

    status.count = seen;
    status.lastUpdate = fetchedAt;
    status.receivedAt = now;
    // The layer-level timestamp is the freshest UPSTREAM time across feeds, so
    // the panel's "just now" means the positions are from just now.
    state._lastUpdate =
      Math.max(state._lastUpdate || 0, fetchedAt) || fetchedAt;
    state._error = null;
    if (rejectedFixes > 0 && !state._jumpWarned) {
      state._jumpWarned = true;
      console.warn(
        `[Data:Transit] ${feed.id}: ${rejectedFixes} fix(es) implied impossible travel and were not animated`,
      );
    }
    if (state._viewer)
      registerDynamicCredit(state._viewer, transitFeedCredit(feed));
    if (
      state._selectedKey &&
      state._vehicles.get(state._selectedKey)?.feedId === feed.id
    ) {
      parts.selection.refreshSelectedCard(true);
    }
    // Records changed hands this poll, so DETECT's list is rebuilt once —
    // the visibility sweep below bumps the revision.
    // One floor cycle per poll, on its own timer: warming is a network round
    // trip and must never sit on the render path.
    parts.height.anchorFloors();
    state._detectRevision++;
    parts.rendering.requestVisibility();
    parts.rendering.syncRenderHold();
    governorRequestRender('transit-poll');
    state._dataManager?.refreshLayerStats?.();
  }

  /**
   * Poll one feed. A request already in flight is younger than one poll
   * interval, so a second caller (enable() and the manager's first update()
   * both ask within the same tick) awaits that request instead of aborting it —
   * the manager's first update then settles with data on the globe.
   * @param {object} feed Registry entry.
   * @param {number} generation Enable generation the poll belongs to.
   * @returns {Promise<void>}
   */
  function pollFeed(feed, generation) {
    if (!state._enabled || generation !== state._generation)
      return Promise.resolve();
    const existing = state._inFlight.get(feed.id);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const status = feedStatus(feed.id);
    status.loading = status.count === 0;
    const promise = (async () => {
      try {
        const response = await fetch(
          `/api/transit/vehicles/${encodeURIComponent(feed.id)}`,
          {
            signal: controller.signal,
            headers: { Accept: 'application/json' },
          },
        );
        if (!response.ok) {
          // The proxy says when it will next try the operator; carrying that
          // through means the row can offer a time instead of just a shrug.
          const detail = await response.json().catch(() => null);
          const error = new Error(`transit proxy HTTP ${response.status}`);
          if (Number.isFinite(detail?.retryInSec)) {
            error.retryInSec = detail.retryInSec;
          }
          throw error;
        }
        const snapshot = await response.json();
        if (
          !state._enabled ||
          generation !== state._generation ||
          !state._activeFeeds.has(feed.id)
        ) {
          return;
        }
        const contactHeader = Number.parseInt(
          response.headers.get('x-transit-contact') || '',
          10,
        );
        applySnapshot(feed, snapshot, {
          stale: response.headers.get('x-gev-cache') === 'STALE-ERROR',
          contactedAt: Number.isFinite(contactHeader) ? contactHeader : null,
        });
      } catch (error) {
        if (error?.name === 'AbortError') return;
        if (generation !== state._generation) return;
        console.warn(
          `[Data:Transit] ${feed.id} poll failed:`,
          error?.message || error,
        );
        status.error = `${feed.name} feed unavailable`;
        status.retryInSec = Number.isFinite(error?.retryInSec)
          ? error.retryInSec
          : null;
        status.loading = false;
        state._error = status.error;
        // A failed poll is exactly when old vehicles must be re-examined:
        // nothing else will tell the globe this feed has gone quiet.
        sweepAgedVehicles(Date.now());
        state._dataManager?.refreshLayerStats?.();
      } finally {
        if (state._inFlight.get(feed.id)?.controller === controller) {
          state._inFlight.delete(feed.id);
        }
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
    removeVehicle,
    removeFeedVehicles,
    sweepAgedVehicles,
    applySnapshot,
    pollFeed,
    abortAllInFlight,
  };
}
