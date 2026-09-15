import { transitModeFor } from '../../data/transitFeeds.js';
import {
  MAX_VEHICLES_TOTAL,
  MISSED_POLLS_TO_DROP,
  TRANSIT_POLL_MS,
} from './policy.js';
import {
  interpolatedVehiclePosition,
  isStaleVehicleFix,
  transitVehicleKey,
} from './model.js';

/** Polling the source and folding each snapshot into the vehicle table. */
export function createIngestion({
  state: layerState,
  services,
  parts,
  source,
}) {
  function feedStatus(feedId) {
    let status = layerState._feedStatus.get(feedId);
    if (!status) {
      status = {
        count: 0,
        lastUpdate: null,
        error: null,
        stale: false,
        pollSeq: 0,
        loading: false,
      };
      layerState._feedStatus.set(feedId, status);
    }
    return status;
  }

  function notifyRow() {
    layerState._dataManager?.refreshLayerStats?.();
  }

  /**
   * Fold one decoded snapshot into the vehicle table: known vehicles get a
   * new fix to glide to, new ones a point, absent ones a missed-poll mark.
   * @param {object} feed Registry entry.
   * @param {object} snapshot `{ vehicles[] , stale? }` from the source.
   */
  function applySnapshot(feed, snapshot) {
    const now = layerState._now();
    const status = feedStatus(feed.id);
    status.pollSeq += 1;
    const pollSeq = status.pollSeq;
    let seen = 0;
    for (const record of snapshot.vehicles || []) {
      if (isStaleVehicleFix(record, now)) continue;
      const key = transitVehicleKey(feed.id, record.id);
      const mode = transitModeFor(feed, record.routeId);
      let entry = layerState._vehicles.get(key);
      if (entry) {
        const drawn = interpolatedVehiclePosition(entry, now);
        entry.from = { lat: drawn.lat, lon: drawn.lon };
        entry.to = { lat: record.lat, lon: record.lon };
        entry.tStart = now;
        entry.tEnd = now + TRANSIT_POLL_MS;
        if (entry.mode !== mode) {
          entry.mode = mode;
          parts.rendering.recolor(entry);
        }
      } else {
        if (layerState._vehicles.size >= MAX_VEHICLES_TOTAL) {
          if (!layerState._limitWarned) {
            layerState._limitWarned = true;
            console.warn(
              `[Data:Transit] vehicle cap ${MAX_VEHICLES_TOTAL} reached — extra vehicles are not rendered`,
            );
          }
          continue;
        }
        entry = parts.rendering.createVehicle(key, feed.id, mode, record, now);
        layerState._vehicles.set(key, entry);
      }
      entry.record = record;
      entry.pollSeq = pollSeq;
      seen += 1;
    }
    for (const [key, entry] of layerState._vehicles) {
      if (
        entry.feedId === feed.id &&
        pollSeq - entry.pollSeq >= MISSED_POLLS_TO_DROP
      )
        parts.rendering.removeVehicle(key);
    }
    status.count = seen;
    status.lastUpdate = now;
    status.error = null;
    status.stale = snapshot.stale === true;
    status.loading = false;
    layerState._lastUpdate = now;
    layerState._error = null;
    parts.rendering.anchorFloors();
    if (layerState._viewer && services.credits)
      services.credits.registerTransitFeedCredit(layerState._viewer, feed);
    parts.selection.refreshSelectedCard(true, feed.id);
    parts.rendering.syncRenderHold();
    services.render.governorRequestRender('transit-poll');
    notifyRow();
  }

  /**
   * Poll one feed. A request already in flight is younger than one poll
   * interval, so a second caller (enable() and the manager's first update()
   * both ask within the same tick) awaits that request instead of aborting
   * it — the manager's first update then settles with data on the globe.
   * @param {object} feed Registry entry.
   * @param {number} generation Enable generation the poll belongs to.
   * @returns {Promise<void>}
   */
  function pollFeed(feed, generation) {
    if (!layerState._enabled || generation !== layerState._generation)
      return Promise.resolve();
    const existing = layerState._inFlight.get(feed.id);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const status = feedStatus(feed.id);
    status.loading = status.count === 0;
    const promise = (async () => {
      try {
        const snapshot = await source.getVehicles(feed.id, {
          signal: controller.signal,
        });
        if (
          !layerState._enabled ||
          generation !== layerState._generation ||
          !layerState._activeFeeds.has(feed.id)
        )
          return;
        applySnapshot(feed, snapshot);
      } catch (error) {
        if (error?.name === 'AbortError') return;
        if (generation !== layerState._generation) return;
        console.warn(
          `[Data:Transit] ${feed.id} poll failed:`,
          error?.message || error,
        );
        status.error = `${feed.name} feed unavailable`;
        status.loading = false;
        layerState._error = status.error;
        notifyRow();
      } finally {
        if (layerState._inFlight.get(feed.id)?.controller === controller)
          layerState._inFlight.delete(feed.id);
      }
    })();
    layerState._inFlight.set(feed.id, { controller, promise });
    return promise;
  }

  function abortFeed(feedId) {
    layerState._inFlight.get(feedId)?.controller.abort();
    layerState._inFlight.delete(feedId);
  }

  function abortAllInFlight() {
    for (const { controller } of layerState._inFlight.values())
      controller.abort();
    layerState._inFlight.clear();
  }

  return {
    feedStatus,
    applySnapshot,
    pollFeed,
    abortFeed,
    abortAllInFlight,
    notifyRow,
  };
}
