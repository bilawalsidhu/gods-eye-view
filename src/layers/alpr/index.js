import * as Cesium from 'cesium';
import {
  LAYER_ID,
  REQUEST_DEBOUNCE_MS,
  QUERY_LIMIT,
  MAX_RENDERED,
  QUERY_SNAP_DEGREES,
  QUERY_REUSE_MS,
  ALPR_COLOR,
} from './policy.js';
import {
  snapAlprBox,
  boxContains,
  destinationPointDeg,
  alprRetryDelayMs,
  validateAlprSnapshot,
  alprCreditMarkup,
} from './model.js';
import { createAlprPresentation } from './presentation.js';

/**
 * Own one layer's requests, records, display and viewer subscriptions.
 * A source fetches a bounded box with an AbortSignal and resolves
 * { records, stale, saturated }. Records use stable string ids and latitude /
 * longitude in degrees; optional directionDeg is a compass bearing [0, 360).
 * Manufacturer, operator and cameraType are optional display fields.
 * Source label and attribution { name, description, text, href } identify the
 * actual provider; href must be HTTPS. Provider payload parsing stays in source.
 * Context services remove obsolete records with
 * removeEntityContextsForLayer(layerId, { retainIds: Set<string> }), preserving
 * retained selection without dispatching a new selection event.
 */
export function createAlprCamerasLayer({ source, services } = {}) {
  if (typeof source?.fetch !== 'function')
    throw new TypeError('ALPR requires a camera source');
  const { governorRequestRender } = services.render;

  const { registerPickOwner, unregisterPickOwner } = services.picking;

  const state = {
    viewer: null,
    dataSource: null,
    credit: null,
    creditTimer: null,
    creditPresented: false,
    enabled: false,
    records: [],
    recordById: new Map(),
    selectedId: null,
    lastUpdate: null,
    error: null,
    status: 'idle',
    stale: false,
    /** Whether the query hit QUERY_LIMIT — the view likely holds more cameras than shown. */
    saturated: false,
    loading: false,
    abort: null,
    pendingQueryBox: null,
    retryTimer: null,
    retryDelayMs: 0,
    retryAt: 0,
    retrying: false,
    moveEndRemove: null,
    postRenderRemove: null,
    lastAnchorSampleAt: 0,
    clickHandler: null,
    debounceTimer: null,
    /** Snapped box of the last successful query; a view still inside it reuses its records. */
    lastQueryBox: null,
  };
  const {
    initOverlay,
    destroyOverlay,
    viewportBox,
    clearRendered,
    hideOnMapCredit,
    presentOnMapCredit,
    renderRecords,
    selectRecord,
    focusNearest,
    clearSelection,
    updateSelectedAnchor,
    installInteraction,
  } = createAlprPresentation({ state, services, source });

  function setAlprStatus(status, error = null) {
    if (state.status === status && state.error === error) return;
    state.status = status;
    state.error = error;
    governorRequestRender('alpr-status');
  }

  function scheduleUnavailableRetry() {
    if (!state.enabled) return;
    clearTimeout(state.retryTimer);
    state.retryDelayMs = alprRetryDelayMs(state.retryDelayMs);
    state.retryAt = Date.now() + state.retryDelayMs;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      state.retryAt = 0;
      if (state.enabled && !state.loading) loadCameras();
    }, state.retryDelayMs);
  }

  function clearUnavailableRetry({ resetBackoff = true } = {}) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
    state.retryAt = 0;
    if (resetBackoff) state.retryDelayMs = 0;
  }

  function scheduleLoad() {
    if (!state.enabled) return;
    clearUnavailableRetry({ resetBackoff: false });
    clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      loadCameras();
    }, REQUEST_DEBOUNCE_MS);
  }

  async function loadCameras() {
    if (!state.enabled || !state.viewer) return;
    clearTimeout(state.debounceTimer);
    state.debounceTimer = null;
    clearUnavailableRetry({ resetBackoff: false });
    const box = viewportBox(state.viewer);
    if (!box) {
      state.abort?.abort();
      state.abort = null;
      state.pendingQueryBox = null;
      state.loading = false;
      state.retrying = false;
      clearUnavailableRetry();
      renderRecords();
      setAlprStatus('zoom-in');
      return;
    }
    // A settled view still inside the last snapped query box, with fresh
    // records, needs no new request: tiny pans and orbits
    // otherwise became distinct upstream fetches against the shared proxy. Any
    // request still in flight was for a viewport the user has since left, so it
    // is aborted rather than allowed to replace the records that already cover
    // this view. Failed queries never replace the last successful box.
    if (
      state.lastQueryBox &&
      boxContains(state.lastQueryBox, box) &&
      state.lastUpdate &&
      Date.now() - state.lastUpdate < QUERY_REUSE_MS &&
      !state.stale &&
      state.status !== 'unavailable'
    ) {
      if (state.abort) {
        state.abort.abort();
        state.abort = null;
        state.pendingQueryBox = null;
        state.loading = false;
      }
      renderRecords();
      state.retrying = false;
      setAlprStatus(
        state.dataSource.entities.values.length ? 'ready' : 'empty',
      );
      return;
    }
    // A move inside an in-flight query must not abort and restart that query.
    if (state.abort && boxContains(state.pendingQueryBox, box)) {
      renderRecords();
      return;
    }
    const queryBox = snapAlprBox(box);
    state.abort?.abort();
    const requestAbort = new AbortController();
    state.abort = requestAbort;
    state.pendingQueryBox = queryBox;
    state.loading = true;
    state.retrying = state.status === 'unavailable' || state.retryDelayMs > 0;
    setAlprStatus('loading');
    renderRecords();
    try {
      const snapshot = await source.fetch(queryBox, requestAbort.signal);
      if (
        requestAbort.signal.aborted ||
        state.abort !== requestAbort ||
        !state.enabled
      )
        return;
      const { records, stale, saturated } = validateAlprSnapshot(snapshot);
      state.records = records;
      state.recordById = new Map(records.map((r) => [r.id, r]));
      state.lastUpdate = Date.now();
      state.stale = stale;
      // Saturated when the QUERY truncated OR the render cap would hide cameras:
      // either way the view holds more than the screen shows, and the user must
      // be told rather than left with a count that disagrees with the map.
      state.saturated = saturated || records.length > MAX_RENDERED;
      state.lastQueryBox = queryBox;
      clearUnavailableRetry();
      // Stale and saturated are independent facts; a cached response that also
      // hit the cap must still warn about coverage, not just about freshness.
      renderRecords();
      setAlprStatus(
        state.dataSource.entities.values.length
          ? stale
            ? 'stale'
            : 'ready'
          : 'empty',
      );
    } catch (error) {
      if (
        error?.name === 'AbortError' ||
        requestAbort.signal.aborted ||
        state.abort !== requestAbort ||
        !state.enabled
      )
        return;
      state.stale = Boolean(state.lastUpdate);
      setAlprStatus(
        'unavailable',
        error?.message || 'Camera source temporarily unavailable',
      );
      scheduleUnavailableRetry();
    } finally {
      if (state.abort === requestAbort) {
        state.abort = null;
        state.pendingQueryBox = null;
        state.loading = false;
        state.retrying = false;
        governorRequestRender('alpr-status');
      }
    }
  }

  const alprCamerasLayer = {
    id: LAYER_ID,
    name: 'ALPR Cameras',
    icon: '📷',
    source: source.label || 'Mapped camera locations',
    updateInterval: 0,
    statsRefreshInterval: 1000,
    init(viewer) {
      if (state.viewer) throw new Error('ALPR layer is already initialized');
      state.viewer = viewer;
      state.dataSource = new Cesium.CustomDataSource('alpr-cameras');
      const creditMarkup = alprCreditMarkup(source.attribution);
      state.credit = creditMarkup
        ? new Cesium.Credit(creditMarkup, true)
        : null;
      viewer.dataSources.add(state.dataSource);
      state.moveEndRemove =
        viewer.camera.moveEnd.addEventListener(scheduleLoad);
      state.postRenderRemove =
        viewer.scene.postRender?.addEventListener(updateSelectedAnchor);
      initOverlay();
      installInteraction(viewer);
    },
    enable() {
      if (state.enabled) return;
      state.enabled = true;
      state.creditPresented = false;
      registerPickOwner(LAYER_ID, (id) => state.recordById.has(id));
      state.dataSource.show = true;
      // DataLayerManager calls update() right after enable(); it owns the first fetch.
    },
    disable() {
      state.enabled = false;
      hideOnMapCredit();
      unregisterPickOwner(LAYER_ID);
      clearUnavailableRetry();
      clearTimeout(state.debounceTimer);
      state.abort?.abort();
      state.abort = null;
      state.pendingQueryBox = null;
      state.loading = false;
      state.retrying = false;
      if (state.dataSource) state.dataSource.show = false;
      clearSelection();
      clearRendered();
      setAlprStatus('idle');
    },
    update() {
      return loadCameras();
    },
    destroy(viewer = state.viewer) {
      this.disable();
      destroyOverlay();
      state.moveEndRemove?.();
      state.moveEndRemove = null;
      state.postRenderRemove?.();
      state.postRenderRemove = null;
      state.clickHandler?.destroy();
      state.clickHandler = null;
      clearRendered();
      if (state.dataSource && viewer)
        viewer.dataSources.remove(state.dataSource, true);
      state.dataSource = null;
      state.credit = null;
      state.creditPresented = false;
      state.records = [];
      state.recordById = new Map();
      state.lastQueryBox = null;
      state.lastUpdate = null;
      state.error = null;
      state.status = 'idle';
      state.stale = false;
      state.saturated = false;
      state.viewer = null;
    },
    /**
     * Snapshot the loaded camera records as plain JSON-safe objects for the
     * analyst query engine ("how many plate readers within 5 km?"). On-demand
     * only — no listeners, no caching. Returns [] while disabled or empty.
     * This layer loads by viewport, so a count is a loaded-data count, never
     * a world count; the analyst coverage note says so.
     * @param {number} [maxCount=2000] - Maximum records to return (truncation).
     */
    getAnalystRecords(maxCount = 2000) {
      if (!state.enabled || !state.records.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      return state.records.slice(0, limit).map((record) => ({
        id: record.id,
        lat: record.latitude,
        lon: record.longitude,
        operator: record.operator,
        manufacturer: record.manufacturer,
        cameraType: record.cameraType,
        zone: record.zone,
        ref: record.ref,
        directionDeg: record.directionDeg,
      }));
    },
    getRowControls() {
      const count = state.dataSource?.entities.values.length || 0;
      const selected = state.selectedId
        ? state.recordById.get(state.selectedId)
        : null;
      return {
        chips: [
          {
            id: 'find-camera',
            label: 'SHOW NEAREST',
            title: state.viewer?.trackedEntity
              ? 'Stop following the current object before navigating to a camera'
              : 'Move to the nearest loaded camera and show its details',
            disabled:
              !state.enabled || !count || Boolean(state.viewer?.trackedEntity),
            onClick: focusNearest,
          },
          {
            id: 'edit-osm',
            label: 'FIX ON OSM',
            title: Number.isSafeInteger(selected?.osmId)
              ? 'Open this camera on OpenStreetMap to verify or correct it'
              : 'Select a camera, then open it on OpenStreetMap so corrections flow back to the shared map',
            disabled: !state.enabled || !Number.isSafeInteger(selected?.osmId),
            onClick: () => {
              const record = state.selectedId
                ? state.recordById.get(state.selectedId)
                : null;
              if (!Number.isSafeInteger(record?.osmId)) return;
              window.open(
                `https://www.openstreetmap.org/node/${record.osmId}`,
                '_blank',
                'noopener,noreferrer',
              );
            },
          },
        ],
        legend: [
          {
            label: 'Camera badges',
            color: ALPR_COLOR,
            count,
            blurb:
              'Cyan cameras turn coral when selected. Wedges illustrate mapped direction, not measured coverage. Nearby cameras may be outside the screen.',
          },
        ],
      };
    },
    getStats() {
      return {
        count: state.dataSource?.entities.values.length || 0,
        countLabel: state.enabled
          ? `${state.dataSource?.entities.values.length || 0} nearby`
          : '',
        lastUpdate: state.lastUpdate,
        stale: state.stale,
        saturated: state.saturated,
        error: state.error,
        status: state.status,
        loading: state.loading,
        retryAt: state.retryAt,
        retrying: state.retrying,
        retryInSec: state.retryAt
          ? Math.max(0, Math.ceil((state.retryAt - Date.now()) / 1000))
          : 0,
        loadingLabel: state.loading
          ? state.retrying
            ? 'retrying mapped ALPR cameras'
            : 'loading mapped ALPR cameras'
          : state.status === 'zoom-in'
            ? 'Zoom in to load mapped cameras'
            : [
                state.stale ? 'Showing cached locations' : '',
                state.saturated ? 'Coverage limited — zoom in' : '',
                state.status === 'empty'
                  ? 'No mapped cameras returned — coverage is incomplete'
                  : '',
              ]
                .filter(Boolean)
                .join(' · '),
      };
    },
  };
  return alprCamerasLayer;
}
export {
  snapAlprBox,
  boxContains,
  destinationPointDeg,
  alprRetryDelayMs,
  isAlprSurveillanceType,
  normalizeAlprNode,
  buildOverpassQuery,
} from './model.js';
export {
  QUERY_LIMIT,
  MAX_RENDERED,
  QUERY_SNAP_DEGREES,
  QUERY_REUSE_MS,
} from './policy.js';
export { createOverpassAlprSource } from './source.js';
