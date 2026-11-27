import { stepChips } from '../../data/layerSteps.js';
import {
  ACTIVE_FRAME_REFRESH_MS,
  DEFAULT_UPDATE_INTERVAL_MS,
  MIN_AUTO_HOP_SEC,
  MAX_AUTO_HOP_SEC,
  DEFAULT_CAMERA_CALIBRATION,
  CALIBRATION_RANGE_FLOOR_M,
} from './policy.js';
import { CCTV_HELPER_PICK_ID } from './pickIds.js';
import { isHeadingEstimated } from './headingConfidence.js';
import { t } from '../../i18n/index.js';
import { attachCctvVideo } from './videoPlayback.js';

export function createControls({ state: layerState, services, parts, source }) {
  const { holdContinuousRender, releaseContinuousRender } = services.render;
  const { CCTV_ACTIVATION_RESULT } = services.activation;
  // Prev/Next are offered while a step has somewhere to go.
  const stepsOffered = () => parts.navigation.canStepNearby();

  function applyParams(params) {
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
          // Restore the default pose, delete the saved calibration and clear
          // the dirty flag.
          targetRecord.camera.calibration =
            parts.calibration.normalizeCalibration(DEFAULT_CAMERA_CALIBRATION);
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
        if (calibrationCfg.patch && typeof calibrationCfg.patch === 'object') {
          // A patch edits the live pose. Saving updates the stored calibration
          // and the badge's calSource.
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
        // Gizmo drags change geometry through pointer events, which don't
        // request a frame in requestRenderMode.
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
  }

  const methods = {
    id: 'cctv',

    name: 'CCTV',

    icon: '📹',

    source: 'CCTV + Street View fallback',

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
     * @param {{origin?: string}} [options] - Scene, restore and programmatic camera changes are quiet.
     */
    setParams(params = {}, { origin } = {}) {
      if (
        layerState._recordById.has(params.selectedCameraId) &&
        origin !== undefined &&
        !['user', 'voice', 'tool'].includes(origin)
      ) {
        parts.navigation.quietly(() => applyParams(params));
      } else {
        applyParams(params);
      }
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
     * @returns {{ position: {x: number, y: number, z: number}, id: string, type: string }[]}
     */
    getDetectableObjects(options = {}) {
      // The cameras the view pass shows, not icons it has hidden.
      const records = layerState._viewRecords;
      if (!layerState._enabled || records.length === 0) return [];
      const maxCount = Number.isFinite(options.maxCount)
        ? Math.max(1, Math.floor(options.maxCount))
        : records.length;
      const seed = Number.isFinite(options.seed) ? Math.floor(options.seed) : 0;
      const stride = Math.max(1, Math.ceil(records.length / maxCount));
      const start = seed % stride;

      const objects = [];
      for (let i = start; i < records.length; i += stride) {
        const camera = records[i].camera;
        objects.push({
          // A camera sharing its mount is drawn beside its mates.
          position: records[i].spreadPosition ?? records[i].position,
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
     * Maps a picked id to the camera it belongs to: a camera icon picks as the
     * camera id, its coverage and projection geometry as
     * `cctv-<cameraId>-<role>`.
     * @param {string} pickId - Picked entity id.
     * @param {object} [hit] - Draw-set identity distinguishes a helper from a camera with the same id.
     * @returns {string|null} Camera id, or null when no loaded camera owns it.
     */
    recordIdForPick(pickId, hit) {
      if (hit?.set) return parts.rendering.extractPickedCameraId(hit);
      if (typeof pickId !== 'string') return null;
      if (layerState._recordById.has(pickId)) return pickId;
      const match = CCTV_HELPER_PICK_ID.exec(pickId);
      return match && layerState._recordById.has(match[1]) ? match[1] : null;
    },

    /**
     * Returns the camera's name and position for its card.
     * @param {string} id - Camera id.
     * @returns {{ name: string, latitude: number, longitude: number }|null}
     */
    findByQuery(id) {
      const camera = layerState._recordById.get(id)?.camera;
      if (!camera) return null;
      return { name: camera.name, latitude: camera.lat, longitude: camera.lon };
    },

    getInspectorContextPoints() {
      const records = layerState._enabled ? layerState._records : [];
      return {
        points: (function* () {
          for (const { camera } of records) yield camera;
        })(),
        recordForPoint(camera) {
          return camera;
        },
      };
    },

    /**
     * The cameras the layer has loaded, as plain records (id, name, position)
     * for Context's counts and nearby lists. Empty while the layer is off.
     * @param {number} [maxCount]
     * @returns {{ id: string, name: string, lat: number, lon: number }[]}
     */
    getAnalystRecords(maxCount) {
      if (!layerState._enabled) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(0, Math.floor(maxCount))
        : layerState._records.length;
      const records = [];
      for (const record of layerState._records) {
        if (records.length >= limit) break;
        const camera = record.camera;
        if (!Number.isFinite(camera?.lat) || !Number.isFinite(camera?.lon))
          continue;
        records.push({
          id: String(camera.id),
          name: camera.name || '',
          lat: camera.lat,
          lon: camera.lon,
        });
      }
      return records;
    },

    /**
     * A video camera's own stream, for a view that keeps playing it after the
     * layer's projection lets it go (a docked camera with Cameras off). Null
     * for a still camera, a browser-overlay camera or one the layer does not
     * hold. The records stay while the layer is off.
     * @param {string} cameraId
     * @returns {?{url: string, feedType: string}}
     */
    streamSourceForCamera(cameraId) {
      const camera = layerState._recordById.get(String(cameraId))?.camera;
      if (!camera || parts.model.isBrowserOverlayCamera(camera)) return null;
      const feedType = parts.model.normalizeFeedType(camera.feedType);
      if (!parts.model.isVideoFeedType(feedType)) return null;
      return { url: source.getMediaUrl(camera), feedType };
    },

    /**
     * Play a stream from `streamSourceForCamera` into a muted, inline video
     * element: one connection, released (and its lease returned) by the
     * handle's `dispose()`; `onFailure` hears a stream that cannot play.
     * @param {HTMLVideoElement} video
     * @param {{url: string, feedType: string}} stream
     * @param {{onFailure?: () => void}} [options]
     * @returns {{dispose: () => void}}
     */
    attachCameraStream(video, stream, { onFailure = () => {} } = {}) {
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = 'anonymous';
      video.preload = 'auto';
      return attachCctvVideo(video, stream.url, stream.feedType, { onFailure });
    },

    /**
     * A pinned camera's still with a refresh interval of at least 10 seconds.
     * Québec overlays and streams without a registered snapshot have no still.
     * @param {string} cameraId
     * A source with a frame reader also supplies readImage(signal), which returns
     * the response's source kind, a temporary display URL and its release function.
     * @returns {?{url: string, refreshMs: number, readImage?: Function}}
     */
    frameUrlForCamera(cameraId) {
      const camera = layerState._recordById.get(String(cameraId))?.camera;
      if (!camera || parts.model.isBrowserOverlayCamera(camera)) return null;
      const snapshotOnly = parts.model.isVideoFeedCamera(camera);
      if (snapshotOnly && !camera.hasSnapshot) return null;
      const refreshMs = Math.max(
        10_000,
        Number.isFinite(camera.frameRefreshMs) ? camera.frameRefreshMs : 0,
      );
      return {
        url: source.getFrameUrl(camera, refreshMs, { snapshotOnly }),
        ...(typeof source.getFrame === 'function' && {
          async readImage(signal, { liveOnly = false } = {}) {
            const { bytes, contentType, sourceKind } = await source.getFrame(
              camera,
              { refreshMs, snapshotOnly, liveOnly, signal },
            );
            signal?.throwIfAborted();
            const url = URL.createObjectURL(
              new Blob([bytes], { type: contentType }),
            );
            return { url, sourceKind, release: () => URL.revokeObjectURL(url) };
          },
        }),
        refreshMs,
      };
    },

    /**
     * What a camera's card shows about it: where it looks, how often its
     * frame refreshes, and who runs its feed. Null for an unknown camera.
     * @param {string} cameraId
     */
    cameraDetails(cameraId) {
      const camera = layerState._recordById.get(String(cameraId))?.camera;
      if (!camera) return null;
      const finite = (value) => (Number.isFinite(value) ? value : null);
      const words = (value) =>
        (typeof value === 'string' && value.trim()) || null;
      const stills =
        !parts.model.isVideoFeedCamera(camera) || camera.hasSnapshot === true;
      return {
        name: words(camera.name),
        city: words(camera.city),
        provider: words(camera.provider),
        // The owner a partner-supplied feed inside a pack names.
        credit: words(camera.credit),
        feedType: words(camera.feedType),
        browserOnly: parts.model.isBrowserOverlayCamera(camera),
        headingDeg: finite(camera.headingDeg),
        headingEstimated: isHeadingEstimated(camera),
        fovDeg: finite(camera.fovDeg),
        rangeM: finite(camera.rangeM),
        refreshMs: stills
          ? Math.max(
              ACTIVE_FRAME_REFRESH_MS,
              finite(camera.frameRefreshMs) ?? 0,
            )
          : null,
      };
    },

    /**
     * Returns basic layer statistics, including initial-load progress while
     * the staggered geometry queue is draining.
     * @returns {{ count: number, lastUpdate: number|null, error: string|null, loading: boolean, loadingLoaded: number, loadingTotal: number }}
     */
    getStats() {
      return {
        count: layerState._count,
        lastUpdate: layerState._lastUpdate,
        error: layerState._lastError,
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
     * Picks a camera as a click on it does: it becomes the active camera, its
     * card opened in Context. `center: false` leaves the view to the
     * caller (a pick from a list frames it); otherwise the view flies to it.
     * @param {string} cameraId
     * @param {{origin?: string, center?: boolean}} [options]
     * @returns {boolean} True when the camera is loaded and now active.
     */
    pickById(cameraId, { center = true } = {}) {
      if (!layerState._enabled || !cameraId) return false;
      const result = parts.selection.setActiveCamera(String(cameraId));
      if (result === CCTV_ACTIVATION_RESULT.NOT_FOUND) return false;
      if (center) parts.navigation.focusCamera(String(cameraId), 1.8);
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
     * Selects a camera and optionally flies to it (see navigation.stepNearbyCamera).
     * @param {number} direction Negative for previous, otherwise next.
     * @param {{focus?: boolean, durationSec?: number}} [options]
     * @returns {?{cameraId: string, focusResult: ?string}}
     */
    stepNearbyCamera(direction, options = {}) {
      return parts.navigation.stepNearbyCamera(direction, options);
    },

    /**
     * Context's Cameras list area, for Prev/Next to walk the same list.
     * @param {?{lat: number, lon: number, radiusKm: number, order?: string[], restart?: boolean}} area
     */
    setNearbyArea(area) {
      // The row's arrows change only when whether a step is offered changes.
      const offered = stepsOffered();
      parts.navigation.setNearbyArea(area);
      if (stepsOffered() !== offered) layerState._panel?.invalidate();
    },

    /**
     * Prev and Next on the Data Layers row use navigation.stepNearbyCamera.
     */
    getRowControls() {
      if (!stepsOffered()) return null;
      return {
        chips: stepChips(
          'camera',
          t('Previous camera'),
          t('Next camera'),
          parts.navigation.stepNearbyCamera,
        ),
      };
    },

    /**
     * Selects the camera nearest a WGS84 point and optionally flies to it.
     * @param {number} lat Latitude in degrees.
     * @param {number} lon Longitude in degrees.
     * @param {Object} [options={}]
     * @param {boolean} [options.focus=true] Whether to fly after selection.
     * @param {number} [options.durationSec] Fly-to duration in seconds.
     * @returns {string|null} Camera ID, or null (invalid point, empty catalog).
     */
    focusNearestToPoint(lat, lon, options = {}) {
      const nearest = parts.navigation.nearestCameraIdToPoint(lat, lon);
      if (!nearest) return null;
      parts.selection.setActiveCamera(nearest);
      if (options.focus !== false) {
        parts.navigation.focusCamera(nearest, options.durationSec || 1.8);
      }
      return nearest;
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
