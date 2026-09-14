import * as Cesium from 'cesium';
import { ISS_NORAD, ISS_OVERLAY_SOURCE_ID } from './policy.js';

export function createTesting({ state: layerState, services, parts, source }) {
  /**
   * Seed a single tracked satellite so tests can invoke the exact production
   * pre-render callback without constructing a WebGL viewer.
   * @param {object} state
   * @param {number} state.noradId
   * @param {string} state.name
   * @param {object} state.satrec
   * @param {object} state.entity
   * @param {object} state.point
   * @param {object} state.viewer
   * @param {() => (number|Date)} state.now
   */

  function _setTrackedSatelliteRefreshStateForTest({
    noradId,
    name,
    satrec,
    entity,
    point,
    viewer,
    now,
    // Extra catalog/point rows so a test can exercise a docked cluster (and a
    // control satellite that must NOT be treated as part of it).
    neighbours = [],
  }) {
    layerState._viewer = viewer;
    layerState._catalog = new Map([
      [noradId, { name, satrec, group: 'stations' }],
    ]);
    layerState._points = new Map([[noradId, point]]);
    for (const neighbour of neighbours) {
      layerState._catalog.set(neighbour.noradId, {
        name: neighbour.name,
        satrec: neighbour.satrec || satrec,
        group: neighbour.group || 'stations',
      });
      layerState._points.set(neighbour.noradId, neighbour.point);
    }
    layerState._dockedCompanions = new Set();
    layerState._lastDockedScanMs = Number.NEGATIVE_INFINITY;
    layerState._trackedNorad = noradId;
    layerState._trackedEntity = entity;
    layerState._trackedFrameNumber = -1;
    layerState._trackedFrameGeo = null;
    layerState._trackedFrameNowForTest = now;
    layerState._params = {
      catalog: 'core',
      showPoints: false,
      showOrbits: false,
    };
    layerState._enabled = true;
  }

  /** Seed catalog authority and optional dense settlement for share-Follow tests. */

  function _setSatelliteTrackingRefreshOutcomeForTest({
    status = 'accepted',
    failedGroups = [],
    catalog = 'core',
    densePromise = null,
  } = {}) {
    const epoch = ++layerState._trackingRefreshEpoch;
    layerState._lastTrackingRefreshOutcome = {
      epoch,
      status,
      failedGroups: [...failedGroups],
    };
    layerState._params.catalog = catalog;
    layerState._denseLoadPromise =
      densePromise || Promise.resolve({ status: 'not-requested' });
  }

  /** The tracked satellite's current ECEF sample — the value the docked-cluster
   *  scan measures against. Exposed so a test can place neighbours around it. */

  function _trackedFrameCartesianForTest() {
    return layerState._trackedFrameCartesian;
  }

  /** Invoke the same callback registered on `scene.preRender` in production. */

  function _runSatellitePreRenderForTest() {
    parts.rendering._preRenderTick();
  }

  /**
   * Seed the minimum render state a dense-catalog load needs, so a test can
   * exercise the real async load/settle/fail path (and the row-control states it
   * drives) without constructing a WebGL viewer.
   * @param {{ catalog?: 'core'|'dense', showPoints?: boolean }} [options]
   */

  function _setDenseCatalogStateForTest({
    catalog = 'core',
    showPoints = true,
  } = {}) {
    layerState._viewer = {
      scene: { primitives: { add: (p) => p, remove() {} } },
    };
    // Neutralize the shared world-overlay host: these tests exercise catalog and
    // row-control logic, not the ISS callout.
    layerState._overlayHost = {
      setEntries() {},
      setVisible() {},
      clearSource() {},
    };
    layerState._pointCollection = {
      show: true,
      add: (opts) => ({ ...opts }),
      remove() {},
      removeAll() {},
    };
    layerState._catalog = new Map();
    layerState._points = new Map();
    layerState._detectionObjects = new Map();
    layerState._orbitPaths = new Map();
    layerState._denseIds = [];
    layerState._denseCursor = 0;
    layerState._denseLoadToken++;
    layerState._denseStatus = 'idle';
    layerState._denseError = null;
    layerState._catalogRevision++;
    layerState._trackedNorad = null;
    parts.tracking._cancelPendingTrackingRestore();
    layerState._params = { catalog, showPoints, showOrbits: false };
    layerState._enabled = true;
  }

  /** Tear the dense seam back down so ordering cannot leak into other tests. */

  function _clearDenseCatalogStateForTest() {
    layerState._rowControlsListener = null;
    layerState._overlayHost = layerState.DEFAULT_OVERLAY_HOST;
    layerState._orbitPaths = new Map();
    layerState._viewer = null;
    layerState._pointCollection = null;
    layerState._catalog = new Map();
    layerState._points = new Map();
    layerState._denseIds = [];
    layerState._denseLoadToken++;
    layerState._denseStatus = 'idle';
    layerState._denseError = null;
    layerState._params = {
      catalog: 'core',
      showPoints: true,
      showOrbits: true,
    };
    parts.tracking._cancelPendingTrackingRestore();
    layerState._enabled = false;
  }

  /** Catalog group tag recorded for a satellite, for ingestion-path assertions. */

  function _catalogGroupForTest(noradId) {
    return layerState._catalog.get(Number(noradId))?.group;
  }

  /** Seed ISS/tracking state while retaining the production track and host paths. */

  function _setSatelliteLabelLifecycleStateForTest({
    viewer,
    satrec,
    point,
    overlayHost,
    preservePending = false,
  }) {
    layerState._viewer = viewer;
    layerState._catalog = new Map([
      [ISS_NORAD, { name: 'ISS (ZARYA)', satrec, group: 'stations' }],
    ]);
    layerState._points = new Map([[ISS_NORAD, point]]);
    layerState._orbitPaths = new Map([
      [
        ISS_NORAD,
        {
          primitive: { show: true, modelMatrix: new Cesium.Matrix4() },
          gmstAtBake: 0,
        },
      ],
    ]);
    layerState._trackedNorad = null;
    layerState._trackedEntity = null;
    if (!preservePending) parts.tracking._cancelPendingTrackingRestore();
    layerState._trackedFrameNumber = -1;
    layerState._trackedFrameGeo = null;
    layerState._enabled = true;
    layerState._params = {
      catalog: 'core',
      showPoints: true,
      showOrbits: true,
    };
    layerState._overlayHost = overlayHost || layerState.DEFAULT_OVERLAY_HOST;
    parts.labels._syncIssOverlay();
  }

  /** Exercise production ISS tracking from the cached catalog and point. */

  function _trackIssForTest() {
    parts.tracking._trackSatellite(ISS_NORAD);
    return layerState._trackedEntity;
  }

  /** Return the deferred restore target held by the production tracker. */

  function _pendingSatelliteTrackingRestoreForTest() {
    return layerState._pendingTrackingRestore?.id ?? null;
  }

  /** Exercise the production deferred-restore retry after a simulated catalog refresh. */

  function _applyPendingSatelliteTrackingRestoreForTest() {
    return parts.tracking._applyPendingTrackingRestore();
  }

  /** Remove a cached catalog row so tests can model a target arriving later. */

  function _removeSatelliteTrackingCandidateForTest(noradId) {
    const id = Number(noradId);
    layerState._catalog.delete(id);
    layerState._points.delete(id);
  }

  /** Exercise production untrack and restore the default host seam. */

  function _clearSatelliteLabelLifecycleForTest() {
    parts.tracking._clearTracking();
    layerState._enabled = false;
    layerState._overlayHost.clearSource(ISS_OVERLAY_SOURCE_ID);
    layerState._overlayHost.setVisible(ISS_OVERLAY_SOURCE_ID, false);
    layerState._overlayHost = layerState.DEFAULT_OVERLAY_HOST;
  }
  return {
    _setTrackedSatelliteRefreshStateForTest,
    _setSatelliteTrackingRefreshOutcomeForTest,
    _trackedFrameCartesianForTest,
    _runSatellitePreRenderForTest,
    _setDenseCatalogStateForTest,
    _clearDenseCatalogStateForTest,
    _catalogGroupForTest,
    _setSatelliteLabelLifecycleStateForTest,
    _trackIssForTest,
    _pendingSatelliteTrackingRestoreForTest,
    _applyPendingSatelliteTrackingRestoreForTest,
    _removeSatelliteTrackingCandidateForTest,
    _clearSatelliteLabelLifecycleForTest,
  };
}
