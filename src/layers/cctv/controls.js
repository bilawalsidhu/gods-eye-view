import {
  DEFAULT_UPDATE_INTERVAL_MS,
  MIN_AUTO_HOP_SEC,
  MAX_AUTO_HOP_SEC,
  DEFAULT_CAMERA_CALIBRATION,
  CALIBRATION_RANGE_FLOOR_M,
} from './policy.js';

export function createControls({ state: layerState, services, parts, source }) {
  const { holdContinuousRender, releaseContinuousRender } = services.render;
  const { CCTV_ACTIVATION_RESULT } = services.activation;

  const methods = {
    id: 'cctv',

    name: 'CCTV',

    icon: '📹',

    source: 'Public CCTV catalogs',

    updateInterval: DEFAULT_UPDATE_INTERVAL_MS,

    /**
     * Applies runtime parameter changes: coverage/projection toggles, auto-hop
     * settings, camera selection, and calibration patches/resets.
     * @param {Object} [params={}] - Parameter object.
     * @param {boolean} [params.showCoverage] - Back-compat coverage toggle (true→'on', false→'off').
     * @param {'off'|'on'|'viewshed'} [params.coverageMode] - Full coverage-mode API.
     * @param {boolean} [params.showProjection] - Toggle projection overlay visibility.
     * @param {boolean} [params.autoHop] - Enable/disable auto-hop.
     * @param {number} [params.autoHopSec] - Auto-hop interval in seconds.
     * @param {string} [params.selectedCameraId] - Camera ID to activate.
     * @param {Object} [params.calibration] - Calibration config: `patch` edits
     *   the live pose (save-gated — no persistence), `save` persists the current
     *   calibration as manual, `reset` restores the base prior.
     * @param {boolean} [params.calibrationMode] - Toggle the ADJUST gizmo.
     * @param {boolean} [params.focusSelected] - Fly to the active camera.
     * @param {number} [params.focusDurationSec] - Fly-to duration.
     */
    setParams(params = {}) {
      if (typeof params.showCoverage === 'boolean') {
        layerState._coverageMode = parts.model.normalizeCoverageMode(
          params.showCoverage,
          layerState._coverageMode,
        );
      }
      if (typeof params.coverageMode === 'string') {
        layerState._coverageMode = parts.model.normalizeCoverageMode(
          params.coverageMode,
          layerState._coverageMode,
        );
      }
      if (typeof params.showProjection === 'boolean') {
        layerState._showProjection = params.showProjection;
        if (layerState._showProjection) {
          const active = parts.selection.getActiveRecord();
          if (active) parts.projection.ensureProjectionRuntime(active);
          parts.projection.startProjectionLoop();
        }
      }
      if (typeof params.autoHop === 'boolean') {
        layerState._autoHop = params.autoHop;
        if (params.autoHop) layerState._autoHopSuspended = false;
      }
      if (
        typeof params.autoHopSec === 'number' &&
        Number.isFinite(params.autoHopSec)
      ) {
        layerState._autoHopSec = parts.model.clamp(
          Math.round(params.autoHopSec),
          MIN_AUTO_HOP_SEC,
          MAX_AUTO_HOP_SEC,
        );
      }
      if (
        typeof params.selectedCameraId === 'string' &&
        layerState._recordById.has(params.selectedCameraId)
      ) {
        parts.selection.setActiveCamera(params.selectedCameraId);
      }
      if (params.calibration && typeof params.calibration === 'object') {
        const calibrationCfg = params.calibration;
        const targetCameraId =
          typeof calibrationCfg.cameraId === 'string' && calibrationCfg.cameraId
            ? calibrationCfg.cameraId
            : layerState._activeCameraId;
        const targetRecord = targetCameraId
          ? layerState._recordById.get(targetCameraId)
          : null;
        if (targetRecord) {
          if (calibrationCfg.reset) {
            // RESET: back to the base prior, delete the persisted entry, clear
            // the dirty flag (semantics unchanged from v2).
            targetRecord.camera.calibration =
              parts.calibration.normalizeCalibration(
                DEFAULT_CAMERA_CALIBRATION,
              );
            targetRecord.camera.calSource = null;
            targetRecord.calDirty = false;
            parts.model.ensureCameraPose(targetRecord.camera);
            layerState._calibrationById.delete(targetCameraId);
            parts.calibration.saveCalibrationStore();
            // Reset returns to the base lat/lon, so resolve that anchor once,
            // and the footprint under the restored pose.
            parts.ground.resolveCommittedGroundAnchor(targetRecord);
            void parts.ground.resolveFootprintGround(targetRecord);
            parts.frames.refreshProjectionImage(targetRecord, true);
          }
          if (
            calibrationCfg.patch &&
            typeof calibrationCfg.patch === 'object'
          ) {
            // Save-gated persistence (design §3e): a patch edits the LIVE pose
            // only. The store — and the CALIBRATED badge's `calSource` — move
            // exclusively on the explicit `save` action below. (§9.1 range-slider
            // clamp override + B9b re-ground live inside applyCalibrationPatch.)
            parts.calibration.applyCalibrationPatch(
              targetRecord,
              calibrationCfg.patch,
            );
          }
          if (calibrationCfg.save) {
            // SAVE CAL: persist the current in-memory calibration with manual
            // provenance. Saving an all-default calibration clears the entry
            // (a no-op calibration is not a calibration).
            if (
              parts.calibration.isDefaultCalibration(
                targetRecord.camera.calibration,
              )
            ) {
              targetRecord.camera.calSource = null;
              layerState._calibrationById.delete(targetCameraId);
            } else {
              targetRecord.camera.calSource = 'manual';
              layerState._calibrationById.set(targetCameraId, {
                values: { ...targetRecord.camera.calibration },
                source: 'manual',
                savedAt: Date.now(),
                // Authored against the current range floor: never migrated.
                rangeFloorM: CALIBRATION_RANGE_FLOOR_M,
              });
            }
            targetRecord.calDirty = false;
            parts.calibration.saveCalibrationStore();
          }
        }
      }
      if (typeof params.calibrationMode === 'boolean') {
        layerState._calibrationMode = params.calibrationMode;
        if (layerState._calibrationMode) {
          parts.calibration.ensureGizmo();
          layerState._gizmo?.setEnabled(true);
          // ADJUST mode: gizmo drags mutate entity geometry from pointer events,
          // which don't trigger renders in requestRenderMode. (perf wave 2)
          holdContinuousRender('cctv-adjust');
        } else {
          releaseContinuousRender('cctv-adjust');
          layerState._gizmo?.setEnabled(false);
        }
      }
      if (params.focusSelected && layerState._activeCameraId) {
        parts.navigation.focusCamera(
          layerState._activeCameraId,
          Number(params.focusDurationSec) || 1.8,
        );
      }
      parts.rendering.refreshCoverageStyles();
      parts.presentation.notifyListeners();
    },

    /**
     * Returns the current runtime parameters including toggle states,
     * active camera, and calibration values.
     * @returns {Object}
     */
    getParams() {
      const active = parts.selection.getActiveRecord();
      return {
        showCoverage: layerState._coverageMode !== 'off',
        coverageMode: layerState._coverageMode,
        showProjection: layerState._showProjection,
        calibrationMode: layerState._calibrationMode,
        autoHop: layerState._autoHop,
        autoHopSec: layerState._autoHopSec,
        selectedCameraId: active?.camera.id || null,
        calibration: active?.camera
          ? {
              cameraId: active.camera.id,
              values: {
                ...parts.calibration.normalizeCalibration(
                  active.camera.calibration,
                ),
              },
            }
          : null,
      };
    },

    /**
     * Returns a sampled list of camera positions for the detection overlay system.
     * @param {Object} [options={}]
     * @param {number} [options.maxCount] - Maximum number of objects to return.
     * @param {number} [options.seed] - Offset seed for deterministic stride sampling.
     * @returns {{ position: Cesium.Cartesian3, id: string, type: string }[]}
     */
    getDetectableObjects(options = {}) {
      if (!layerState._enabled || layerState._records.length === 0) return [];
      const maxCount = Number.isFinite(options.maxCount)
        ? Math.max(1, Math.floor(options.maxCount))
        : layerState._records.length;
      const seed = Number.isFinite(options.seed) ? Math.floor(options.seed) : 0;
      const stride = Math.max(
        1,
        Math.ceil(layerState._records.length / maxCount),
      );
      const start = seed % stride;

      const objects = [];
      for (let i = start; i < layerState._records.length; i += stride) {
        const camera = layerState._records[i].camera;
        objects.push({
          position: layerState._records[i].position,
          sourceId: camera.id,
          // Short semantic code where the id is opaque (see cameraDisplayCode).
          id: `CAM-${camera.code || camera.id}`,
          type: 'CAM',
        });
        if (objects.length >= maxCount) break;
      }
      return objects;
    },

    /**
     * Returns basic layer statistics, including initial-load progress while
     * the staggered geometry queue is draining.
     * @returns {{ count: number, lastUpdate: number|null, error: string|null, source: string, fallback: boolean, loading: boolean, loadingLoaded: number, loadingTotal: number }}
     */
    getStats() {
      return {
        count: layerState._count,
        lastUpdate: layerState._lastUpdate,
        error: layerState._lastError,
        source: layerState._catalogFromSeeds
          ? 'Bundled camera positions'
          : methods.source,
        fallback: layerState._catalogFromSeeds,
        loading: layerState._geoLoading,
        loadingLoaded: Math.min(
          layerState._geoLoadDone,
          layerState._geoLoadTotal,
        ),
        loadingTotal: layerState._geoLoadTotal,
      };
    },

    /**
     * Registers a callback that receives the full UI state on every change.
     * The callback is invoked immediately with the current state.
     * @param {Function} callback - Listener function receiving the UI state object.
     * @returns {Function} Unsubscribe function.
     */
    subscribe(callback) {
      if (typeof callback !== 'function') return () => {};
      layerState._listeners.add(callback);
      callback(parts.presentation.uiState());
      return () => {
        layerState._listeners.delete(callback);
      };
    },

    /**
     * Returns the current UI state snapshot without subscribing.
     * @returns {Object}
     */
    getUIState() {
      return parts.presentation.uiState();
    },

    /**
     * Opts the active camera into or out of protected thumbnail publication.
     * The default is false: the monitor plane remains the sole active-camera
     * representation while ambient and hover-pinned cards continue unchanged.
     * @param {Object} [options]
     * @param {boolean} [options.activeCameraCardEnabled=false]
     * @returns {{activeCameraCardEnabled:boolean}}
     */
    setCardPresentationOptions(options = {}) {
      return parts.cards.setCctvCardPresentationOptions(options);
    },

    /**
     * Selects a camera by ID and optionally flies to it.
     * @param {string} cameraId - Camera ID to select.
     * @param {Object} [options={}]
     * @param {boolean} [options.focus] - If true, fly the viewer to the camera.
     * @param {number} [options.durationSec] - Fly-to duration in seconds.
     * @returns {boolean} True if the camera was found and selected.
     */
    selectCamera(cameraId, options = {}) {
      const result = parts.selection.setActiveCamera(cameraId);
      if (result === CCTV_ACTIVATION_RESULT.NOT_FOUND) return false;
      if (options.focus) {
        parts.navigation.focusCamera(cameraId, options.durationSec || 1.8);
      }
      return true;
    },

    /**
     * Flies the viewer to a specific camera.
     * @param {string} cameraId - Camera ID to focus on.
     * @param {number} [durationSec=2.2] - Flight duration in seconds.
     * @returns {'focused'|'no-active-camera'|'tracking-holds-view'|'cockpit-active'} Focus result.
     */
    focusCamera(cameraId, durationSec = 2.2) {
      return parts.navigation.focusCamera(cameraId, durationSec);
    },

    /**
     * Cycles the active camera forward or backward by `step` positions in the catalog.
     * @param {number} [step=1] - Number of positions to advance (negative to go back).
     * @param {Object} [options={}]
     * @param {boolean} [options.focus] - If true, fly to the new camera.
     * @param {number} [options.durationSec] - Fly-to duration in seconds.
     * @returns {string|null} The newly active camera ID, or null if catalog is empty.
     */
    cycleCamera(step = 1, options = {}) {
      if (!layerState._records.length) return null;
      const current = parts.selection.getActiveRecord();
      const nextIdx = parts.navigation.cctvCycleIndex(
        layerState._records.findIndex((record) => record === current),
        step,
        layerState._records.length,
      );
      const nextId = layerState._records[nextIdx].camera.id;
      parts.selection.setActiveCamera(nextId);
      if (options.focus) {
        parts.navigation.focusCamera(nextId, options.durationSec || 1.8);
      }
      return nextId;
    },

    /**
     * Selects and flies to the camera nearest the current viewer position.
     * @param {Object} [options={}]
     * @param {boolean} [options.focus=true] Whether to fly after selection.
     * @param {number} [options.durationSec] - Fly-to duration in seconds.
     * @returns {string|null} The nearest camera ID, or null if none found.
     */
    focusNearest(options = {}) {
      const nearest = parts.navigation.nearestCameraIdToViewer();
      if (!nearest) return null;
      parts.selection.setActiveCamera(nearest);
      if (options.focus !== false) {
        parts.navigation.focusCamera(nearest, options.durationSec || 1.8);
      }
      return nearest;
    },
  };

  return { methods };
}
