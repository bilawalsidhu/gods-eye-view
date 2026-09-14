import * as Cesium from 'cesium';

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
   * @param {Object} viewer Cesium viewer seam.
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
      record.frustumPositions || parts.geometry.frustumCartesians(geometry);
    record.frustumGeometry = geometry;
    record.frustumPositions = positions;
    const runtime = {
      cameraId: String(record.camera.id),
      planeEntity: null,
      labelPosition: new Cesium.Cartesian3(),
      overlayEntry: null,
      planeMaterial: new Cesium.ColorMaterialProperty(Cesium.Color.WHITE),
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
   * @returns {void}
   */

  function _setCctvCoverageStateForTest({
    viewer = null,
    records = [],
    activeCameraId = null,
    enabled = true,
    coverageMode = 'on',
    showProjection = false,
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
    layerState._billboards = null;
    layerState._activeCameraId = activeCameraId;
    layerState._autoHopSuspended = false;
    layerState._enabled = !!enabled;
    layerState._coverageMode = parts.model.normalizeCoverageMode(
      coverageMode,
      'on',
    );
    layerState._showProjection = !!showProjection;
  }
  return {
    _pushAmbientCardEntriesForTest,
    _setCctvOverlayHostForTest,
    _createCctvProjectionPlaneForTest,
    _updateCctvProjectionPlaneForTest,
    _extractPickedCameraIdForTest,
    _setCctvCoverageStateForTest,
  };
}
