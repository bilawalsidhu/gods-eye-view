import {
  adaptFirmsRecords,
  expireFirmsRecords,
} from '../../data/firmsAdapt.js';
import { fireDetectionKey } from '../../data/firmsLabels.js';

export function createIngestion({
  layerState,
  services,
  components,
  config,
  feed,
}) {
  const { clearSelectedEntityContextForLayer } = services.context;
  const { id } = config;

  /** Replace a validated snapshot while preserving source freshness and selection identity. */

  async function loadHeatmap() {
    if (!layerState._dataSource || !layerState._enabled) return;
    layerState.request?.abort();
    const request = new AbortController();
    layerState.request = request;
    layerState._loading = true;

    try {
      // A validator belongs to the exact record set it arrived with; any
      // other writer of `_fires` voids it.
      const held = layerState._snapshot;
      const payload = await feed.getSnapshot({
        signal: request.signal,
        etag: held?.fires === layerState._fires ? held.etag : null,
      });
      if (
        request.signal.aborted ||
        layerState.request !== request ||
        !layerState._enabled
      )
        return;
      if (payload.keyRequired) {
        layerState._keyRequired = true;
        layerState._error = null;
        layerState._stale = false;
        return;
      }
      layerState._keyRequired = false;
      layerState._error = null;
      let fires;
      let firesByFrp;
      if (payload.notModified) {
        // Same snapshot, so freshness and staleness stand; only detections
        // that aged out of the trailing window leave.
        const expired = expireFirmsRecords(
          layerState._fires,
          layerState._firesByFrp,
          Date.now(),
        );
        if (!expired) return;
        ({ fires, firesByFrp } = expired);
      } else {
        layerState._stale = Boolean(payload?.stale);
        fires = adaptFirmsRecords(payload?.fires);
        firesByFrp = [...fires].sort((a, b) => b.frp - a.frp);
        // Data age, not response age: a stale proxy payload truthfully reads old.
        layerState._lastUpdate = Number.isFinite(payload?.fetchedAt)
          ? payload.fetchedAt
          : Date.now();
      }
      const previousSelection = layerState._selectedFire;
      layerState._selectedFire = null;
      layerState._fires = fires;
      layerState._cellCacheByGrid.clear(); // aggregation is per-dataset — new fires, new cells
      layerState._firesByFrp = firesByFrp;
      layerState._count = layerState._fires.length;
      layerState._snapshot = {
        etag: payload.notModified ? held.etag : payload.etag,
        fires,
      };
      // Settle the previous selection BEFORE the LOD rebuild. renderCurrentLod
      // runs refreshContextRegistrations(), which deletes every context record
      // not in the new top-N — including the one the store still points at.
      // Clearing after that deletion fails the ownership guard inside
      // clearSelectedEntityContextForLayer and emits nothing at all, so an
      // eviction-aware readout never hears that its subject is gone.
      const reselected = findMatchingFire(previousSelection);
      if (!reselected && previousSelection) {
        // The selected detection is not in the new payload: it left the feed
        // rather than being deselected. Eviction-aware readouts hold their
        // last-known values for this instead of tearing down.
        clearSelectedEntityContextForLayer(id, { evicted: true });
      }
      components.rendering.renderCurrentLod(true);
      if (reselected) components.selection.selectFire(reselected, false);
    } catch (error) {
      if (
        request.signal.aborted ||
        layerState.request !== request ||
        !layerState._enabled
      )
        return;
      console.warn(`[Data:${id}] FIRMS live load failed:`, error);
      layerState._error = 'live feed unavailable';
    } finally {
      if (layerState.request === request) {
        layerState.request = null;
        layerState._loading = false;
      }
    }
  }

  /**
   * Find the record in the freshly-loaded set matching a previous selection.
   * Identity is the detection itself (lat/lon/acquisition time) — indices
   * are regenerated every fetch, so object/index identity cannot be used.
   * @param {?Object} previous - Previously selected fire record.
   * @returns {?Object} Matching new record.
   */

  function findMatchingFire(previous) {
    if (!previous) return null;
    const key = fireDetectionKey(previous);
    return (
      layerState._fires.find((fire) => fireDetectionKey(fire) === key) || null
    );
  }
  const methods = {
    async update() {
      if (layerState._destroyed || !layerState._enabled || layerState._loading)
        return;
      // Scheduled 10-minute poll (and the manager's immediate first update):
      // refetch live fires through the proxy and re-render. Viewport-driven
      // re-renders between polls are handled by the LOD watcher.
      await loadHeatmap();
    },
  };

  return { loadHeatmap, findMatchingFire, methods };
}
