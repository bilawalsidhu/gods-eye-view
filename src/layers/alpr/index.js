import { t, tn, msg } from '../../i18n/index.js';
import { isUnavailableCapability } from '../../sources/capability.js';
import {
  LAYER_ID,
  REQUEST_DEBOUNCE_MS,
  QUERY_REUSE_MS,
  ALPR_COLOR,
} from './policy.js';
import {
  snapAlprBox,
  boxContains,
  alprRetryDelayMs,
  validateAlprSnapshot,
} from './model.js';

/**
 * Own one layer's requests, records, display and viewer subscriptions.
 * A source fetches a bounded box with an AbortSignal and resolves
 * { records, stale, saturated }, optionally with `coverage` (the bounds its
 * records fully cover, reused for later views inside it) and `zoom` (their
 * tile precision; `source.detailZoom(box)` names the zoom a view needs). Records use stable string ids and latitude /
 * longitude in degrees; optional directionDeg is a compass bearing [0, 360).
 * Manufacturer, operator and cameraType are optional display fields.
 * Source label and attribution { name, description, text, href } identify the
 * actual provider; href must be HTTPS. Provider payload parsing stays in source.
 * Context services remove obsolete records with
 * removeEntityContextsForLayer(layerId, { retainIds: Set<string> }), preserving
 * retained selection without dispatching a new selection event.
 */
export function createAlprCamerasLayer({
  source,
  services,
  rendererFactory,
} = {}) {
  if (typeof source?.fetch !== 'function')
    throw new TypeError('ALPR requires a camera source');
  const { governorRequestRender } = services.render;

  const { registerPickOwner, unregisterPickOwner } = services.picking;

  const state = {
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
    lastAnchorSampleAt: 0,
    debounceTimer: null,
    /** Snapped box of the last successful query; a view still inside it reuses its records. */
    lastQueryBox: null,
    /** Extract zoom of the accepted records (null for sources without tiles). */
    lastQueryZoom: null,
    /** Increments whenever the displayed camera set changes (QA stability probe). */
    renderRevision: 0,
    /** Cameras in view beyond the render cap. */
    renderSaturated: false,
  };
  let renderer = null;
  let sceneEngine = null;
  let sceneContext = null;

  function setAlprStatus(status, error = null) {
    if (state.status === status && state.error === error) return;
    state.status = status;
    state.error = error;
    governorRequestRender('alpr-status', sceneEngine);
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

  /** Whether accepted records already answer `box` without a request. */
  function canReuse(box) {
    const detailZoom = source.detailZoom?.(box) ?? null;
    return Boolean(
      state.lastQueryBox &&
      boxContains(state.lastQueryBox, box) &&
      (state.lastQueryZoom == null ||
        detailZoom == null ||
        state.lastQueryZoom >= detailZoom - 1) &&
      state.lastUpdate &&
      Date.now() - state.lastUpdate < QUERY_REUSE_MS &&
      !state.stale &&
      state.status !== 'unavailable',
    );
  }

  function scheduleLoad() {
    if (!state.enabled || !renderer || sceneContext?.viewReady === false)
      return;
    clearUnavailableRetry({ resetBackoff: false });
    clearTimeout(state.debounceTimer);
    // A view the accepted tiles already cover is a local filter: show it now.
    // Only a view that needs a request waits out the debounce.
    const box = renderer.viewportBox();
    if (box && canReuse(box)) {
      state.debounceTimer = null;
      loadCameras();
      return;
    }
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      loadCameras();
    }, REQUEST_DEBOUNCE_MS);
  }

  async function loadCameras() {
    if (!state.enabled || !renderer?.ready || sceneContext?.viewReady === false)
      return;
    clearTimeout(state.debounceTimer);
    state.debounceTimer = null;
    clearUnavailableRetry({ resetBackoff: false });
    const box = renderer.viewportBox();
    if (!box) {
      state.abort?.abort();
      state.abort = null;
      state.pendingQueryBox = null;
      state.loading = false;
      state.retrying = false;
      clearUnavailableRetry();
      renderer.renderRecords();
      setAlprStatus('zoom-in');
      return;
    }
    // A settled view still inside the last snapped query box, with fresh
    // records, needs no new request: tiny pans and orbits
    // otherwise became distinct upstream fetches against the shared proxy. Any
    // request still in flight was for a viewport the user has since left, so it
    // is aborted rather than allowed to replace the records that already cover
    // this view. Failed queries never replace the last successful box.
    // Reuse also needs the accepted records to be precise enough for this view:
    // one zoom coarser than the view would pick is a few metres, never more.
    if (canReuse(box)) {
      if (state.abort) {
        state.abort.abort();
        state.abort = null;
        state.pendingQueryBox = null;
        state.loading = false;
      }
      renderer.renderRecords();
      state.retrying = false;
      setAlprStatus(renderer.count() ? 'ready' : 'empty');
      return;
    }
    // A move inside an in-flight query must not abort and restart that query.
    if (state.abort && boxContains(state.pendingQueryBox, box)) {
      // The accepted records may cover only part of the new view. Re-filtering
      // them during floor preparation creates an intermediate marker set.
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
    // Keep the current markers until the new view's records land, so a still
    // camera sees one update instead of old records re-filtered, then new ones.
    try {
      const snapshot = await source.fetch(queryBox, requestAbort.signal);
      if (
        requestAbort.signal.aborted ||
        state.abort !== requestAbort ||
        !state.enabled
      )
        return;
      if (snapshot.zoomIn) {
        state.records = [];
        state.recordById.clear();
        state.noCoverage = false;
        state.lastQueryBox = null;
        state.lastQueryZoom = null;
        clearUnavailableRetry();
        if (sceneContext?.viewReady !== false) renderer?.renderRecords();
        setAlprStatus('zoom-in');
        return;
      }
      const { records, stale, saturated } = validateAlprSnapshot(snapshot);
      // Resolve marker floors (bounded wait, warm cells answer at once) so new
      // markers are placed on the floor instead of clamped then moved.
      await renderer?.prepareFloors(records);
      if (
        requestAbort.signal.aborted ||
        state.abort !== requestAbort ||
        !state.enabled
      )
        return;
      state.noCoverage = snapshot.noCoverage === true;
      state.records = records;
      state.recordById = new Map(records.map((r) => [r.id, r]));
      state.lastUpdate = Date.now();
      state.stale = stale;
      // Saturated when the QUERY truncated; the render cap is judged against
      // the cameras in view (renderSaturated). Either way the row says so.
      state.saturated = saturated;
      // The fetched tiles cover more than the view: pans inside them are free.
      state.lastQueryBox =
        snapshot.coverage && boxContains(snapshot.coverage, queryBox)
          ? snapshot.coverage
          : queryBox;
      state.lastQueryZoom = Number.isInteger(snapshot.zoom)
        ? snapshot.zoom
        : null;
      clearUnavailableRetry();
      // Stale and saturated are independent facts; a cached response that also
      // hit the cap must still warn about coverage, not just about freshness.
      if (sceneContext?.viewReady !== false) renderer?.renderRecords();
      setAlprStatus(
        (renderer?.count() ?? records.length)
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
        error?.message || msg('Camera source temporarily unavailable'),
      );
      if (!isUnavailableCapability(error)) scheduleUnavailableRetry();
    } finally {
      if (state.abort === requestAbort) {
        state.abort = null;
        state.pendingQueryBox = null;
        state.loading = false;
        state.retrying = false;
        governorRequestRender('alpr-status', sceneEngine);
      }
    }
  }

  const picks = {
    owner: LAYER_ID,
    predicate: (id) => state.recordById.has(id),
  };
  const alprCamerasLayer = {
    id: LAYER_ID,
    name: 'ALPR Cameras',
    icon: '📷',
    // English in layer state; the layer row translates it.
    source: source.label || msg('Mapped camera locations'),
    updateInterval: 0,
    statsRefreshInterval: 1000,
    init(viewer, options) {
      this.attachRenderer(options);
    },
    show(enabled) {
      renderer?.setVisible(enabled);
    },
    picks,
    attachRenderer(options = {}) {
      sceneContext = options;
      if (renderer?.ready) throw new Error('ALPR layer is already initialized');
      if (typeof rendererFactory !== 'function')
        throw new TypeError('An ALPR renderer factory is required');
      sceneEngine = options.engine;
      renderer = rendererFactory({
        state,
        services,
        source,
        engine: options.engine,
      });
      renderer.init({ onMove: scheduleLoad });
      if (state.enabled) {
        registerPickOwner(picks.owner, picks.predicate, sceneEngine);
        renderer.setVisible(true);
        if (sceneContext?.viewReady !== false) renderer.renderRecords();
      }
    },
    detachRenderer() {
      unregisterPickOwner(LAYER_ID, sceneEngine);
      sceneContext = null;
      clearTimeout(state.debounceTimer);
      renderer?.destroy({ retainContext: true });
      renderer = null;
      sceneEngine = null;
    },
    resumeViewport() {
      if (state.enabled && renderer) {
        renderer.renderRecords();
        if (!state.loading) scheduleLoad();
      }
    },
    enable() {
      if (state.enabled) return;
      state.enabled = true;
      registerPickOwner(picks.owner, picks.predicate, sceneEngine);
      renderer.setVisible(true);
      // DataLayerManager calls update() right after enable(); it owns the first fetch.
    },
    disable() {
      state.enabled = false;
      renderer?.hideOnMapCredit();
      unregisterPickOwner(LAYER_ID, sceneEngine);
      clearUnavailableRetry();
      clearTimeout(state.debounceTimer);
      state.abort?.abort();
      state.abort = null;
      state.pendingQueryBox = null;
      state.loading = false;
      state.retrying = false;
      renderer?.setVisible(false);
      renderer?.clearSelection();
      renderer?.clearRendered();
      setAlprStatus('idle');
    },
    update() {
      return loadCameras();
    },
    destroy() {
      source.destroy?.();
      this.disable();
      renderer?.destroy();
      renderer = null;
      sceneEngine = null;
      state.records = [];
      state.recordById = new Map();
      state.lastQueryBox = null;
      state.lastQueryZoom = null;
      state.lastUpdate = null;
      state.error = null;
      state.status = 'idle';
      state.stale = false;
      state.saturated = false;
    },
    getRowControls() {
      const count = renderer?.count() || 0;
      return {
        chips: [
          {
            id: 'find-camera',
            label: t('SHOW NEAREST'),
            title: renderer?.following()
              ? t(
                  'Stop following the current object before navigating to a camera',
                )
              : t('Move to the nearest loaded camera and show its details'),
            disabled:
              !state.enabled || !count || Boolean(renderer?.following()),
            onClick: () => renderer?.focusNearest(),
          },
        ],
        legend: [
          {
            label: t('Camera badges'),
            color: ALPR_COLOR,
            count,
            blurb: t(
              'Cyan cameras turn coral when selected. Wedges illustrate mapped direction, not measured coverage. Nearby cameras may be outside the screen.',
            ),
          },
        ],
      };
    },
    /**
     * Snapshot loaded ALPR cameras (the nearby query box) as plain JSON-safe records for the analyst
     * query engine. On demand only (once per spoken query); [] while the
     * layer is off.
     * @param {number} [maxCount=Infinity] Most records to return.
     * @returns {Array<Object>} {id, lat, lon, operator, manufacturer, cameraType, directionDeg}.
     */
    getAnalystRecords(maxCount = Infinity) {
      if (!state.enabled) return [];
      const result = [];
      for (const record of state.records || []) {
        if (result.length >= maxCount) break;
        if (
          !Number.isFinite(record.latitude) ||
          !Number.isFinite(record.longitude)
        )
          continue;
        result.push({
          id: record.id,
          lat: record.latitude,
          lon: record.longitude,
          operator: record.operator ?? null,
          manufacturer: record.manufacturer ?? null,
          cameraType: record.cameraType ?? null,
          directionDeg: Number.isFinite(record.directionDeg)
            ? record.directionDeg
            : null,
        });
      }
      return result;
    },
    getStats() {
      return {
        count: renderer?.count() || 0,
        countLabel:
          state.enabled && !state.noCoverage && state.status !== 'zoom-in'
            ? Number.isInteger(state.onScreen)
              ? tn(
                  renderer?.count() || 0,
                  '{count} nearby · {onScreen} on screen',
                  '{count} nearby · {onScreen} on screen',
                  { onScreen: state.onScreen },
                )
              : tn(renderer?.count() || 0, '{count} nearby', '{count} nearby')
            : '',
        noCoverage: Boolean(state.noCoverage),
        lastUpdate: state.lastUpdate,
        stale: state.stale,
        saturated: state.saturated || state.renderSaturated,
        renderRevision: state.renderRevision,
        onScreen: state.onScreen ?? null,
        shown: renderer?.count() || 0,
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
            ? t('retrying mapped ALPR cameras')
            : t('loading mapped ALPR cameras')
          : state.noCoverage
            ? t('No ALPR data for this area — US and Canada only')
            : state.status === 'zoom-in'
              ? t('Zoom in to load mapped cameras')
              : [
                  state.stale ? t('Showing cached locations') : '',
                  state.saturated || state.renderSaturated
                    ? t('Coverage limited — zoom in')
                    : '',
                  state.status === 'empty'
                    ? t('No ALPR data for this area')
                    : '',
                  state.status === 'ready' && state.onScreen === 0
                    ? t('None on screen — nearby cameras are outside the view')
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
export { createOverpassAlprSource, createAlprTileSource } from './source.js';
