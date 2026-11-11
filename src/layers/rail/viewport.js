import * as Cesium from 'cesium';
import {
  ACTIVATION_ENTER_ALTITUDE_M,
  ACTIVATION_EXIT_ALTITUDE_M,
  CAMERA_DEBOUNCE_MS,
  RANGE_SLACK_KM,
  isLiveRailPositionSource,
  railCatalogRetryDelayMs,
} from './policy.js';
import {
  RAIL_ENABLED_FEEDS,
  railFeedNeedsSchedulePack,
  railFeedsInRange,
} from '../../data/railFeeds.js';

/**
 * Camera-driven feed activation: only the feeds whose coverage circle contains
 * the look-at point are polled, and only below the altitude gate; the selected
 * train's feed is polled for it wherever the camera is.
 * @param {object} context
 * @returns {object}
 */
export function createViewport({ state, services, parts, source }) {
  const { governorRequestRender } = services.render;

  function cameraAltitude() {
    const carto = state._viewer?.camera?.positionCartographic;
    return carto && Number.isFinite(carto.height) ? carto.height : Infinity;
  }

  function cameraCenter() {
    const viewer = state._viewer;
    const rect = viewer?.camera?.computeViewRectangle?.(
      viewer.scene.globe?.ellipsoid,
    );
    const point = rect
      ? Cesium.Rectangle.center(rect)
      : viewer?.camera?.positionCartographic;
    if (!point) return null;
    return {
      lat: Cesium.Math.toDegrees(point.latitude),
      lon: Cesium.Math.toDegrees(point.longitude),
    };
  }

  /**
   * Bundled feeds used until the catalog has loaded: those that need no
   * schedule pack. A live feed that reads its routes from one is used only
   * once the catalog lists it, which it does only once its pack is built.
   */
  const PACKLESS_FEEDS = RAIL_ENABLED_FEEDS.filter(
    (feed) =>
      isLiveRailPositionSource(feed.positions) &&
      !railFeedNeedsSchedulePack(feed),
  );

  /** The server's catalog once it has loaded, else the packless feeds. */
  function pollableFeeds() {
    return state._catalog || PACKLESS_FEEDS;
  }

  /**
   * Read the server's feed catalog once per layer instance. It leaves out
   * the feeds whose packs are not built, which are then never polled; until
   * it answers (or with a source that has no catalog), only the feeds that
   * need no pack are used. A feed it lists without live positions is never
   * polled: no train is placed from a timetable. A catalog that fails is
   * asked for again after railCatalogRetryDelayMs while the layer is on.
   */
  function loadCatalog() {
    if (state._catalog || state._catalogRequest) return;
    if (typeof source.getFeeds !== 'function') return;
    clearTimeout(state._catalogRetryTimer);
    state._catalogRetryTimer = null;
    const controller = new AbortController();
    const request = { controller };
    state._catalogRequest = request;
    (async () => {
      try {
        const feeds = await source.getFeeds({ signal: controller.signal });
        if (state._catalogRequest !== request) return;
        const usable = feeds.filter(
          (feed) =>
            typeof feed?.id === 'string' &&
            Number.isFinite(feed?.center?.lat) &&
            Number.isFinite(feed?.center?.lon) &&
            Number.isFinite(feed?.loadRadiusKm) &&
            isLiveRailPositionSource(feed?.positions),
        );
        state._catalog = Object.freeze(usable);
        state._catalogFailures = 0;
        state._catalogRequest = null;
        logCatalog(usable);
        runProximityCheck();
      } catch (error) {
        if (error?.name === 'AbortError' || state._catalogRequest !== request)
          return;
        state._catalogRequest = null;
        state._catalogFailures += 1;
        const delay = railCatalogRetryDelayMs(state._catalogFailures);
        console.warn(
          `[Data:Rail] feed catalog unavailable, trying again in ${Math.round(delay / 1000)}s:`,
          error?.message || error,
        );
        if (!state._enabled) return;
        state._catalogRetryTimer = setTimeout(() => {
          state._catalogRetryTimer = null;
          if (state._enabled) loadCatalog();
        }, delay);
      } finally {
        if (state._catalogRequest === request) state._catalogRequest = null;
      }
    })();
  }

  /** Say once how many live feeds the catalog lists. */
  function logCatalog(feeds) {
    console.log(`[Data:Rail] Catalog lists ${feeds.length} live train feeds`);
  }

  function cancelCatalog() {
    state._catalogRequest?.controller.abort();
    state._catalogRequest = null;
    clearTimeout(state._catalogRetryTimer);
    state._catalogRetryTimer = null;
  }

  function runProximityCheck() {
    if (globalThis.document?.visibilityState === 'hidden') return;
    if (!state._enabled || !state._viewer) return;
    // The feeds in use until now are marked seen before any is let go.
    parts.routes.releaseIdleFeeds(Date.now());
    const altitude = cameraAltitude();
    state._altitudeGateOpen = state._altitudeGateOpen
      ? altitude <= ACTIVATION_EXIT_ALTITUDE_M
      : altitude <= ACTIVATION_ENTER_ALTITUDE_M;
    const center = state._altitudeGateOpen ? cameraCenter() : null;
    const desired = new Map();
    if (center) {
      const feeds = pollableFeeds();
      for (const feed of railFeedsInRange(center.lat, center.lon, 0, feeds))
        desired.set(feed.id, feed);
      for (const feed of railFeedsInRange(
        center.lat,
        center.lon,
        RANGE_SLACK_KM,
        feeds,
      ))
        if (state._activeFeeds.has(feed.id)) desired.set(feed.id, feed);
    }
    // The selected train's feed stays polled however far out or away the
    // camera goes, so the train and its line stay on the map; while nothing
    // else would keep the feed, it carries the selected train alone and its
    // other trains go as they would with the feed.
    const selected = state._trains.get(state._selectedKey);
    const held =
      selected &&
      !desired.has(selected.feedId) &&
      state._activeFeeds.has(selected.feedId)
        ? selected.feedId
        : null;
    if (held) desired.set(held, state._activeFeeds.get(held));
    const released = state._heldFeedId !== held ? state._heldFeedId : null;
    state._heldFeedId = held;
    for (const feedId of [...state._activeFeeds.keys()]) {
      if (desired.has(feedId)) continue;
      state._inFlight.get(feedId)?.controller.abort();
      state._inFlight.delete(feedId);
      state._activeFeeds.delete(feedId);
      state._feedStatus.delete(feedId);
      parts.ingestion.removeFeedTrains(feedId);
    }
    if (held) parts.ingestion.removeFeedTrains(held, state._selectedKey);
    // A feed the selection held that the view wants again brings its other
    // trains back now, not at the next poll.
    if (released && desired.has(released))
      void parts.ingestion.pollFeed(desired.get(released), state._generation);
    for (const [feedId, feed] of desired) {
      if (state._activeFeeds.has(feedId)) continue;
      state._activeFeeds.set(feedId, feed);
      void parts.ingestion.pollFeed(feed, state._generation);
    }
    parts.ingestion.sweepAgedTrains(Date.now());
    parts.routes.onCamera();
    parts.routes.applyNetwork();
    parts.rendering.syncRenderHold();
    state._dataManager?.refreshLayerStats?.();
    governorRequestRender('rail-proximity');
  }

  function onCameraChanged() {
    // The network's altitude fade follows the zoom without the debounce; it
    // only writes when the fade crosses a step.
    parts.routes.onCamera();
    clearTimeout(state._cameraDebounceTimer);
    state._cameraDebounceTimer = setTimeout(() => {
      state._cameraDebounceTimer = null;
      runProximityCheck();
    }, CAMERA_DEBOUNCE_MS);
  }

  /**
   * Re-run the check off the caller's stack: a selection changed, so the
   * feed it holds may change too.
   */
  function requestProximityCheck() {
    if (!state._enabled) return;
    clearTimeout(state._cameraDebounceTimer);
    state._cameraDebounceTimer = setTimeout(() => {
      state._cameraDebounceTimer = null;
      runProximityCheck();
    }, 0);
  }

  return {
    runProximityCheck,
    onCameraChanged,
    requestProximityCheck,
    cameraAltitude,
    loadCatalog,
    cancelCatalog,
    pollableFeeds,
  };
}
