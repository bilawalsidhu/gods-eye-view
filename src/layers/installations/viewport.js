import * as Cesium from 'cesium';
import { MAX_VIEWPORT_DEGREES, REQUEST_DEBOUNCE_MS } from './policy.js';

export function createViewport({ state: layerState, services, parts, source }) {
  function viewportBox(viewer) {
    const rectangle = viewer?.camera?.computeViewRectangle(
      viewer.scene.globe.ellipsoid,
    );
    if (!rectangle) return null;
    const south = Cesium.Math.toDegrees(rectangle.south);
    const north = Cesium.Math.toDegrees(rectangle.north);
    const west = Cesium.Math.toDegrees(rectangle.west);
    const east = Cesium.Math.toDegrees(rectangle.east);
    // Cross-dateline/global views require a zoom before a bounded request.
    if (
      !Number.isFinite(south + north + west + east) ||
      east <= west ||
      north - south > MAX_VIEWPORT_DEGREES ||
      east - west > MAX_VIEWPORT_DEGREES
    )
      return null;
    return { south, west, north, east };
  }

  /**
   * Backoff progression for the unavailable-state retry: 30 s, doubling to a
   * 240 s ceiling. Pure so the progression is pinnable without booting the layer.
   */

  function installationRetryDelayMs(prevDelayMs) {
    const RETRY_MIN_MS = 30000;
    const RETRY_CEIL_MS = 240000;
    if (!Number.isFinite(prevDelayMs) || prevDelayMs <= 0) return RETRY_MIN_MS;
    return Math.min(prevDelayMs * 2, RETRY_CEIL_MS);
  }

  /**
   * 'Temporarily unavailable' must mean temporarily: fetches otherwise fire only
   * on enable and on camera moveEnd, so a parked camera whose first request died
   * (one flaky Overpass mirror is enough) stayed unavailable forever while the
   * proxy sat healthy while the layer refused to show its features. While the
   * layer is enabled and
   * unavailable, retry on a 30 s → 240 s backoff; any success, user-driven load,
   * zoom-out, or disable cancels it.
   */

  function scheduleUnavailableRetry(retryAfterMs = 0) {
    if (!layerState.enabled) return;
    clearTimeout(layerState.retryTimer);
    layerState.retryDelayMs = Math.max(
      retryAfterMs,
      installationRetryDelayMs(layerState.retryDelayMs),
    );
    layerState.retryAt = Date.now() + layerState.retryDelayMs;
    layerState.retryTimer = setTimeout(() => {
      layerState.retryTimer = null;
      layerState.retryAt = 0;
      if (layerState.enabled && !layerState.loading)
        parts.ingestion.loadInstallations();
    }, layerState.retryDelayMs);
  }

  function clearUnavailableRetry({ resetBackoff = true } = {}) {
    clearTimeout(layerState.retryTimer);
    layerState.retryTimer = null;
    layerState.retryAt = 0;
    if (resetBackoff) layerState.retryDelayMs = 0;
  }

  function scheduleLoad() {
    if (!layerState.enabled) return;
    layerState.abort?.abort();
    // A user-driven load supersedes any pending retry; the load reschedules on
    // failure, so the backoff step is kept rather than reset.
    clearUnavailableRetry({ resetBackoff: false });
    clearTimeout(layerState.timer);
    layerState.timer = setTimeout(() => {
      parts.ingestion.loadInstallations();
    }, REQUEST_DEBOUNCE_MS);
  }
  return {
    viewportBox,
    installationRetryDelayMs,
    scheduleUnavailableRetry,
    clearUnavailableRetry,
    scheduleLoad,
  };
}
