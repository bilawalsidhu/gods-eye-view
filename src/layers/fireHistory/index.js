import * as Cesium from 'cesium';
import { announceNavigationAuthority } from '../../navigationPolicy.js';
import {
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from '../../renderGovernor.js';
import {
  FIRE_HISTORY_LAYER_ID,
  FIRE_HISTORY_OVERLAY_SOURCE_ID,
  adaptFireHistoryRecords,
  buildEventTimeline,
  compactCount,
  createFireHistoryOverlayEntry,
  detectionPixelSize,
  eventCenter,
  fireHistoryRowControls,
  mapAnalystRecord,
  progressRgb,
  selectEvent,
} from './model.js';
import {
  advanceReplay,
  createReplayState,
  cycleReplaySpeed,
  detectionPhase,
  pauseReplay,
  playReplay,
  replayActive,
  replayCounts,
  replayLabel,
  replayRowChips,
  resetReplay,
  seekReplay,
  setReplaySpeed,
} from './replay.js';
import { createFireHistoryPanel } from './panel.js';
export * from './model.js';
export * from './replay.js';
export * from './panel.js';
export { createFireHistorySource } from './source.js';

/** Archive data never changes; one load per enable is enough. */
const ARCHIVE_REFRESH_MS = 24 * 3600_000;
const CAMERA_FLIGHT_SECONDS = 2.6;
/** Frame padding as a fraction of the event box's larger side. */
const FRAME_PADDING_RATIO = 0.18;
const FRAME_PADDING_MIN_DEG = 0.015;
const REPLAY_RENDER_HOLD = 'fire-history-replay';
/** Row repaint cadence while the clock runs (the readout changes 4×/s). */
const REPLAY_ROW_NOTIFY_MS = 250;
/** Cooled detections keep the burn scar visible under the active front. */
const COOLED_RGB = Object.freeze([118, 48, 36]);
const COOLED_ALPHA = 0.78;
const ACTIVE_BRIGHTEN = 70;
const ACTIVE_SIZE_BONUS = 3;

/**
 * Historic fires from the NASA FIRMS archive, one registered event at a
 * time. Detections render as depth-test-free points colored by where they
 * fall in the event window (yellow → ember). A replay clock can instead
 * play the detections in event time: pending points are hidden, fresh ones
 * flare bright, older ones cool into the burn scar. Event choice and the
 * transport controls are row chips in the Data Layers panel.
 * @param {{source: object, overlayHost: object}} options
 */
export function createFireHistoryLayer({ source, overlayHost } = {}) {
  if (
    typeof source?.listEvents !== 'function' ||
    typeof source?.getEvent !== 'function'
  )
    throw new TypeError('Historic fires require an event archive source');
  if (!overlayHost)
    throw new TypeError('Historic fires require an overlay host');

  let _viewer = null;
  /** @type {?Cesium.PointPrimitiveCollection} */
  let _points = null;
  /** @type {Array<Cesium.PointPrimitive>} aligned with _fires */
  let _pointsByIndex = [];
  let _request = null;
  let _enabled = false;
  let _loading = false;
  let _keyRequired = false;
  let _lastError = null;
  let _lastUpdate = null;
  let _complete = true;
  /** @type {Array<object>} registered events (public shape) */
  let _events = [];
  let _selectedId = null;
  /** @type {?object} */
  let _event = null;
  /** @type {Array<object>} adapted detections of the shown event */
  let _fires = [];
  let _timeline = [];
  let _rowControlsListener = null;
  /** Manager handle so selections settle as layer params (share links). */
  let _dataManager = null;
  /** @type {?import('./replay.js').ReplayState} */
  let _replay = null;
  let _replayFrame = null;
  let _replayLastTick = 0;
  let _replayLastNotify = 0;
  const scratchColor = new Cesium.Color();
  /** @type {?ReturnType<typeof createFireHistoryPanel>} */
  let _panel = null;

  const notifyRow = () => {
    _rowControlsListener?.();
    _panel?.render();
  };

  function clearScene() {
    _points?.removeAll();
    _pointsByIndex = [];
    overlayHost.clearSource(FIRE_HISTORY_OVERLAY_SOURCE_ID);
  }

  function renderFires(event, fires) {
    if (!_points) return;
    _points.removeAll();
    _pointsByIndex = new Array(fires.length);
    for (const fire of fires) {
      const [r, g, b] = progressRgb(fire.progress);
      _pointsByIndex[fire.index] = _points.add({
        id: `fire-history:${event.id}:${fire.index}`,
        position: Cesium.Cartesian3.fromDegrees(fire.lon, fire.lat, 0),
        pixelSize: detectionPixelSize(fire.frp, fire.sensor),
        color: Cesium.Color.fromBytes(r, g, b, 255),
        outlineColor: Cesium.Color.fromBytes(20, 8, 8, 200),
        outlineWidth: 1,
        // Detections sit at ellipsoid height 0: without this, terrain and
        // photoreal tiles bury them in mountainous burn scars.
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    }
    const center = eventCenter(event.bbox);
    overlayHost.setEntries(
      FIRE_HISTORY_OVERLAY_SOURCE_ID,
      fires.length
        ? [
            createFireHistoryOverlayEntry({
              event,
              position: Cesium.Cartesian3.fromDegrees(
                center.lon,
                center.lat,
                0,
              ),
              count: fires.length,
            }),
          ]
        : [],
      { cohortLimit: 1, collisionCapacity: 1, moving: false },
    );
    overlayHost.setVisible(FIRE_HISTORY_OVERLAY_SOURCE_ID, _enabled);
  }

  /**
   * Paint every point for the current clock. Idle → the static progress
   * presentation. Otherwise pending points hide, active points flare, and
   * cooled points settle into the scar. Scratch color only: the primitive
   * setter copies.
   */
  function applyReplayFrame() {
    if (!_points || _pointsByIndex.length !== _fires.length) return;
    const active = replayActive(_replay);
    const cursor = _replay?.cursorMs ?? 0;
    for (const fire of _fires) {
      const point = _pointsByIndex[fire.index];
      if (!point) continue;
      const base = detectionPixelSize(fire.frp, fire.sensor);
      if (!active) {
        const [r, g, b] = progressRgb(fire.progress);
        point.show = true;
        point.color = Cesium.Color.fromBytes(r, g, b, 255, scratchColor);
        point.pixelSize = base;
        continue;
      }
      const phase = detectionPhase(fire, cursor);
      if (phase === 'pending') {
        point.show = false;
        continue;
      }
      point.show = true;
      if (phase === 'active') {
        const [r, g, b] = progressRgb(fire.progress);
        point.color = Cesium.Color.fromBytes(
          Math.min(255, r + ACTIVE_BRIGHTEN),
          Math.min(255, g + ACTIVE_BRIGHTEN),
          Math.min(255, b + ACTIVE_BRIGHTEN),
          255,
          scratchColor,
        );
        point.pixelSize = base + ACTIVE_SIZE_BONUS;
      } else {
        const [r, g, b] = COOLED_RGB;
        point.color = Cesium.Color.fromBytes(
          r,
          g,
          b,
          Math.round(COOLED_ALPHA * 255),
          scratchColor,
        );
        point.pixelSize = Math.max(2, base - 1);
      }
    }
  }

  function stopReplayLoop() {
    if (_replayFrame !== null) {
      cancelAnimationFrame(_replayFrame);
      _replayFrame = null;
    }
    releaseContinuousRender(REPLAY_RENDER_HOLD);
  }

  function replayTick(nowMs) {
    _replayFrame = null;
    if (!_enabled || !_replay || _replay.status !== 'playing') {
      stopReplayLoop();
      return;
    }
    const elapsed = _replayLastTick ? nowMs - _replayLastTick : 0;
    _replayLastTick = nowMs;
    _replay = advanceReplay(_replay, elapsed);
    applyReplayFrame();
    if (_replay.status === 'ended') {
      stopReplayLoop();
      governorRequestRender('fire-history-replay-end');
      notifyRow();
      return;
    }
    if (nowMs - _replayLastNotify >= REPLAY_ROW_NOTIFY_MS) {
      _replayLastNotify = nowMs;
      notifyRow();
    }
    _replayFrame = requestAnimationFrame(replayTick);
  }

  function startReplayLoop() {
    if (_replayFrame !== null) return;
    holdContinuousRender(REPLAY_RENDER_HOLD);
    _replayLastTick = 0;
    _replayLastNotify = 0;
    _replayFrame = requestAnimationFrame(replayTick);
  }

  const replayReady = () => _enabled && !_loading && _fires.length > 0;

  function toggleReplay() {
    if (!replayReady() || !_replay) return;
    if (_replay.status === 'playing') {
      _replay = pauseReplay(_replay);
      stopReplayLoop();
    } else {
      _replay = playReplay(_replay);
      applyReplayFrame();
      startReplayLoop();
    }
    governorRequestRender('fire-history-replay');
    notifyRow();
  }

  function resetReplayView() {
    if (!_replay) return;
    _replay = resetReplay(_replay);
    stopReplayLoop();
    applyReplayFrame();
    governorRequestRender('fire-history-replay-reset');
    notifyRow();
  }

  function cycleSpeed() {
    if (!_replay) return;
    _replay = setReplaySpeed(_replay, cycleReplaySpeed(_replay.speed));
    notifyRow();
  }

  const replayHandlers = {
    onToggle: toggleReplay,
    onReset: resetReplayView,
    onSpeed: cycleSpeed,
  };

  function frameEvent(event) {
    const camera = _viewer?.camera;
    if (!camera || !event) return;
    const [west, south, east, north] = event.bbox;
    const pad = Math.max(
      FRAME_PADDING_MIN_DEG,
      FRAME_PADDING_RATIO * Math.max(east - west, north - south),
    );
    // Take the camera the same way other layer-owned flights do, so a
    // pending startup or deferred destination cannot land on top of the
    // event a moment later.
    announceNavigationAuthority('fire-history-focus');
    camera.cancelFlight?.();
    camera.flyTo({
      destination: Cesium.Rectangle.fromDegrees(
        west - pad,
        south - pad,
        east + pad,
        north + pad,
      ),
      duration: CAMERA_FLIGHT_SECONDS,
    });
  }

  /**
   * Load the registry (once) and the selected event's detections. Any
   * in-flight load is superseded; a late response cannot paint over a
   * newer selection.
   */
  async function load({ flyTo = false } = {}) {
    if (!_enabled || !_points) return false;
    _request?.abort();
    const request = new AbortController();
    _request = request;
    _loading = true;
    notifyRow();
    const current = () =>
      !request.signal.aborted && _request === request && _enabled;
    try {
      if (!_events.length) {
        const catalog = await source.listEvents({ signal: request.signal });
        if (!current()) return false;
        _events = catalog.events;
      }
      const event = selectEvent(_events, _selectedId);
      if (!event) {
        _event = null;
        _fires = [];
        _timeline = [];
        _replay = null;
        _lastError = 'No registered fire events';
        clearScene();
        return false;
      }
      _selectedId = event.id;
      const payload = await source.getEvent(event.id, {
        signal: request.signal,
      });
      if (!current()) return false;
      if (payload.keyRequired) {
        _keyRequired = true;
        _event = event;
        _fires = [];
        _timeline = [];
        _replay = null;
        _lastError = null;
        clearScene();
        return false;
      }
      _keyRequired = false;
      _event = payload.event;
      _complete = payload.complete !== false;
      _fires = adaptFireHistoryRecords(payload.fires, _event);
      _timeline = buildEventTimeline(_fires, _event);
      // A refresh keeps an engaged clock's position; a new event parks idle.
      _replay =
        _replay &&
        replayActive(_replay) &&
        _replay.startMs === createReplayState(_event)?.startMs
          ? _replay
          : createReplayState(_event, _replay?.speed ?? 1);
      renderFires(_event, _fires);
      applyReplayFrame();
      if (flyTo) frameEvent(_event);
      _lastUpdate = Date.now();
      _lastError = null;
      console.log(
        `[Data:FireHistory] ${_event.name}: ${_fires.length} archived detections`,
      );
      return true;
    } catch (error) {
      if (!current()) return false;
      console.warn('[Data:FireHistory] load error:', error);
      _lastError = error?.message || 'Fire archive unavailable';
      return false;
    } finally {
      if (_request === request) {
        _request = null;
        _loading = false;
        notifyRow();
      }
    }
  }

  /**
   * Apply a selection locally. Reloads only while enabled; a disabled layer
   * (share-link restore before enable) just remembers the id.
   */
  function selectEventId(id) {
    if (!id || id === _selectedId) return;
    _selectedId = id;
    if (!_enabled) return;
    _fires = [];
    _timeline = [];
    _replay = _replay ? { ...resetReplay(_replay), status: 'idle' } : null;
    stopReplayLoop();
    clearScene();
    void load({ flyTo: true });
  }

  const layer = {
    id: FIRE_HISTORY_LAYER_ID,
    name: 'Historic Fires',
    icon: '🔥',
    source: 'NASA FIRMS · ARCHIVE',
    // Same registry id as the live layer: the same MAP_KEY unlocks both.
    requiresKeyId: 'firms',
    updateInterval: ARCHIVE_REFRESH_MS,

    init(viewer) {
      if (_viewer)
        throw new Error('Historic fires layer is already initialized');
      _viewer = viewer;
      _points = viewer.scene.primitives.add(
        new Cesium.PointPrimitiveCollection(),
      );
      _points.show = false;
      overlayHost.setVisible(FIRE_HISTORY_OVERLAY_SOURCE_ID, false);
      if (typeof document !== 'undefined') {
        _panel = createFireHistoryPanel({ layer });
        _panel.mount();
      }
      console.log('[Data:FireHistory] Initialized');
    },

    enable() {
      _enabled = true;
      if (_points) _points.show = true;
      overlayHost.setVisible(FIRE_HISTORY_OVERLAY_SOURCE_ID, true);
      _panel?.setVisible(true);
      _panel?.render();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      _loading = false;
      if (_replay) _replay = resetReplay(_replay);
      stopReplayLoop();
      if (_points) _points.show = false;
      overlayHost.setVisible(FIRE_HISTORY_OVERLAY_SOURCE_ID, false);
      _panel?.setVisible(false);
    },

    async update() {
      // First load after enable frames the event; later refreshes (the
      // 24 h archive tick) repaint in place.
      return load({ flyTo: !_lastUpdate });
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      _loading = false;
      stopReplayLoop();
      overlayHost.clearSource(FIRE_HISTORY_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(FIRE_HISTORY_OVERLAY_SOURCE_ID, false);
      if (_points) {
        viewer?.scene?.primitives?.remove(_points);
        _points = null;
      }
      _pointsByIndex = [];
      _panel?.unmount();
      _panel = null;
      _viewer = null;
      _events = [];
      _event = null;
      _fires = [];
      _timeline = [];
      _replay = null;
      _lastUpdate = null;
      _lastError = null;
      _keyRequired = false;
    },

    /** Event chips, replay transport chips and the progress legend. */
    getRowControls() {
      const controls = fireHistoryRowControls({
        events: _events,
        selectedId: _selectedId,
        loading: _loading,
        fires: _fires,
      });
      return {
        chips: [
          ...controls.chips,
          ...replayRowChips(_replay, replayHandlers, replayReady()),
        ],
        legend: controls.legend,
      };
    },

    setRowControlsListener(listener) {
      _rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    /**
     * Programmatic selection (voice tools, context panel). Routed through
     * the manager when attached so the choice settles as a layer param and
     * reaches share links; otherwise applied directly.
     * @param {string} id
     * @param {{origin?: string}} [options]
     */
    selectEvent(id, { origin = 'programmatic' } = {}) {
      const eventId = String(id || '');
      if (!eventId || eventId === _selectedId) return;
      if (typeof _dataManager?.setLayerParams === 'function') {
        void _dataManager.setLayerParams(
          FIRE_HISTORY_LAYER_ID,
          { eventId },
          { origin },
        );
        return;
      }
      selectEventId(eventId);
    },

    /** Keep a manager handle so selections can settle as params. */
    attachDataManager(dataManager) {
      _dataManager = dataManager || null;
    },

    /** Share-link and manager params: the selected event id. */
    getParams() {
      return { eventId: _selectedId };
    },

    /**
     * Accept `{eventId}` from the manager (user chip, voice, share restore).
     * Unknown keys are ignored; an empty id is a no-op.
     * @param {{eventId?: string}} params
     * @returns {boolean}
     */
    setParams(params = {}) {
      if (Object.hasOwn(params, 'eventId') && params.eventId) {
        selectEventId(String(params.eventId));
      }
      return true;
    },

    /** Fly the camera back to the shown event's box. */
    focusEvent() {
      if (_event) frameEvent(_event);
    },

    /** Transport for the panel and voice: play/pause, reset, speed, seek. */
    toggleReplay,
    resetReplay: resetReplayView,
    setReplaySpeed(speed) {
      if (!_replay) return;
      _replay = setReplaySpeed(_replay, Number(speed));
      notifyRow();
    },
    seekReplay(fraction) {
      if (!_replay || !replayReady()) return;
      _replay = seekReplay(_replay, Number(fraction));
      applyReplayFrame();
      governorRequestRender('fire-history-replay-seek');
      notifyRow();
    },

    /** Clock snapshot plus detection counts at the cursor. */
    getReplayState() {
      if (!_replay) return null;
      return {
        ..._replay,
        ...replayCounts(_fires, _replay.cursorMs),
        total: _fires.length,
      };
    },

    /** Registered events and the shown event's per-day timeline. */
    getEventState() {
      return {
        events: _events,
        selectedId: _selectedId,
        event: _event,
        timeline: _timeline,
        count: _fires.length,
      };
    },

    /**
     * Snapshot detections for the analyst query engine. On-demand only.
     * @param {number} [maxCount=2000]
     * @returns {Array<object>}
     */
    getAnalystRecords(maxCount = 2000) {
      if (!_enabled || !_event) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      return _fires
        .slice(0, limit)
        .map((fire) => mapAnalystRecord(fire, _event));
    },

    getStats() {
      const engaged = replayActive(_replay);
      let loadingLabel = '';
      if (_loading)
        loadingLabel = _fires.length ? 'refreshing...' : 'loading...';
      else if (_keyRequired) loadingLabel = 'KEY REQUIRED';
      else if (_lastError) loadingLabel = _lastError;
      else if (engaged) loadingLabel = replayLabel(_replay);
      else if (_event)
        loadingLabel = `${_event.startDate} → ${_event.endDate}${_complete ? '' : ' · PARTIAL'}`;
      const counts = engaged ? replayCounts(_fires, _replay.cursorMs) : null;
      return {
        count: _fires.length,
        ...(counts
          ? {
              countLabel: `${compactCount(counts.shown)} / ${compactCount(_fires.length)}`,
            }
          : {}),
        lastUpdate: _lastUpdate,
        loading: _loading,
        keyRequired: _keyRequired,
        error: _keyRequired ? 'KEY REQUIRED' : _lastError,
        loadingLabel,
      };
    },
  };
  return layer;
}
