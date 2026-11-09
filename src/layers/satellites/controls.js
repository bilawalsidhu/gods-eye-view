import { satelliteClassText } from '../../data/satelliteClass.js';
import { decodeSatelliteClassMask } from '../../data/satelliteClassMask.js';
import * as Cesium from 'cesium';
import { t } from '../../i18n/index.js';
import {
  DEFAULT_SATELLITE_CLASSES,
  SATELLITE_CLASS_DISPLAY,
  SATELLITE_CLASS_IDS,
  mergeClassVisibility,
} from './classes.js';
import { ISS_NORAD, POINT_STYLES, classPointStyle } from './policy.js';

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
    return classPointStyle(
      group,
      layerState._catalog.get(noradId)?.satelliteClass,
    );
  }

  /** The class-visibility choice, defaults filled in. */
  function _classes() {
    return layerState._params.classes || DEFAULT_SATELLITE_CLASSES;
  }

  /**
   * Whether a satellite's class is shown. Starlink follows the catalog mode:
   * its points exist only in dense mode. An unclassed entry shows.
   * @param {number} noradId NORAD catalog number.
   */
  function _classVisible(noradId) {
    const satelliteClass = layerState._catalog.get(noradId)?.satelliteClass;
    if (!satelliteClass) return true;
    if (satelliteClass === 'starlink')
      return layerState._params.catalog === 'dense';
    return _classes()[satelliteClass] === true;
  }

  /**
   * Show or hide every point by its class. The tracked satellite's point
   * stays hidden (its entity draws the dot), as do points a Cockpit hold hid.
   * The ISS's ring and label go with its class.
   */
  function _applyClassVisibility() {
    for (const [noradId, point] of layerState._points) {
      if (noradId === layerState._trackedNorad) continue;
      if (layerState._cockpitHiddenPoints?.has(noradId)) continue;
      point.show = _classVisible(noradId);
    }
    _syncIssOrbit();
    parts.labels?._syncIssOverlay?.();
    layerState._detectionObjects.clear();
  }

  /**
   * Whether the ISS's ring shows: orbits on, the layer drawing, and its
   * class on or the ISS tracked (a tracked satellite keeps its ring).
   */
  function _issOrbitVisible() {
    return (
      satelliteVisualsVisible(
        layerState._enabled,
        layerState._params.showOrbits,
      ) &&
      (_classVisible(ISS_NORAD) || layerState._trackedNorad === ISS_NORAD)
    );
  }

  /** Show or hide the ISS's ring by _issOrbitVisible, if it is built. */
  function _syncIssOrbit() {
    const issPath = layerState._orbitPaths.get(ISS_NORAD);
    if (issPath) issPath.primitive.show = _issOrbitVisible();
  }

  /**
   * The row's info line while the classes rest on old or missing SATCAT
   * evidence (`_satcatState`), and an empty one otherwise.
   * @returns {{info: string, infoTitle: string}}
   */
  function classEvidenceNotice() {
    const evidence = layerState._satcatState;
    if (evidence !== 'stale' && evidence !== 'unavailable')
      return { info: '', infoTitle: '' };
    return {
      info:
        evidence === 'stale'
          ? t('Classes may lag: SATCAT is a cached copy')
          : t('Classes may lag: SATCAT unavailable'),
      infoTitle: t(
        "CelesTrak SATCAT gives each object's type and status. Without a current copy the classes rest on the UCS database, names and CelesTrak groups, so a satellite that has died since may still show as working.",
      ),
    };
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
    const counts = Object.create(null);
    for (const sat of layerState._catalog.values()) {
      const satelliteClass = sat.satelliteClass || 'probes';
      counts[satelliteClass] = (counts[satelliteClass] || 0) + 1;
    }
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
  /** The STARLINK chip: the dense catalog, with its load state. */
  function _starlinkChip() {
    const loading = layerState._denseStatus === 'loading';
    const failed = layerState._denseStatus === 'failed';
    const active =
      layerState._params.catalog === 'dense' &&
      layerState._denseStatus === 'ready';
    let title = t(
      'Add the full Starlink broadband shell (thousands of extra points)',
    );
    if (loading) title = t('Loading the Starlink shell…');
    else if (failed)
      title = t('Starlink {detail} — click to retry', {
        detail: layerState._denseError || t('load failed'),
      });
    else if (active)
      title = t(
        'Showing the full Starlink shell — click for the core catalog only',
      );
    return {
      id: 'catalog',
      label: loading
        ? t('STARLINK ···')
        : failed
          ? t('STARLINK ✕')
          : t('STARLINK'),
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
    };
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
        // A hidden class is not on screen, so nothing is bracketed on it.
        if (!isTracked && !_classVisible(noradId)) continue;
        // A docked companion sits at the tracked subject's own position, so its
        // mark and label would stack underneath the tracked card. It is listed on
        // that card instead. Only members of the tracked cluster are affected —
        // unrelated nearby satellites are never suppressed.
        if (!isTracked && layerState._dockedCompanions.has(noradId)) continue;
        // The Cockpit camera rides a held subject; a bracket on it would sit
        // on the lens.
        if (isTracked && parts.cockpit?._cockpitHeld()) continue;
        const cat = layerState._catalog.get(noradId);
        let object = layerState._detectionObjects.get(noradId);
        if (!object) {
          object = {
            sourceId: noradId,
            id: cat?.name || `SAT-${noradId}`,
            type: 'SAT',
          };
          layerState._detectionObjects.set(noradId, object);
        }
        // Human class ("TELECOM · GPS"), not the raw CelesTrak tag
        // ("GPS-OPS"). The detection canvas composites ABOVE the post-FX
        // chain, so this is how class survives NVG/FLIR once the dot colors
        // are collapsed. Read each time: SATCAT can reclassify a satellite.
        object.klass = satelliteClassText(cat?.satelliteClass, cat?.group, {
          isIss: noradId === ISS_NORAD,
        });
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
      const pos = parts.orbits.propagatePosition(
        sat.satrec,
        new Date(layerState.now()),
      );
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
        if (!_classVisible(noradId)) continue;
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
     * The shown satellites nearest a position, nearest first, from per-point
     * state (no SGP4 re-propagation): a bounded pass that keeps only the
     * nearest `maxCount`, and reads latitude and longitude for those alone.
     * Dense extras are left out, as in `getAllPositions`.
     * @param {Cesium.Cartesian3} center Earth-fixed position.
     * @param {number} [maxCount=8] Most entries to return.
     * @param {{excludeIds?: Array<number|string>,
     *   excludeClasses?: Array<string>}} [options] Satellites, and classes
     *   (e.g. 'debris'), to leave out.
     * @returns {Array<{ id: number, label: string, position: Cesium.Cartesian3, latitude: number, longitude: number, altitudeM: number, satelliteClass: string|null, distanceM: number }>}
     */
    getNearestPositions(
      center,
      maxCount = 8,
      { excludeIds = [], excludeClasses = [] } = {},
    ) {
      const nearest = [];
      const cap = Number.isFinite(maxCount) ? Math.floor(maxCount) : 8;
      if (
        cap < 1 ||
        !center ||
        !layerState._points ||
        layerState._points.size === 0
      )
        return nearest;
      const excluded = new Set(excludeIds.map(String));
      const classes = new Set(excludeClasses);
      const dense = layerState._denseIds.length > 0;
      for (const [noradId, point] of layerState._points) {
        const p = point.position;
        if (!p || excluded.has(String(noradId))) continue;
        if (!_classVisible(noradId)) continue;
        const sat = layerState._catalog.get(noradId);
        if (dense && sat?.group === 'dense') continue;
        if (classes.size && classes.has(sat?.satelliteClass)) continue;
        const dx = p.x - center.x;
        const dy = p.y - center.y;
        const dz = p.z - center.z;
        const distanceSq = dx * dx + dy * dy + dz * dz;
        if (nearest.length === cap && distanceSq >= nearest[cap - 1].distanceSq)
          continue;
        // Insertion into a short sorted list: no copy or sort of the rest.
        let at = nearest.length;
        while (at > 0 && nearest[at - 1].distanceSq > distanceSq) at -= 1;
        nearest.splice(at, 0, { noradId, point, sat, distanceSq });
        if (nearest.length > cap) nearest.pop();
      }
      const result = [];
      for (const { noradId, point, sat, distanceSq } of nearest) {
        const carto = Cesium.Cartographic.fromCartesian(point.position);
        if (!carto) continue;
        result.push({
          id: noradId,
          label: sat ? sat.name.trim() : String(noradId),
          position: point.position,
          latitude: Cesium.Math.toDegrees(carto.latitude),
          longitude: Cesium.Math.toDegrees(carto.longitude),
          altitudeM: carto.height,
          satelliteClass: sat?.satelliteClass ?? null,
          distanceM: Math.sqrt(distanceSq),
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
     * catalog: 'core' (default, about 1,300 satellites from the CelesTrak
     * groups) | 'dense' (adds the Starlink shell as points-only extras on a
     * relaxed propagation budget). classes: which of the six classes show
     * (src/layers/satellites/classes.js); Starlink's toggle is the dense catalog.
     * @param {{ catalog?: 'core'|'dense', classes?: Record<string, boolean>, showPoints?: boolean, showOrbits?: boolean, selectedSatTrackingId?: number|null }} [params]
     */
    setParams(params = {}, { origin = 'programmatic' } = {}) {
      if (
        isExplicitLayerStateOrigin(origin) &&
        !Object.hasOwn(params, 'selectedSatTrackingId')
      ) {
        parts.tracking._cancelPendingTrackingRestore();
      }
      let catalog = params.catalog;
      if (catalog !== undefined && catalog !== 'core' && catalog !== 'dense')
        return false;
      // A saved or shared choice arrives as class letters (layerState.js).
      const requestedClasses =
        typeof params.classes === 'string'
          ? decodeSatelliteClassMask(params.classes)
          : params.classes;
      if (params.classes !== undefined) {
        if (!requestedClasses || typeof requestedClasses !== 'object')
          return false;
        // Starlink's toggle is the dense catalog: its points load on demand.
        if (
          typeof requestedClasses.starlink === 'boolean' &&
          catalog === undefined
        )
          catalog = requestedClasses.starlink ? 'dense' : 'core';
        layerState._params.classes = mergeClassVisibility(
          requestedClasses,
          _classes(),
        );
      }
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
        for (const [noradId, path] of layerState._orbitPaths)
          path.primitive.show =
            noradId === ISS_NORAD
              ? _issOrbitVisible()
              : satelliteVisualsVisible(
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
      if (params.classes !== undefined || catalogChanged) {
        layerState._params.classes = {
          ..._classes(),
          starlink: layerState._params.catalog === 'dense',
        };
        _applyClassVisibility();
      }
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
        classes: { ..._classes() },
        selectedSatTrackingId: layerState._trackedNorad,
      };
    },

    /**
     * Layer-row sub-controls (DataLayerManager row-controls contract): one
     * toggle chip per satellite class (src/layers/satellites/classes.js), and a legend
     * of the classes on screen so the point colours are learnable.
     *
     * Chips are stateless — each declares the params to apply and the manager
     * owns the write, so the Space Missions snapshot/restore path (which drives
     * the same `catalog` param) stays the single source of truth and a chip
     * always renders whatever the layer actually has.
     *
     * STARLINK is the dense catalog (chip id `catalog`) and reports the dense
     * LOAD state, not the param: the param flips synchronously while the shell
     * takes seconds to arrive and frequently 502s, so ACTIVE means "Starlink
     * points are on screen" and nothing less. The legend tally is cached
     * against the catalog revision. While SATCAT is stale or unavailable the
     * info line says the classes may lag (see `classEvidenceNotice`).
     * @returns {{ chips: Array<object>, legend: Array<object>, info: string,
     *   infoTitle: string }} Row controls.
     */
    getRowControls() {
      // A dependency owner (Space Missions) borrows this layer for TLE lookup
      // with showPoints:false. Nothing is rendered, so a legend would describe an
      // empty sky and a chip write would be silently reverted by that owner's
      // restore. Surrender the row rather than lie about it.
      if (!layerState._params.showPoints) return { chips: [], legend: [] };

      const classes = _classes();
      const chips = SATELLITE_CLASS_IDS.map((id) =>
        id === 'starlink'
          ? _starlinkChip()
          : {
              id: `class-${id}`,
              label: t(SATELLITE_CLASS_DISPLAY[id].label),
              active: classes[id] === true,
              state: classes[id] === true ? 'active' : 'idle',
              title: t(SATELLITE_CLASS_DISPLAY[id].blurb),
              params: { classes: { [id]: classes[id] !== true } },
            },
      );
      const counts = _classTally();
      const legend = [];
      for (const id of SATELLITE_CLASS_IDS) {
        const shown =
          id === 'starlink'
            ? layerState._params.catalog === 'dense'
            : classes[id] === true;
        if (!shown || !(counts[id] > 0)) continue;
        legend.push({
          klass: id,
          label: t(SATELLITE_CLASS_DISPLAY[id].label),
          color: SATELLITE_CLASS_DISPLAY[id].color,
          blurb: t(SATELLITE_CLASS_DISPLAY[id].blurb),
          count: counts[id],
        });
      }
      return { chips, legend, ...classEvidenceNotice() };
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
      const stale = Boolean(layerState._coreStale || layerState._denseStale);
      return {
        count: layerState._count,
        lastUpdate: layerState._lastUpdate,
        stale,
        status:
          layerState._lastError === 'CelesTrak unreachable'
            ? 'unavailable'
            : layerState._lastError
              ? 'degraded'
              : stale
                ? 'stale'
                : 'nominal',
        error: layerState._lastError,
        // SATCAT refines the classes; when it is stale or unavailable the
        // classes rest on UCS, names and groups alone.
        classEvidence: layerState._satcatState,
      };
    },
  };

  return {
    _pointStyleFor,
    _notifyRowControls,
    _classTally,
    _classVisible,
    _applyClassVisibility,
    _issOrbitVisible,
    _syncIssOrbit,
    satelliteVisualsVisible,
    satelliteCatalogModeChanged,
    methods,
  };
}
