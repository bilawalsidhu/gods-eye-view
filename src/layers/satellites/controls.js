import {
  tallySatelliteClasses,
  satelliteClassLabel,
  satelliteClassLegend,
} from '../../data/satelliteClass.js';
import * as Cesium from 'cesium';
import { ISS_NORAD, POINT_STYLES } from './policy.js';

export function createControls({ state: layerState, services, parts, source }) {
  const { isExplicitLayerStateOrigin } = services.layerState;

  /**
   * Resolve the canonical point style for a satellite.
   * @param {number} noradId NORAD catalog number.
   * @param {string|undefined} group Catalog group tag (see CATALOG_GROUPS / 'dense').
   * @returns {{ pixelSize: number, color: Cesium.Color, outlineColor: Cesium.Color, outlineWidth: number }}
   */

  function _pointStyleFor(noradId, group) {
    if (noradId === ISS_NORAD) return POINT_STYLES.iss;
    return POINT_STYLES[group] || POINT_STYLES.visual;
  }

  /** Tell the manager to re-render this layer's row (chip state / legend counts). */

  function _notifyRowControls() {
    try {
      layerState._rowControlsListener?.();
    } catch (error) {
      console.warn('[Data:Satellites] row-controls listener failed:', error);
    }
  }

  /**
   * Per-class tally for the row legend, cached against the catalog revision.
   * Without the cache this scans ~10.7k entries in dense mode on every panel
   * refresh, and any layer polling on the 1s stats timer refreshes the panel.
   * @returns {Record<string, number>} Class key → count.
   */

  function _classTally() {
    if (
      layerState._classTallyCache.counts &&
      layerState._classTallyCache.revision === layerState._catalogRevision
    ) {
      return layerState._classTallyCache.counts;
    }
    const entries = [];
    // Pass the ISS flag, not just the group: during a stations-feed outage the
    // ISS is ingested as `visual`, and the legend must file it exactly where its
    // card does (STATION) rather than letting STATION vanish from the legend.
    for (const [noradId, sat] of layerState._catalog) {
      entries.push({ group: sat.group, isIss: noradId === ISS_NORAD });
    }
    const counts = tallySatelliteClasses(entries);
    layerState._classTallyCache = {
      revision: layerState._catalogRevision,
      counts,
    };
    return counts;
  }

  /**
   * Satellite preferences may be restored while the layer is disabled (for
   * example, when Space Missions releases its dependency). Preferences must not
   * revive render primitives until the layer is explicitly enabled again.
   * @param {boolean} layerEnabled Whether the Satellite layer is enabled.
   * @param {boolean} requestedVisible Whether the current presentation requests visibility.
   * @returns {boolean} Whether a primitive should be visible now.
   */

  function satelliteVisualsVisible(layerEnabled, requestedVisible) {
    return Boolean(layerEnabled) && Boolean(requestedVisible);
  }

  /**
   * Decide whether a valid catalog request represents a real mode transition.
   * Reapplying an already-active mode must not restart the dense TLE load.
   * @param {'core'|'dense'} currentCatalog Current catalog mode.
   * @param {string|undefined} requestedCatalog Requested catalog mode.
   * @returns {boolean} Whether the catalog mode should change.
   */

  function satelliteCatalogModeChanged(currentCatalog, requestedCatalog) {
    return (
      (requestedCatalog === 'core' || requestedCatalog === 'dense') &&
      requestedCatalog !== currentCatalog
    );
  }
  const methods = {
    id: 'satellites',

    name: 'Satellites',

    icon: '🛰️',

    source: 'CelesTrak',

    updateInterval: 0,
    // We use preRender for real-time updates, not interval polling
    refreshInterval: 5 * 60 * 1000,

    getDetectableObjects(options = {}) {
      if (!layerState._pointCollection || !layerState._pointCollection.show)
        return [];
      // Dense extras are points-only: excluded from the detection overlay.
      const eligibleCount = Math.max(
        1,
        layerState._points.size - layerState._denseIds.length,
      );
      const maxCount = Number.isFinite(options.maxCount)
        ? Math.max(1, Math.floor(options.maxCount))
        : eligibleCount;
      const seed = Number.isFinite(options.seed) ? Math.floor(options.seed) : 0;
      const stride = Math.max(1, Math.ceil(eligibleCount / maxCount));
      const start = seed % stride;

      const result = [];
      let idx = 0;
      for (const [noradId, point] of layerState._points) {
        if (
          layerState._denseIds.length > 0 &&
          layerState._catalog.get(noradId)?.group === 'dense'
        )
          continue;
        const shouldTake = (idx - start) % stride === 0;
        idx++;
        if (!shouldTake) continue;
        if (!point.position) continue;
        const isTracked = noradId === layerState._trackedNorad;
        // A docked companion sits at the tracked subject's own position, so its
        // mark and label would stack underneath the tracked card. It is listed on
        // that card instead. Only members of the tracked cluster are affected —
        // unrelated nearby satellites are never suppressed.
        if (!isTracked && layerState._dockedCompanions.has(noradId)) continue;
        const cat = layerState._catalog.get(noradId);
        let object = layerState._detectionObjects.get(noradId);
        if (!object) {
          object = {
            sourceId: noradId,
            id: cat?.name || `SAT-${noradId}`,
            type: 'SAT',
            // Human class ("NAV · GPS"), not the raw CelesTrak tag ("GPS-OPS").
            // The detection canvas composites ABOVE the post-FX chain, so this
            // is how class survives NVG/FLIR once the dot colors are collapsed.
            klass: satelliteClassLabel(cat?.group, {
              isIss: noradId === ISS_NORAD,
            }),
          };
          layerState._detectionObjects.set(noradId, object);
        }
        object.position = point.position;
        object.skipLabel = isTracked;
        result.push(object);
        if (result.length >= maxCount) break;
      }
      return result;
    },

    /**
     * Find a satellite by exact NORAD id (numeric string) or case-insensitive
     * name substring. Position is freshly propagated via SGP4.
     * @param {string|number} query NORAD id or partial name.
     * @returns {{ noradId: number, name: string, position: Cesium.Cartesian3, latitude: number, longitude: number, altitudeM: number }|null}
     */
    findByQuery(query) {
      if (
        query === null ||
        query === undefined ||
        !layerState._catalog ||
        layerState._catalog.size === 0
      )
        return null;
      const q = String(query).trim();
      if (!q) return null;

      let noradId = null;
      if (/^\d+$/.test(q) && layerState._catalog.has(Number(q))) {
        noradId = Number(q);
      } else {
        const lower = q.toLowerCase();
        for (const [id, sat] of layerState._catalog) {
          if (sat.name.toLowerCase().includes(lower)) {
            noradId = id;
            break;
          }
        }
      }
      if (noradId === null) return null;

      const sat = layerState._catalog.get(noradId);
      const pos = parts.orbits.propagatePosition(sat.satrec, new Date());
      if (!pos) return null;

      return {
        noradId,
        name: sat.name.trim(),
        position: Cesium.Cartesian3.fromDegrees(
          pos.longitude,
          pos.latitude,
          pos.altitude,
        ),
        latitude: pos.latitude,
        longitude: pos.longitude,
        altitudeM: pos.altitude,
      };
    },

    /**
     * Get positions of currently rendered satellites from per-point state
     * (no SGP4 re-propagation).
     * @param {number} [maxCount=300] Maximum entries to return.
     * @returns {Array<{ id: number, label: string, position: Cesium.Cartesian3, latitude: number, longitude: number, altitudeM: number }>}
     */
    getAllPositions(maxCount = 300) {
      const result = [];
      if (!layerState._points || layerState._points.size === 0) return result;
      const cap =
        Number.isFinite(maxCount) && maxCount > 0 ? Math.floor(maxCount) : 300;

      for (const [noradId, point] of layerState._points) {
        if (result.length >= cap) break;
        if (!point.position) continue;
        // Dense extras are points-only — keep voice/framing lists to the core catalog.
        if (
          layerState._denseIds.length > 0 &&
          layerState._catalog.get(noradId)?.group === 'dense'
        )
          continue;
        const carto = Cesium.Cartographic.fromCartesian(point.position);
        if (!carto) continue;
        const sat = layerState._catalog.get(noradId);
        result.push({
          id: noradId,
          label: sat ? sat.name.trim() : String(noradId),
          position: point.position,
          latitude: Cesium.Math.toDegrees(carto.latitude),
          longitude: Cesium.Math.toDegrees(carto.longitude),
          altitudeM: carto.height,
        });
      }
      return result;
    },

    /**
     * Track a satellite by NORAD id (camera follow + orbit path + highlight),
     * same path as clicking its point.
     * @param {string|number} noradId NORAD catalog number.
     * @returns {boolean} True if tracking started.
     */
    trackById(noradId, { origin = 'programmatic' } = {}) {
      const id = Number(noradId);
      if (
        !Number.isFinite(id) ||
        !layerState._viewer ||
        !layerState._catalog.has(id) ||
        !layerState._points.has(id)
      )
        return false;
      parts.tracking._cancelPendingTrackingRestore();
      parts.tracking._trackSatellite(id, { origin });
      return layerState._trackedNorad === id;
    },

    /**
     * Resolve a shared Follow target only after the applicable CelesTrak
     * catalog has settled. A partial catalog can prove presence, never absence.
     */
    async resolveTrackingRestoreTarget(
      noradId,
      { signal = null, origin = 'share-restore' } = {},
    ) {
      if (signal?.aborted)
        return {
          status: 'cancelled',
          reason: String(signal.reason || 'aborted'),
        };
      const id = parts.tracking._normalizeTrackedNorad(noradId);
      if (id === null) return { status: 'missing', reason: 'invalid-target' };
      const outcome = layerState._lastTrackingRefreshOutcome;
      const found = () =>
        layerState._catalog.has(id) && layerState._points.has(id);
      const follow = () => {
        if (signal?.aborted)
          return {
            status: 'cancelled',
            reason: String(signal.reason || 'aborted'),
          };
        return this.trackById(id, { origin })
          ? { status: 'found', refreshEpoch: outcome.epoch }
          : {
              status: 'source-unavailable',
              reason: 'target-not-renderable',
              refreshEpoch: outcome.epoch,
            };
      };

      if (found()) return follow();
      if (outcome.status !== 'accepted' && outcome.status !== 'partial') {
        return {
          status: 'source-unavailable',
          reason: 'CelesTrak catalog unavailable',
          refreshEpoch: outcome.epoch,
        };
      }

      if (layerState._params.catalog === 'dense') {
        const dense = await (layerState._denseLoadPromise ||
          Promise.resolve({ status: 'source-unavailable' }));
        if (signal?.aborted)
          return {
            status: 'cancelled',
            reason: String(signal.reason || 'aborted'),
          };
        if (layerState._lastTrackingRefreshOutcome.epoch !== outcome.epoch) {
          return { status: 'superseded', reason: 'newer-catalog-refresh' };
        }
        if (found()) return follow();
        if (dense?.status !== 'ready') {
          return {
            status: 'source-unavailable',
            reason: dense?.reason || 'dense catalog unavailable',
            refreshEpoch: outcome.epoch,
          };
        }
      }

      if (outcome.status === 'partial') {
        return {
          status: 'source-unavailable',
          reason: 'partial CelesTrak catalog cannot prove absence',
          refreshEpoch: outcome.epoch,
          failedGroups: [...outcome.failedGroups],
        };
      }
      return {
        status: 'missing',
        reason: 'target-absent-from-catalog',
        refreshEpoch: outcome.epoch,
      };
    },

    /**
     * Stop tracking the currently tracked satellite (no-op if none).
     * @returns {boolean} Always true.
     */
    stopTracking({ origin = 'programmatic' } = {}) {
      parts.tracking._cancelPendingTrackingRestore();
      parts.tracking._clearTracking(false, { origin });
      return true;
    },

    cancelPendingTrackingRestore() {
      parts.tracking._cancelPendingTrackingRestore();
    },

    /**
     * Get info about the currently tracked satellite.
     * @returns {{ noradId: number, name: string, latitude: number, longitude: number, altitudeM: number }|null}
     */
    getTrackedInfo() {
      if (
        layerState._trackedNorad === null ||
        !layerState._catalog.has(layerState._trackedNorad)
      )
        return null;
      const sat = layerState._catalog.get(layerState._trackedNorad);
      // Per-frame cache (WS-D2) — same epoch as the dot/label/camera this frame.
      const pos = parts.tracking._getTrackedFramePosition();
      if (!pos) return null;
      return {
        noradId: layerState._trackedNorad,
        name: sat.name.trim(),
        latitude: pos.latitude,
        longitude: pos.longitude,
        altitudeM: pos.altitude,
      };
    },

    /**
     * Runtime params (DataLayerManager.setLayerParams path).
     * catalog: 'core' (default, ~840 sats) | 'dense' (adds the Starlink shell
     * as points-only extras on a relaxed propagation budget).
     * @param {{ catalog?: 'core'|'dense', showPoints?: boolean, showOrbits?: boolean, selectedSatTrackingId?: number|null }} [params]
     */
    setParams(params = {}, { origin = 'programmatic' } = {}) {
      if (
        isExplicitLayerStateOrigin(origin) &&
        !Object.hasOwn(params, 'selectedSatTrackingId')
      ) {
        parts.tracking._cancelPendingTrackingRestore();
      }
      const catalog = params.catalog;
      if (catalog !== undefined && catalog !== 'core' && catalog !== 'dense')
        return false;
      const catalogChanged = satelliteCatalogModeChanged(
        layerState._params.catalog,
        catalog,
      );
      if (catalogChanged) {
        layerState._params.catalog = catalog;
      }
      if (params.showPoints !== undefined) {
        layerState._params.showPoints = params.showPoints !== false;
        if (layerState._pointCollection)
          layerState._pointCollection.show = satelliteVisualsVisible(
            layerState._enabled,
            layerState._params.showPoints,
          );
      }
      if (params.showOrbits !== undefined) {
        layerState._params.showOrbits = params.showOrbits !== false;
        for (const path of layerState._orbitPaths.values())
          path.primitive.show = satelliteVisualsVisible(
            layerState._enabled,
            layerState._params.showOrbits,
          );
        parts.labels._syncIssOverlay();
      }
      if (catalogChanged && catalog === 'dense') {
        layerState._denseLoadPromise = parts.catalog._loadDenseCatalog();
      } else if (catalog === 'core') {
        if (catalogChanged) parts.catalog._removeDenseCatalog();
        // Any explicit request for core clears the error, even when the mode did
        // NOT change: a failed dense load already reverted the param to core, so
        // a Space Missions restore of an already-core snapshot would otherwise
        // leave the user staring at a DENSE ✕ they never caused.
        layerState._denseStatus = 'idle';
        layerState._denseError = null;
      }
      if (catalogChanged)
        console.log(`[Data:Satellites] Catalog mode: ${catalog}`);
      if (Object.hasOwn(params, 'selectedSatTrackingId')) {
        const requested = parts.tracking._normalizeTrackedNorad(
          params.selectedSatTrackingId,
        );
        if (requested === layerState._trackedNorad) {
          layerState._pendingTrackingRestore = null;
        } else if (requested === null) {
          parts.tracking._cancelPendingTrackingRestore();
          if (layerState._trackedNorad !== null)
            parts.tracking._clearTracking(false, { origin });
        } else {
          const generation = ++layerState._trackingIntentGeneration;
          layerState._pendingTrackingRestore = {
            id: requested,
            generation,
            origin,
          };
          if (layerState._trackedNorad !== null)
            parts.tracking._clearTracking(false, { origin });
          parts.tracking._applyPendingTrackingRestore();
        }
      }
      return true;
    },

    /** @returns {{ catalog: string }} Current runtime params. */
    getParams() {
      return {
        catalog: layerState._params.catalog,
        showPoints: layerState._params.showPoints,
        showOrbits: layerState._params.showOrbits,
        selectedSatTrackingId: layerState._trackedNorad,
      };
    },

    /**
     * Layer-row sub-controls (DataLayerManager row-controls contract): the DENSE
     * catalog chip plus a class legend so the point colors are learnable without
     * a new panel.
     *
     * The chip is stateless — it declares the params to apply and the manager
     * owns the write, so the Space Missions snapshot/restore path (which drives
     * the same `catalog` param) stays the single source of truth and the chip
     * always renders whatever the layer actually has.
     *
     * The chip reports the dense LOAD state, not the catalog param: the param
     * flips synchronously while the Starlink shell takes seconds to arrive and
     * frequently 502s, so ACTIVE means "dense points are on screen" and nothing
     * less. The legend tally is cached against the catalog revision.
     * @returns {{ chips: Array<object>, legend: Array<object> }} Row controls.
     */
    getRowControls() {
      // A dependency owner (Space Missions) borrows this layer for TLE lookup
      // with showPoints:false. Nothing is rendered, so a legend would describe an
      // empty sky and a chip write would be silently reverted by that owner's
      // restore. Surrender the row rather than lie about it.
      if (!layerState._params.showPoints) return { chips: [], legend: [] };

      const loading = layerState._denseStatus === 'loading';
      const failed = layerState._denseStatus === 'failed';
      const active =
        layerState._params.catalog === 'dense' &&
        layerState._denseStatus === 'ready';
      let title =
        'Add the full Starlink broadband shell (thousands of extra points)';
      if (loading) title = 'Loading the Starlink shell…';
      else if (failed)
        title = `Starlink ${layerState._denseError || 'load failed'} — click to retry`;
      else if (active)
        title =
          'Showing the full Starlink shell — click for the core catalog only';
      return {
        chips: [
          {
            id: 'catalog',
            label: loading ? 'DENSE ···' : failed ? 'DENSE ✕' : 'DENSE',
            active,
            busy: loading,
            disabled: loading,
            state: loading
              ? 'loading'
              : failed
                ? 'error'
                : active
                  ? 'active'
                  : 'idle',
            title,
            params: { catalog: active ? 'core' : 'dense' },
          },
        ],
        legend: satelliteClassLegend(_classTally()),
      };
    },

    /**
     * Install the manager's "row controls changed" callback. The dense load is
     * asynchronous, so completion and failure have to push a re-render — nothing
     * else would repaint this row before the 5-minute catalog refresh.
     * @param {(() => void)|null} listener Callback, or null to detach.
     */
    setRowControlsListener(listener) {
      layerState._rowControlsListener =
        typeof listener === 'function' ? listener : null;
    },

    getStats() {
      return {
        count: layerState._count,
        lastUpdate: layerState._lastUpdate,
        stale: false,
        status:
          layerState._lastError === 'CelesTrak unreachable'
            ? 'unavailable'
            : layerState._lastError
              ? 'degraded'
              : 'nominal',
        error: layerState._lastError,
      };
    },
  };

  return {
    _pointStyleFor,
    _notifyRowControls,
    _classTally,
    satelliteVisualsVisible,
    satelliteCatalogModeChanged,
    methods,
  };
}
