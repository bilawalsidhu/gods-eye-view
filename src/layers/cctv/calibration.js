import { createCalibrationGizmo } from '../../data/cctvGizmo.js';
import {
  DEFAULT_CAMERA_CALIBRATION,
  CCTV_CALIBRATION_STORAGE_KEY_V2,
  CALIBRATION_RANGE_FLOOR_M,
  LEGACY_CALIBRATION_RANGE_FLOOR_M,
} from './policy.js';

export function createCalibration({
  state: layerState,
  services,
  parts,
  source,
}) {
  /**
   * Returns whether a calibration patch moves the camera's ground anchor.
   * Rotational, optical, range, and manual-height edits preserve the existing
   * ground reference; only north/east translation needs a new floor.
   * @param {Object|null|undefined} patch
   * @returns {boolean}
   */

  function calibrationPatchMovesAnchor(patch) {
    if (!patch || typeof patch !== 'object') return false;
    return (
      Object.prototype.hasOwnProperty.call(patch, 'offsetNorthM') ||
      Object.prototype.hasOwnProperty.call(patch, 'offsetEastM')
    );
  }

  /**
   * Sanitizes and clamps a calibration object to valid ranges.
   * Missing or non-finite fields fall back to defaults.
   * @param {Object} [value={}] - Raw calibration values.
   * @returns {{ offsetNorthM: number, offsetEastM: number, headingDeg: number, pitchDeg: number, fovDeg: number, rangeScale: number, heightM: number }}
   */

  function normalizeCalibration(value = {}) {
    const raw = value && typeof value === 'object' ? value : {};
    return {
      offsetNorthM: parts.model.quantize(
        parts.model.clamp(
          parts.model.safeNumber(raw.offsetNorthM, 0),
          -900,
          900,
        ),
        0.1,
      ),
      offsetEastM: parts.model.quantize(
        parts.model.clamp(
          parts.model.safeNumber(raw.offsetEastM, 0),
          -900,
          900,
        ),
        0.1,
      ),
      headingDeg: parts.model.quantize(
        parts.model.clamp(parts.model.safeNumber(raw.headingDeg, 0), -180, 180),
        0.1,
      ),
      pitchDeg: parts.model.quantize(
        parts.model.clamp(parts.model.safeNumber(raw.pitchDeg, 0), -45, 45),
        0.1,
      ),
      fovDeg: parts.model.quantize(
        parts.model.clamp(parts.model.safeNumber(raw.fovDeg, 0), -50, 50),
        0.1,
      ),
      rangeScale: parts.model.quantize(
        parts.model.clamp(parts.model.safeNumber(raw.rangeScale, 1), 0.35, 3.0),
        0.01,
      ),
      heightM: parts.model.quantize(
        parts.model.clamp(parts.model.safeNumber(raw.heightM, 0), -120, 240),
        0.1,
      ),
    };
  }

  /**
   * Re-expresses a saved `rangeScale` after the catalog's range floor moved.
   * Entries were authored as a multiplier on the OLD client base range
   * (`max(220, packRange)`); the base is now `max(120, packRange)`, so a camera
   * whose pack range sits below 220 m would silently shrink. Scaling by the
   * ratio of the two bases keeps the user's effective range; the 3× ceiling
   * still applies (an extreme entry loses a little rather than exploding).
   * @param {Object} values - Normalized 7-field calibration.
   * @param {number} packRangeM - The camera's served (pack) range.
   * @returns {Object} A new values object.
   */
  function migrateRangeScaleForFloor(values, packRangeM) {
    const oldBase = parts.model.clamp(
      parts.model.safeNumber(packRangeM, 700),
      LEGACY_CALIBRATION_RANGE_FLOOR_M,
      2200,
    );
    const newBase = parts.model.clamp(
      parts.model.safeNumber(packRangeM, 700),
      CALIBRATION_RANGE_FLOOR_M,
      2200,
    );
    if (oldBase === newBase) return values;
    return normalizeCalibration({
      ...values,
      rangeScale: values.rangeScale * (oldBase / newBase),
    });
  }

  /**
   * Returns true if the given calibration is effectively the default (all offsets near zero).
   * @param {Object} calibration
   * @returns {boolean}
   */

  function isDefaultCalibration(calibration) {
    const probe = normalizeCalibration(calibration);
    return Object.keys(DEFAULT_CAMERA_CALIBRATION).every(
      (key) => Math.abs(probe[key] - DEFAULT_CAMERA_CALIBRATION[key]) < 0.0001,
    );
  }

  /**
   * Loads all persisted per-camera calibration overrides from the v2 store.
   *
   * v2 entries carry provenance: `{ values: <7-field offsets>, source: 'manual',
   * savedAt: <epoch ms> }`. The v1 key (`CCTV_CALIBRATION_STORAGE_KEY_V1`) is
   * NEVER read here — owner decision #3 (§9.3): wipe clean, no legacy import.
   *
   * @param {{getItem:function}|null} [storage] - Injectable storage (defaults
   *   to `window.localStorage`); lets the unit suite test this pure of a DOM.
   * @returns {Map<string, {values:Object, source:string, savedAt:number}>}
   */

  function readCalibrationStoreV2(
    storage = parts.model.safeWindowLocalStorage(),
  ) {
    const map = new Map();
    if (!storage) return map;
    try {
      const raw = storage.getItem(CCTV_CALIBRATION_STORAGE_KEY_V2);
      if (!raw) return map;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return map;
      for (const [cameraId, entry] of Object.entries(parsed)) {
        if (!cameraId || !entry || typeof entry !== 'object') continue;
        if (!entry.values || typeof entry.values !== 'object') continue;
        // 'manual' is the only provenance v2 knows (§9.3 killed 'legacy'); a
        // malformed/foreign source string still normalizes to 'manual' rather
        // than surfacing an unrecognized value into the badge logic.
        map.set(cameraId, {
          values: normalizeCalibration(entry.values),
          source: 'manual',
          savedAt: parts.model.safeNumber(entry.savedAt, 0),
          // Range floor the entry's rangeScale was authored against; absent
          // on entries saved before the floor dropped from 220 m to 120 m.
          rangeFloorM: parts.model.safeNumber(entry.rangeFloorM, NaN),
        });
      }
      return map;
    } catch {
      return map;
    }
  }

  /**
   * Persists a calibration map to the v2 store.
   * @param {Map<string, {values:Object, source:string, savedAt:number}>} map
   * @param {{setItem:function}|null} [storage] - Injectable storage (defaults
   *   to `window.localStorage`).
   */

  function writeCalibrationStoreV2(
    map,
    storage = parts.model.safeWindowLocalStorage(),
  ) {
    if (!storage) return;
    try {
      const payload = {};
      for (const [cameraId, entry] of map.entries()) {
        payload[cameraId] = {
          values: normalizeCalibration(entry.values),
          source: 'manual',
          savedAt: parts.model.safeNumber(entry.savedAt, Date.now()),
          // Only entries that were migrated or saved against the current
          // floor carry the marker; an entry for a camera absent from this
          // catalog keeps its eligibility to migrate when it returns.
          ...(Number.isFinite(entry.rangeFloorM)
            ? { rangeFloorM: entry.rangeFloorM }
            : {}),
        };
      }
      storage.setItem(CCTV_CALIBRATION_STORAGE_KEY_V2, JSON.stringify(payload));
    } catch {
      // storage unavailable
    }
  }

  /**
   * Loads the v2 calibration store. `_calibrationById` holds these entries
   * directly (`{values, source:'manual', savedAt}`) — never bare offset values
   * — so it round-trips straight back through `writeCalibrationStoreV2`.
   * @returns {Map<string, {values:Object, source:string, savedAt:number}>}
   */

  function loadCalibrationStore() {
    return readCalibrationStoreV2();
  }

  /** Persists the in-memory calibration entries (values + provenance) to the v2 store. */

  function saveCalibrationStore() {
    writeCalibrationStoreV2(layerState._calibrationById);
  }

  /**
   * Derives the panel CAL badge state for a camera (design §3b, as amended by
   * the LOCKED §9.2 — panel-only, no in-world tint).
   *
   * Three states:
   *  - 'calibrated' — a human explicitly saved a v2 calibration (`source:'manual'`).
   *  - 'curated'    — no manual save, but the catalog entry was hand-authored
   *                   (`poseSource:'curated'`, file/env sources only).
   *  - 'raw-prior'  — everything else (all Austin Open Data today).
   *
   * Pure — no scoring math, no raycasts. `confidenceFromScore` and score-based
   * quality seeding are retired; this replaces them.
   * @param {{calSource?: string|null, poseSource?: string|null}} camera
   * @returns {'calibrated'|'curated'|'raw-prior'}
   */

  function deriveCalBadge(camera) {
    if (camera?.calSource === 'manual') return 'calibrated';
    if (camera?.poseSource === 'curated') return 'curated';
    return 'raw-prior';
  }

  /**
   * Applies a calibration patch to a record's IN-MEMORY pose (save-gated
   * persistence, design §3e: no localStorage write here — only the explicit
   * `calibration.save` action persists).
   *
   * Transient grade (gizmo mid-drag): recompute pose + frustum geometry only
   * (the cheap v2 path) with throttled notify — no ground re-arm, no frame
   * re-fetch, no store touch.
   * Commit grade (drag end, numeric entry, voice): only an E/N anchor move
   * resolves a new shared floor; all other edits keep the frozen reference.
   *
   * @param {Object} record - Camera record.
   * @param {Object} patch - Partial 7-field calibration (absolute offset values).
   * @param {{transient?: boolean}} [options]
   * @returns {boolean} True when the patch applied.
   */

  function applyCalibrationPatch(record, patch, options = {}) {
    if (!record || !patch || typeof patch !== 'object') return false;
    record.camera.calibration = normalizeCalibration({
      ...record.camera.calibration,
      ...patch,
    });
    parts.model.ensureCameraPose(record.camera);
    // §9.1: touching range takes manual control — clear the activation clamp.
    if ('rangeScale' in patch) {
      record.probeClampRangeM = null;
    }
    const anchorMoved = calibrationPatchMovesAnchor(patch);
    if (options.transient === true && anchorMoved) {
      record.calibrationAnchorDirty = true;
    }
    record.calDirty = true;
    if (options.transient === true) {
      parts.geometry.applyFrustumGeometry(
        record,
        parts.ground.groundAltFor(record),
      );
      parts.presentation.notifyListenersThrottled();
      return true;
    }
    if (anchorMoved) {
      parts.ground.resolveCommittedGroundAnchor(record);
    } else {
      parts.geometry.applyFrustumGeometry(
        record,
        parts.ground.groundAltFor(record),
      );
    }
    // The edited pose has a new footprint; resolve the ground under it once.
    void parts.ground.resolveFootprintGround(record);
    parts.frames.refreshProjectionImage(record, true);
    return true;
  }

  /**
   * Lazily creates the calibration gizmo controller. The gizmo sees the layer
   * only through these callbacks: it attaches to the active record while the
   * layer is enabled AND ADJUST mode is on, funnels drags through
   * applyCalibrationPatch (transient), and runs the commit tail on release.
   */

  function ensureGizmo() {
    if (layerState._gizmo || !layerState._viewer) return;
    // Both patch callbacks receive the gizmo's PINNED drag record — never
    // re-resolve the active camera here: a mid-drag voice select or auto-hop
    // would route the captured offsets onto a camera with a different basePose.
    const liveRecord = (record) =>
      record && layerState._recordById.get(record.camera?.id) === record
        ? record
        : null;
    layerState._gizmo = createCalibrationGizmo({
      viewer: layerState._viewer,
      getActiveRecord: () =>
        layerState._enabled && layerState._calibrationMode
          ? parts.selection.getActiveRecord()
          : null,
      applyPatch: (patch, draggedRecord) => {
        const record =
          layerState._enabled && layerState._calibrationMode
            ? liveRecord(draggedRecord)
            : null;
        if (record) applyCalibrationPatch(record, patch, { transient: true });
      },
      endPatch: (draggedRecord) => {
        const record = liveRecord(draggedRecord);
        if (!record) return;
        // The drag changed the plane's footprint; resolve the ground under
        // the released pose once (revision-guarded, cached proxy).
        void parts.ground.resolveFootprintGround(record);
        if (record.calibrationAnchorDirty) {
          record.calibrationAnchorDirty = false;
          parts.ground.resolveCommittedGroundAnchor(record);
        } else {
          parts.geometry.applyFrustumGeometry(
            record,
            parts.ground.groundAltFor(record),
          );
        }
        parts.frames.refreshProjectionImage(record, true);
        parts.rendering.refreshCoverageStyles();
        parts.presentation.notifyListeners();
      },
    });
  }
  return {
    calibrationPatchMovesAnchor,
    normalizeCalibration,
    isDefaultCalibration,
    migrateRangeScaleForFloor,
    readCalibrationStoreV2,
    writeCalibrationStoreV2,
    loadCalibrationStore,
    saveCalibrationStore,
    deriveCalBadge,
    applyCalibrationPatch,
    ensureGizmo,
  };
}
