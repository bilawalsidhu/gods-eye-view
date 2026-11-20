import { createCountMarkers } from './countMarkers.js';
import { createIconBook } from '../../render/motion/iconBook.js';

/** A draw set that draws nothing, for the icon book the tests read. */
const testIconSet = () => ({
  id: 'cctv:test:icons',
  show: true,
  upsert() {},
  remove() {},
  dispose() {},
});

export function createTesting({ state: layerState, services, parts, source }) {
  /** Test seam: republishes host entries through the real push path, so tests
   * can observe the pristine module default without touching the setter. */

  function _pushAmbientCardEntriesForTest() {
    parts.cards.pushAmbientCardEntries();
  }

  /** Test seam for exercising real layer lifecycle paths without a DOM host. */

  function _setCctvOverlayHostForTest(host = null) {
    layerState._cctvOverlayHost = host
      ? { ...layerState.DEFAULT_CCTV_OVERLAY_HOST, ...host }
      : layerState.DEFAULT_CCTV_OVERLAY_HOST;
    layerState._projectionOverlayOwnerId = null;
  }

  /**
   * Create the production monitor-plane/host-label pair without media setup.
   * @param {Object} viewer Viewer whose renderer draws the plane.
   * @param {Object} record CCTV runtime record.
   * @returns {Object} Projection runtime.
   */

  function _createCctvProjectionPlaneForTest(viewer, record) {
    layerState._viewer = viewer;
    const geometry =
      record.frustumGeometry ||
      parts.geometry.computeFrustumGeometry(
        record.camera,
        parts.ground.groundAltFor(record),
        record.probeClampRangeM,
      );
    const positions =
      record.frustumPositions || parts.rendering.frustumCartesians(geometry);
    record.frustumGeometry = geometry;
    record.frustumPositions = positions;
    const runtime = {
      cameraId: String(record.camera.id),
      plane: null,
      // createProjectionPlane gives it its label position.
      labelPosition: null,
      overlayEntry: null,
      planeSource: parts.projection.plainPlaneSource(),
    };
    parts.projection.createProjectionPlane(
      record,
      runtime,
      geometry,
      positions,
    );
    record.projection = runtime;
    return runtime;
  }

  /**
   * Exercise the production geometry-to-plane-and-label cache update.
   * @param {Object} record CCTV runtime record.
   */

  function _updateCctvProjectionPlaneForTest(record) {
    parts.projection.updatePlanePlacement(record);
  }

  /** Test-only seam for the CCTV ownership proof used by the world-click route. */

  function _extractPickedCameraIdForTest(picked) {
    return parts.selection.extractPickedCameraId(picked);
  }

  /**
   * Primes the minimum module state needed to exercise the production coverage
   * refresh path in unit tests.
   * @param {Object} [options={}] Test state values.
   * @param {Object|null} [options.viewer] Viewer-like entity owner.
   * @param {Object[]} [options.records] Seeded CCTV records.
   * @param {string|null} [options.activeCameraId] Active record id.
   * @param {boolean} [options.enabled=true] Layer enabled state.
   * @param {'off'|'on'|'viewshed'} [options.coverageMode='on'] Coverage mode.
   * @param {boolean} [options.showProjection=false] Projection visibility.
   * @param {Map<string, Object>} [options.healthById] Health rows by camera id.
   * @param {Function} [options.registerPaintLane] Receives the count painter.
   * @returns {void}
   */

  function _setCctvCoverageStateForTest({
    viewer = null,
    records = [],
    activeCameraId = null,
    enabled = true,
    coverageMode = 'on',
    showProjection = false,
    healthById = new Map(),
    openingCameraProvisional = false,
    registerPaintLane,
  } = {}) {
    layerState._viewer = viewer;
    layerState._records = Array.isArray(records) ? records : [];
    layerState._recordById = new Map(
      layerState._records
        .filter((record) => record?.camera?.id)
        .map((record) => [record.camera.id, record]),
    );
    layerState._coverageEntities = [];
    layerState._projectionEntities = [];
    layerState._activeCameraId = activeCameraId;
    layerState._autoHopSuspended = false;
    layerState._openingCameraProvisional = !!openingCameraProvisional;
    layerState._enabled = !!enabled;
    layerState._coverageMode = parts.model.normalizeCoverageMode(
      coverageMode,
      'on',
    );
    layerState._showProjection = !!showProjection;
    layerState._healthById = healthById;
    layerState._viewRecords = [];
    layerState._pickerRecords = [];
    layerState._cameraIndexCache = null;
    layerState._coverageVisibleIds = new Set();
    layerState._neighborCountCache = null;
    layerState._coverageCohort = null;
    // A real book (over a set that draws nothing): every record gets its
    // icon as init adds it.
    layerState._icons = createIconBook(testIconSet());
    layerState._counts?.dispose();
    layerState._counts = createCountMarkers(
      registerPaintLane,
      'cctv:test:counts',
      parts.rendering.refreshHorizonCulling,
    );
    for (const record of layerState._records)
      if (record?.camera?.id) parts.rendering.addCameraIcon(record);
  }

  /**
   * What the layer draws now, for the QA harness: the gizmo's parts, the
   * coverage lines and monitor planes by item id, the viewshed volumes'
   * ids, and how many volumes were ever written.
   */

  function _cctvDrawnForTest() {
    const coverage = {};
    for (const record of layerState._records)
      for (const line of record.coverageEntities || [])
        if (line?.id) coverage[line.id] = line;
    const planes = {};
    for (const runtime of layerState._projectionEntities)
      if (runtime?.plane) planes[runtime.plane.id] = runtime.plane;
    return {
      counts: layerState._counts,
      gizmo: layerState._gizmo?.partsForTest() ?? {},
      coverage,
      planes,
      viewsheds: layerState._records
        .map((record) => record.viewshedVolume)
        .filter(Boolean),
      viewshedWrites: parts.drawSets.volumeWritesForTest(),
    };
  }

  /** The layer's icon book, for tests that read what the icons draw. */

  function _cctvIconsForTest() {
    return layerState._icons;
  }
  return {
    _pushAmbientCardEntriesForTest,
    _setCctvOverlayHostForTest,
    _createCctvProjectionPlaneForTest,
    _updateCctvProjectionPlaneForTest,
    _extractPickedCameraIdForTest,
    _setCctvCoverageStateForTest,
    _cctvIconsForTest,
    _cctvDrawnForTest,
  };
}
