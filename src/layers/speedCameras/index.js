import * as Cesium from 'cesium';
import {
  LAYER_ID,
  REQUEST_DEBOUNCE_MS,
  MAX_VIEWPORT_DEGREES,
  MAX_RENDERED,
} from './policy.js';
import {
  snapSpeedCameraBox,
  boxContains,
  validateSpeedCameraSnapshot,
} from './records.js';
import {
  OVERLAY_SOURCE_ID,
  OVERLAY_COHORT_LIMIT,
  OVERLAY_COLLISION_CAPACITY,
  cameraAccent,
  createSpeedCameraOverlayEntry,
  selectSpeedCameraOverlayCohort,
  mapAnalystRecord,
} from './model.js';
export * from './model.js';
export { createSpeedCameraSource } from './source.js';

/**
 * Own one speed camera display and its viewport-bounded refresh lifecycle.
 * The pattern follows the ALPR layer: a settled view inside the last snapped
 * query box is a local re-filter, not a new request.
 */
export function createSpeedCamerasLayer({ source, overlayHost } = {}) {
  if (typeof source?.fetch !== 'function')
    throw new TypeError('Speed cameras require a fetch source');
  if (!overlayHost)
    throw new TypeError('Speed cameras require an overlay host');

  let _viewer = null;
  let _dataSource = null;
  let _request = null;
  let _pendingQueryBox = null;
  let _lastQueryBox = null;
  let _debounceTimer = null;
  let _moveEndRemove = null;
  let _records = [];
  let _count = 0;
  let _saturated = false;
  let _stale = false;
  let _status = 'idle';
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;

  function viewportBox(viewer) {
    const camera = viewer?.camera;
    const canvas = viewer?.scene?.canvas;
    if (typeof camera?.pickEllipsoid === 'function' && canvas) {
      const width = canvas.clientWidth || canvas.width;
      const height = canvas.clientHeight || canvas.height;
      if (!width || !height) return null;
      const focus = camera.pickEllipsoid(
        new Cesium.Cartesian2(width / 2, height / 2),
        viewer.scene.globe.ellipsoid,
      );
      if (!focus) return null;
      const location = Cesium.Cartographic.fromCartesian(focus);
      const range = Cesium.Cartesian3.distance(camera.positionWC, focus);
      const radius = Math.max(1000, 2 * range);
      const latitude = Cesium.Math.toDegrees(location.latitude);
      const longitude = Cesium.Math.toDegrees(location.longitude);
      const latSpan = radius / 111000;
      const lonSpan = latSpan / Math.cos(location.latitude);
      if (
        !Number.isFinite(latSpan + lonSpan) ||
        2 * Math.max(latSpan, lonSpan) > MAX_VIEWPORT_DEGREES ||
        Math.abs(latitude) + latSpan > 90 ||
        Math.abs(longitude) + lonSpan > 180
      )
        return null;
      return {
        south: latitude - latSpan,
        west: longitude - lonSpan,
        north: latitude + latSpan,
        east: longitude + lonSpan,
      };
    }
    // Rectangle-only viewers retain the same bounded-area contract.
    const rectangle = viewer?.camera?.computeViewRectangle(
      viewer.scene.globe.ellipsoid,
    );
    if (!rectangle) return null;
    const south = Cesium.Math.toDegrees(rectangle.south);
    const north = Cesium.Math.toDegrees(rectangle.north);
    const west = Cesium.Math.toDegrees(rectangle.west);
    const east = Cesium.Math.toDegrees(rectangle.east);
    if (
      !Number.isFinite(south + north + west + east) ||
      east <= west ||
      north - south > MAX_VIEWPORT_DEGREES ||
      east - west > MAX_VIEWPORT_DEGREES
    )
      return null;
    return { south, west, north, east };
  }

  function canReuse(box) {
    return (
      _lastQueryBox != null &&
      boxContains(_lastQueryBox, box) &&
      _records.length > 0
    );
  }

  /** Publish accepted records to the entity collection and overlay host. */
  function renderRecords() {
    if (!_dataSource) return;
    const accent = cameraAccent();
    const shown = _records.slice(0, MAX_RENDERED);
    const entities = [];
    const overlayEntries = [];
    for (const record of shown) {
      const position = Cesium.Cartesian3.fromDegrees(
        record.longitude,
        record.latitude,
      );
      entities.push(
        new Cesium.Entity({
          id: record.id,
          position,
          point: {
            pixelSize: 12,
            color: accent,
            outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
            outlineWidth: 1,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          },
          properties: {
            ...record,
          },
        }),
      );
      overlayEntries.push(
        createSpeedCameraOverlayEntry({
          id: record.id,
          position,
          maxspeedKph: record.maxspeedKph,
          accent: accent.toCssColorString(),
        }),
      );
    }
    _dataSource.entities.removeAll();
    for (const entity of entities) _dataSource.entities.add(entity);
    if (_enabled) {
      overlayHost.setEntries(
        OVERLAY_SOURCE_ID,
        selectSpeedCameraOverlayCohort(overlayEntries),
        {
          cohortLimit: OVERLAY_COHORT_LIMIT,
          collisionCapacity: OVERLAY_COLLISION_CAPACITY,
          moving: false,
        },
      );
    }
  }

  function setStatus(status) {
    _status = status;
  }

  function scheduleLoad() {
    clearTimeout(_debounceTimer);
    const box = viewportBox(_viewer);
    if (box && canReuse(box)) {
      _debounceTimer = null;
      loadCameras();
      return;
    }
    _debounceTimer = setTimeout(() => {
      _debounceTimer = null;
      loadCameras();
    }, REQUEST_DEBOUNCE_MS);
  }

  async function loadCameras() {
    if (!_enabled || !_viewer) return;
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
    const box = viewportBox(_viewer);
    if (!box) {
      _request?.abort();
      _request = null;
      _pendingQueryBox = null;
      _records = [];
      renderRecords();
      setStatus('zoom-in');
      // Not false: a zoomed-out view is guidance, not a rejected refresh.
      return;
    }
    if (canReuse(box)) {
      if (_request) {
        _request.abort();
        _request = null;
        _pendingQueryBox = null;
      }
      renderRecords();
      setStatus(_records.length ? 'ready' : 'empty');
      return;
    }
    // A move inside an in-flight query must not abort and restart that query.
    if (_request && boxContains(_pendingQueryBox, box)) return;
    const queryBox = snapSpeedCameraBox(box);
    _request?.abort();
    const request = new AbortController();
    _request = request;
    _pendingQueryBox = queryBox;
    setStatus('loading');
    try {
      const snapshot = await source.fetch(queryBox, request.signal);
      if (request.signal.aborted || _request !== request || !_enabled) return;
      const { records, stale, saturated } =
        validateSpeedCameraSnapshot(snapshot);
      _records = records;
      _stale = stale;
      _saturated = saturated;
      _lastQueryBox = queryBox;
      _lastUpdate = Date.now();
      _lastError = null;
      renderRecords();
      setStatus(records.length ? 'ready' : 'empty');
      console.log(
        `[Data:SpeedCameras] Updated: ${records.length} cameras in view`,
      );
      return true;
    } catch (e) {
      if (request.signal.aborted || _request !== request || !_enabled) return;
      console.warn('[Data:SpeedCameras] Fetch error:', e);
      // Failed queries never replace the last successful box or its records.
      _lastError = e?.message || 'Speed camera source unavailable';
      setStatus('error');
    } finally {
      if (_request === request) _request = null;
    }
  }

  const layer = {
    id: LAYER_ID,
    name: 'Speed Cameras',
    icon: '📷',
    source: 'OpenStreetMap',
    attribution: source.attribution,

    init(viewer) {
      if (_viewer) throw new Error('Speed camera layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _moveEndRemove = viewer.camera.moveEnd.addEventListener(scheduleLoad);
      _records = [];
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(OVERLAY_SOURCE_ID, false);
      console.log('[Data:SpeedCameras] Initialized');
    },

    enable() {
      if (_enabled) return;
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(OVERLAY_SOURCE_ID, true);
      // DataLayerManager calls update() right after enable(); it owns the
      // first fetch.
    },

    disable() {
      _request?.abort();
      _request = null;
      _pendingQueryBox = null;
      _enabled = false;
      clearTimeout(_debounceTimer);
      _debounceTimer = null;
      if (_dataSource) _dataSource.show = false;
      _records = [];
      _count = 0;
      overlayHost.clearSource(OVERLAY_SOURCE_ID);
      overlayHost.setVisible(OVERLAY_SOURCE_ID, false);
    },

    update() {
      return loadCameras();
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _viewer = null;
      _enabled = false;
      clearTimeout(_debounceTimer);
      _debounceTimer = null;
      _moveEndRemove?.();
      _moveEndRemove = null;
      overlayHost.clearSource(OVERLAY_SOURCE_ID);
      overlayHost.setVisible(OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        (viewer || _viewer)?.dataSources?.remove(_dataSource, true);
        _dataSource = null;
      }
      _records = [];
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    /**
     * Snapshot the layer's in-memory records as JSON-safe objects for the
     * analyst query engine. On-demand only; returns [] while disabled/empty.
     */
    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      return _records.slice(0, limit).map(mapAnalystRecord);
    },

    getStats() {
      return {
        count: _records.length,
        rendered: Math.min(_records.length, MAX_RENDERED),
        saturated: _saturated,
        stale: _stale,
        status: _status,
        lastUpdate: _lastUpdate,
        error: _lastError,
      };
    },
  };
  return layer;
}
