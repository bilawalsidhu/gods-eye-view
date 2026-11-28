import { clamp, cross, negate, toRadians } from '../../geo/vector.js';
import { normalizeHeading } from '../../data/headingDegrees.js';
import { fromAxes } from '../../geo/quaternion.js';
import { findCamera } from '../../render/rendererOf.js';
import { staticFrameRefreshMs } from '../../data/cctvLod.js';
import { frameFetchDue, cardFetchPolicy } from '../../data/cctvCards.js';
import { DEFAULT_CAMERA_CALIBRATION } from './policy.js';

/**
 * Coerces a value to a finite number or returns the fallback.
 *
 * Absent, blank and boolean values return the fallback as well. The source
 * list serializes an unknown number (NaN) as JSON null, and `Number(null)`
 * is 0, so without this an unknown pose field arrived as zero and was
 * clamped to the field's floor instead of taking its default.
 * @param {*} value
 * @param {number} [fallback=NaN]
 * @returns {number}
 */

export function safeNumber(value, fallback = NaN) {
  if (
    value == null ||
    typeof value === 'boolean' ||
    (typeof value === 'string' && !value.trim())
  )
    return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Derives a deterministic heading from a camera ID string via a simple hash.
 * Produces one of 16 evenly-spaced headings (0, 22.5, 45, ..., 337.5).
 * @param {string} id
 * @returns {number} Heading in degrees [0, 360).
 */

export function headingFromId(id) {
  const text = String(id || '');
  let acc = 0;
  for (let i = 0; i < text.length; i++) {
    acc = (acc * 33 + text.charCodeAt(i)) >>> 0;
  }
  return normalizeHeading((acc % 16) * 22.5);
}

/**
 * Rounds a value to the nearest multiple of `step`.
 * @param {number} value
 * @param {number} [step=0.1]
 * @returns {number}
 */

export function quantize(value, step = 0.1) {
  return Math.round(value / step) * step;
}

/**
 * Normalizes a coverage-mode request. Accepts the three
 * mode strings plus booleans for `setParams({showCoverage})` back-compat
 * (true → 'on', false → 'off'); anything else keeps the current mode.
 * @param {*} value - Requested mode ('off'|'on'|'viewshed') or boolean.
 * @param {'off'|'on'|'viewshed'} current - Mode to keep when the request is invalid.
 * @returns {'off'|'on'|'viewshed'}
 */

export function normalizeCoverageMode(value, current) {
  if (value === true) return 'on';
  if (value === false) return 'off';
  if (value === 'off' || value === 'on' || value === 'viewshed') return value;
  return current;
}

/**
 * Converts north/east metre offsets to lat/lon degree deltas at a given latitude.
 * Uses the equirectangular approximation (111320 m/deg).
 * @param {number} latDeg - Reference latitude (degrees).
 * @param {number} northMeters - Offset northward (metres).
 * @param {number} eastMeters - Offset eastward (metres).
 * @returns {{ latOffset: number, lonOffset: number }} Degree deltas.
 */

export function offsetDegrees(latDeg, northMeters, eastMeters) {
  const latOffset = northMeters / 111320;
  const lonDivisor = Math.max(0.15, Math.cos(toRadians(latDeg)));
  const lonOffset = eastMeters / (111320 * lonDivisor);
  return { latOffset, lonOffset };
}

/**
 * Computes the area of a circular sector (camera FOV wedge).
 * @param {number} rangeM - Radius in metres.
 * @param {number} fovDeg - Field of view in degrees.
 * @returns {number} Area in km^2.
 */

export function sectorAreaKm2(rangeM, fovDeg) {
  const theta = toRadians(clamp(fovDeg, 12, 170));
  const areaM2 = 0.5 * rangeM * rangeM * theta;
  return areaM2 / 1_000_000;
}

/**
 * Reports whether selecting a record must run the full activation path.
 * Disable re-arms the still-active record so its obstruction probe runs again
 * on its next real activation after the temporary clamp is cleared.
 * @param {string} cameraId Requested camera ID.
 * @param {string|null} activeCameraId Current active camera ID.
 * @param {Object|null} record Requested camera runtime record.
 * @returns {boolean} Whether activation work must run.
 */

export function cctvRecordNeedsActivation(cameraId, activeCameraId, record) {
  return cameraId !== activeCameraId || record?.activationDone !== true;
}

export function createModel({ state: layerState, services, parts, source }) {
  const { focusPassIsNeeded, getFocusTarget } = services.focus;

  /**
   * Normalizes a raw feed-type string to a canonical type (image, mjpeg, mp4, hls, webm).
   * @param {string|*} value - Raw feed type from source config.
   * @returns {string} Canonical feed type.
   */

  function normalizeFeedType(value) {
    const raw = String(value || '')
      .trim()
      .toLowerCase();
    if (!raw) return 'image';
    if (raw === 'mjpg') return 'mjpeg';
    if (raw === 'jpeg') return 'image';
    if (raw === 'jpg') return 'image';
    if (raw === 'video') return 'mp4';
    if (raw === 'stream') return 'hls';
    if (raw === 'png') return 'image';
    if (raw === 'gif') return 'image';
    return raw;
  }

  /**
   * Returns true if the feed type requires a <video> element rather than an <img>.
   * @param {string} feedType
   * @returns {boolean}
   */

  function isVideoFeedType(feedType) {
    return feedType === 'mp4' || feedType === 'hls' || feedType === 'webm';
  }

  /** A browser-only source still counts as live-capable for map icon/LOD policy. */
  function isVideoFeedCamera(camera) {
    return (
      isVideoFeedType(normalizeFeedType(camera?.feedType)) ||
      Boolean(camera?.browserMediaUrl)
    );
  }

  /** Québec source pages and browser-played MP4s use the DOM overlay path. */
  function isBrowserOverlayCamera(camera) {
    return String(camera?.sourceKind || '').startsWith('quebec-');
  }

  /**
   * Returns `window.localStorage` when it is safely accessible, else null.
   * Split out so store IO can be exercised under plain node:test with an
   * injected storage-like object (getItem/setItem/removeItem) instead.
   * @returns {Storage|null}
   */

  function safeWindowLocalStorage() {
    if (typeof window === 'undefined') return null;
    try {
      // NB: the window.localStorage property ACCESS itself throws SecurityError
      // under "block all cookies", so it has to live inside the try.
      return window.localStorage || null;
    } catch {
      return null;
    }
  }

  /**
   * Initializes or recomputes a camera's derived pose fields from its base pose
   * and calibration offsets. Also sets intrinsics, extrinsics, and anchor.
   *
   * On first call for a camera, captures the raw values as `basePose`.
   * Subsequent calls re-derive lat/lon/heading/pitch/fov/range by applying
   * calibration deltas to the frozen base pose.
   *
   * @param {Object} camera - Mutable camera record.
   */

  function ensureCameraPose(camera) {
    if (!camera) return;
    if (!camera.basePose) {
      camera.basePose = {
        lat: safeNumber(camera.lat, 0),
        lon: safeNumber(camera.lon, 0),
        headingDeg: normalizeHeading(safeNumber(camera.headingDeg, 0)),
        pitchDeg: clamp(safeNumber(camera.pitchDeg, -17), -70, 10),
        fovDeg: clamp(safeNumber(camera.fovDeg, 74), 20, 130),
        rangeM: clamp(safeNumber(camera.rangeM, 700), 120, 5000),
        mountHeightM: clamp(safeNumber(camera.mountHeightM, 24), 2, 240),
      };
    }

    const nextCalibration = parts.calibration.normalizeCalibration(
      camera.calibration || DEFAULT_CAMERA_CALIBRATION,
    );
    camera.calibration = nextCalibration;

    const base = camera.basePose;
    const offsets = offsetDegrees(
      base.lat,
      nextCalibration.offsetNorthM,
      nextCalibration.offsetEastM,
    );
    camera.lat = base.lat + offsets.latOffset;
    camera.lon = base.lon + offsets.lonOffset;
    camera.headingDeg = normalizeHeading(
      base.headingDeg + nextCalibration.headingDeg,
    );
    camera.pitchDeg = clamp(base.pitchDeg + nextCalibration.pitchDeg, -70, 10);
    camera.fovDeg = clamp(base.fovDeg + nextCalibration.fovDeg, 20, 130);
    camera.rangeM = clamp(base.rangeM * nextCalibration.rangeScale, 120, 5000);
    camera.mountHeightM = clamp(
      base.mountHeightM + nextCalibration.heightM,
      2,
      240,
    );

    camera.intrinsics = {
      fovDeg: camera.fovDeg,
      principalPoint: [0.5, 0.5],
    };
    camera.extrinsics = {
      headingDeg: camera.headingDeg,
      pitchDeg: camera.pitchDeg,
      rollDeg: 0,
      heightM: camera.mountHeightM,
    };
    camera.anchor = {
      lat: camera.lat,
      lon: camera.lon,
      elevM: safeNumber(camera.groundElevationM, 0),
      targetLatLon: camera.anchor?.targetLatLon || null,
    };
  }

  /**
   * Returns a coarse grid key describing the viewer's current position and zoom
   * level. Used to detect meaningful view changes for auto-hop camera switching.
   * @returns {string} Grid key in the form "zoomBucket:latGrid:lonGrid".
   */

  /**
   * The eye's pose from the camera port, or null when there is no camera or
   * the eye has no geographic position (the earth's centre).
   * @returns {object|null}
   */

  function eyePose() {
    const pose = findCamera(layerState._viewer)?.pose();
    return Number.isFinite(pose?.lat) ? pose : null;
  }

  function currentViewContext() {
    const pose = eyePose();
    if (!pose) return 'none';
    const { lat, lon } = pose;
    const alt = pose.height || 0;
    const zoomBucket =
      alt < 1500
        ? 'street'
        : alt < 12000
          ? 'city'
          : alt < 75000
            ? 'regional'
            : 'global';
    const grid =
      zoomBucket === 'street'
        ? 0.045
        : zoomBucket === 'city'
          ? 0.24
          : zoomBucket === 'regional'
            ? 1.0
            : 4.5;
    return `${zoomBucket}:${Math.floor(lat / grid)}:${Math.floor(lon / grid)}`;
  }

  /**
   * Whether the photoreal tiles in view have finished loading; the rendering
   * part, which reads the scene, answers.
   * @returns {boolean}
   */

  function projectionTilesReady() {
    return parts.rendering.projectionTilesReady();
  }

  /**
   * Orientation quaternion for the monitor plane entity: local +Z is the plane
   * normal, pointing BACK along the view axis toward the mount so the textured
   * front face reads correctly from the natural viewpoint (focusCamera flies the
   * viewer to look along the camera heading). Local +X = viewer-right, +Y =
   * frame-up, so the 16:9 texture maps upright and unmirrored. Static geometry —
   * computed only on slider/save/activation, never per frame.
   * @param {Object} camera - Camera pose.
   * @param {{x: number, y: number, z: number}} capCenterPos - Plane center in ECEF.
   * @returns {{x: number, y: number, z: number, w: number}} The quaternion.
   */

  function planeOrientationFor(camera, capCenterPos) {
    const frame = parts.geometry.frustumFrameEcef(camera, capCenterPos);
    return fromAxes({
      x: cross(frame.dir, frame.up),
      y: frame.up,
      z: negate(frame.dir),
    });
  }

  /**
   * Starts the requestAnimationFrame loop that drives projection canvas updates
   * (frame draw + texture swap) for the active camera.
   */
  /**
   * The projection rAF has real work only while a camera is actively projected
   * or a focus fade is in flight — otherwise it burned a wakeup + style poll
   * every rendered frame for the whole enabled lifetime of the layer. The tick
   * self-stops when idle; every state edge that creates work re-arms it
   * (enable, setActiveCamera, showProjection, focus-target appearance).
   * (perf wave 1)
   * @returns {boolean} Whether the loop currently has work.
   */

  function projectionLoopIsNeeded() {
    if (!layerState._enabled || !layerState._viewer) return false;
    const active = parts.selection.getActiveRecord();
    if (
      layerState._showProjection &&
      active &&
      !isBrowserOverlayCamera(active.camera)
    )
      return true;
    return focusPassIsNeeded(
      getFocusTarget(),
      layerState._activeFocusStyleCount,
    );
  }

  /**
   * Card-frame pacer tick: launches AT MOST one fetch per
   * tick, with cardFetchPolicy deciding whether a launch is allowed. Cold fill
   * — any selected card still missing its FIRST frame — bursts up to 4
   * in-flight fetches at 250 ms spacing so arriving in a new area populates
   * in a few seconds instead of 16-32 s; once every selected card has a first
   * frame the layer drops back to the salvaged steady-state gate (single
   * flight, one request per second). Priority: frameless cards first in ring
   * order (nearest-first — they're what makes a card appear at all), then the
   * stalest refresh-overdue card by its source cadence (staticFrameRefreshMs).
   * Failures back off per camera (frameFetchDue) instead of hammering a dead
   * source, so a dead upstream never eats the burst slots.
   */

  function cardFrameTick() {
    if (
      !layerState._enabled ||
      (!layerState._cardIds.size &&
        !(layerState._activeCameraCardEnabled && layerState._activeCameraId))
    )
      return;
    const now = Date.now();
    let frameless = null;
    let stalest = null;
    let coldFill = false;
    const consider = (id) => {
      const record = layerState._recordById.get(id);
      if (!record) return;
      const slot = parts.cards.ensureCardFrameSlot(id);
      if (layerState._cardFetchPendingIds.has(id)) {
        // An in-flight first-frame fetch keeps cold-fill mode active without
        // being re-launchable.
        if (!(slot.stamp > 0)) coldFill = true;
        return;
      }
      const refreshMs = staticFrameRefreshMs(record.camera);
      if (!frameFetchDue(slot, refreshMs, now)) return;
      if (!(slot.stamp > 0)) {
        coldFill = true;
        if (!frameless) frameless = { record, slot, refreshMs };
        return;
      }
      if (!stalest || slot.stamp < stalest.slot.stamp) {
        stalest = { record, slot, refreshMs };
      }
    };
    // The optional protected active card stays outside the 40-card ambient
    // quota and uses the same source-owned pacing/retry/cache lifecycle.
    if (layerState._activeCameraCardEnabled && layerState._activeCameraId)
      consider(layerState._activeCameraId);
    for (const id of layerState._cardIds) consider(id);
    const policy = cardFetchPolicy({
      // The cold-fill burst yields to the staggered geometry drain: 4 concurrent
      // image fetch+decodes mid-drain starve the mesh-floor queue on weak GPUs
      // (qa-cctv-v2 drain-budget regression). Steady 1/s trickle still runs;
      // the burst fires the moment the drain completes.
      coldFill: coldFill && !layerState._geoLoading,
      inFlight: layerState._cardFetchInFlightCount,
      sinceLastLaunchMs:
        layerState._cardLastFetchAt > 0
          ? now - layerState._cardLastFetchAt
          : Infinity,
    });
    layerState._cardFetchMode = policy.mode;
    if (!policy.launch) return;
    const pick = frameless || stalest;
    if (pick)
      parts.cards.fetchCardFrame(pick.record, pick.slot, pick.refreshMs);
  }

  /**
   * Hidden-state gate (perf wave 2): detach in-flight card frame decodes when
   * the document hides — a hidden canvas has no reader, and image decode is
   * the expensive half. New fetches are gated at fetchCardFrame; the steady
   * pacer refills naturally on return. Owned by the initialized layer and detached on destruction.
   */

  return {
    eyePose,
    normalizeFeedType,
    isVideoFeedType,
    isVideoFeedCamera,
    isBrowserOverlayCamera,
    safeNumber,
    headingFromId,
    quantize,
    normalizeCoverageMode,
    offsetDegrees,
    safeWindowLocalStorage,
    ensureCameraPose,
    sectorAreaKm2,
    currentViewContext,
    projectionTilesReady,
    planeOrientationFor,
    projectionLoopIsNeeded,
    cardFrameTick,
    cctvRecordNeedsActivation,
  };
}
