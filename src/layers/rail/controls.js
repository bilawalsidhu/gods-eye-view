import { t } from '../../i18n/index.js';
import { RAIL_CATEGORIES } from '../../data/railFeeds.js';
import { aggregateTransitFeedHealth } from '../transit/policy.js';
import {
  ACTIVATION_ALTITUDE_M,
  FEED_STALE_AFTER_MS,
  RAIL_CATEGORY_COLORS,
  RAIL_CATEGORY_LABELS,
  normalizeRailCategories,
} from './policy.js';

/**
 * Category toggles, the layer row and the stats the panel reads.
 * @param {object} context
 * @returns {object}
 */
export function createControls({ state, parts, timetable }) {
  function notify() {
    state._controlsListener?.();
  }

  /** Regions with at least one pollable feed, for the empty-coverage note. */
  function regionCount() {
    return new Set(parts.viewport.pollableFeeds().map((feed) => feed.region))
      .size;
  }

  /**
   * Trains per category for the legend, shown or not; a train two feeds
   * carry is one train (the copy dedupe.js hides is not counted).
   */
  function categoryCounts() {
    const counts = new Map();
    for (const entry of state._trains.values())
      if (entry.duplicate !== true)
        counts.set(entry.category, (counts.get(entry.category) || 0) + 1);
    return counts;
  }

  /**
   * Trains drawn per feed: those still held (a train missing from one poll
   * stays until MISSED_POLLS_TO_DROP) in a shown category, and not hidden as
   * another feed's copy. The feed status's own count is what the last poll
   * listed, which the loading and health rules need but the map does not
   * show, so the coverage line counts drawn trains, as the layer total does.
   */
  function drawnCounts() {
    const counts = new Map();
    for (const entry of state._trains.values())
      if (parts.rendering.categoryShown(entry))
        counts.set(entry.feedId, (counts.get(entry.feedId) || 0) + 1);
    return counts;
  }

  /** The coverage line: each active feed and its train count, aged when quiet. */
  function coverageLine(active, now) {
    const drawn = drawnCounts();
    return active
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
        return `${feed.name} ${drawn.get(feed.id) || 0}${aged}`;
      })
      .join(' · ');
  }

  const methods = {
    /** Wired by the application so polls can repaint the panel row. */
    attachDataManager(manager) {
      state._dataManager = manager;
    },
    setRowControlsListener(listener) {
      state._controlsListener =
        typeof listener === 'function' ? listener : null;
    },
    /** The category toggles, for share links and restoration. */
    getParams() {
      return { ...state._categories };
    },
    /** Show or hide categories; unknown keys and non-booleans change nothing. */
    setParams(params = {}) {
      const next = normalizeRailCategories(params, state._categories);
      if (RAIL_CATEGORIES.every((key) => next[key] === state._categories[key]))
        return true;
      state._categories = next;
      const selected = state._trains.get(state._selectedKey);
      if (selected && next[selected.category] === false)
        parts.selection.clearSelection();
      parts.rendering.applyCategoryVisibility();
      state._revision += 1;
      notify();
      state._dataManager?.refreshLayerStats?.();
      return true;
    },
    /** One chip per category, with the colour and live count as the legend. */
    getRowControls() {
      const counts = categoryCounts();
      const chips = RAIL_CATEGORIES.map((category) => {
        const on = state._categories[category] !== false;
        const label = t(RAIL_CATEGORY_LABELS[category]);
        return {
          id: `rail-${category}`,
          label: label.toUpperCase(),
          title: on
            ? t('Hide {category}', { category: label })
            : t('Show {category}', { category: label }),
          active: on,
          busy: false,
          disabled: false,
          state: on ? 'active' : 'idle',
          params: { [category]: !on },
        };
      });
      const legend = RAIL_CATEGORIES.filter((category) =>
        counts.has(category),
      ).map((category) => ({
        label: t(RAIL_CATEGORY_LABELS[category]),
        color: RAIL_CATEGORY_COLORS[category],
        count: counts.get(category),
      }));
      return { chips, legend };
    },
    /** Route-line, stop, schedule and camera-follow state, for QA probes. */
    getRouteDisplayStats() {
      return {
        ...parts.routes.stats(),
        timetable: timetable.stats(),
        follow: parts.follow.stats(),
        heldFeed: state._heldFeedId,
      };
    },
    getStats() {
      const active = [...state._activeFeeds.values()];
      const statuses = active.map((feed) =>
        parts.ingestion.feedStatus(feed.id),
      );
      const now = Date.now();
      const health = aggregateTransitFeedHealth(statuses, now);
      let count = 0;
      for (const entry of state._trains.values())
        if (parts.rendering.categoryShown(entry)) count += 1;
      // New trains the layer's cap left out of the last polls
      // (MAX_TRAINS_TOTAL): the map shows part of what the feeds list.
      const capped = statuses.reduce(
        (sum, status) => sum + (status.capped || 0),
        0,
      );
      if (state._enabled && active.length === 0) {
        // English: the row's prompt and the analyst's empty note, both shown
        // through translateStatusMessage (ui/statusText.js), as Transit's.
        const note = state._altitudeGateOpen
          ? `No feed here yet · ${regionCount()} regions available`
          : `Fly below ${Math.round(ACTIVATION_ALTITUDE_M / 1000).toLocaleString('en-US')} km to a covered region`;
        return {
          count: 0,
          lastUpdate: state._lastUpdate,
          error: null,
          source: 'GTFS-RT',
          status: 'zoom-in',
          statusMessage: note,
          coverage: note,
        };
      }
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
          // i18n-ignore: English data, translated on display (ui/statusText.js)
          health.loading && count === 0
            ? `Loading ${active.map((feed) => feed.name).join(', ')}`
            : undefined,
        stale: health.stale,
        // The panel reads this as "PARTIAL · N of M records accepted".
        ...(capped > 0 && count > 0
          ? {
              partial: true,
              acceptedRowCount: count,
              rawRowCount: count + capped,
            }
          : {}),
        source: 'GTFS-RT',
        coverage: coverageLine(active, now),
        feeds: active.map((feed) => feed.id),
      };
    },
  };

  return { methods, notify };
}
