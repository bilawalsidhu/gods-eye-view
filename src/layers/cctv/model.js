import * as Cesium from 'cesium';
import { staticFrameRefreshMs } from '../../data/cctvLod.js';
import { frameFetchDue, cardFetchPolicy } from '../../data/cctvCards.js';
import { DEFAULT_CAMERA_CALIBRATION } from './policy.js';

export function createModel({ state: layerState, services, parts, source }) {
  const { focusPassIsNeeded, getFocusTarget } = services.focus;

  /**
   * Converts degrees to radians.
   * @param {number} deg
   * @returns {number}
   */

  function toRad(deg) {
    return Cesium.Math.toRadians(deg);
  }

  /**
   * Normalizes a heading angle to the [0, 360) range.
   * @param {number} deg
   * @returns {number}
   */

  function normalizeHeading(deg) {
    let v = deg % 360;
    if (v < 0) v += 360;
    return v;
  }

  /**
   * Clamps a value to [min, max].
   * @param {number} value
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  /**
   * Normalizes an angle to the (-180, 180] range.
   * @param {number} deg
   * @returns {number}
   */

  function normalizeSignedAngle(deg) {
    let value = deg % 360;
    if (value > 180) value -= 360;
    if (value <= -180) value += 360;
    return value;
  }

  /**
   * Returns the absolute angular difference between two headings in degrees.
   * @param {number} aDeg
   * @param {number} bDeg
   * @returns {number} Value in [0, 180].
   */

  function angularDeltaAbs(aDeg, bDeg) {
    return Math.abs(normalizeSignedAngle(aDeg - bDeg));
  }

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

  /**
   * Coerces a value to a finite number or returns the fallback.
   * @param {*} value
   * @param {number} [fallback=NaN]
   * @returns {number}
   */

  function safeNumber(value, fallback = NaN) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  /**
   * Derives a deterministic heading from a camera ID string via a simple hash.
   * Produces one of 16 evenly-spaced headings (0, 22.5, 45, ..., 337.5).
   * @param {string} id
   * @returns {number} Heading in degrees [0, 360).
   */

  function headingFromId(id) {
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

  function quantize(value, step = 0.1) {
    return Math.round(value / step) * step;
  }

  /**
   * Normalizes a coverage-mode request (viewshed design §3b). Accepts the three
   * mode strings plus booleans for `setParams({showCoverage})` back-compat
   * (true → 'on', false → 'off'); anything else keeps the current mode.
   * @param {*} value - Requested mode ('off'|'on'|'viewshed') or boolean.
   * @param {'off'|'on'|'viewshed'} current - Mode to keep when the request is invalid.
   * @returns {'off'|'on'|'viewshed'}
   */

  function normalizeCoverageMode(value, current) {
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

  function offsetDegrees(latDeg, northMeters, eastMeters) {
    const latOffset = northMeters / 111320;
    const lonDivisor = Math.max(0.15, Math.cos(toRad(latDeg)));
    const lonOffset = eastMeters / (111320 * lonDivisor);
    return { latOffset, lonOffset };
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
      // under "block all cookies", so it has to live inside the try (M11).
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
   * Note: the old score-based quality system (`confidenceFromScore`, seeded
   * `camera.quality.score`) is retired — panel trust signal is now the 3-state
   * CAL badge (`deriveCalBadge`, driven by `calSource`/`poseSource`), not a
   * fabricated confidence score.
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
   * Projects a point along a bearing from a given lat/lon by a distance.
   * Uses the spherical-earth direct geodesic formula (R = 6371 km).
   * @param {number} latDeg - Origin latitude (degrees).
   * @param {number} lonDeg - Origin longitude (degrees).
   * @param {number} bearingDeg - Azimuth from north (degrees).
   * @param {number} distanceM - Distance in metres.
   * @returns {{ lat: number, lon: number }} Destination in degrees.
   */

  function projectPoint(latDeg, lonDeg, bearingDeg, distanceM) {
    const angular = distanceM / 6371000;
    const bearing = toRad(bearingDeg);
    const lat1 = toRad(latDeg);
    const lon1 = toRad(lonDeg);

    const sinLat2 =
      Math.sin(lat1) * Math.cos(angular) +
      Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing);
    const lat2 = Math.asin(sinLat2);

    const y = Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1);
    const x = Math.cos(angular) - Math.sin(lat1) * sinLat2;
    const lon2 = lon1 + Math.atan2(y, x);

    return {
      lat: Cesium.Math.toDegrees(lat2),
      lon: Cesium.Math.toDegrees(lon2),
    };
  }

  /**
   * Computes the great-circle distance between two points using the haversine formula.
   * @param {number} lat1 - Latitude of point 1 (degrees).
   * @param {number} lon1 - Longitude of point 1 (degrees).
   * @param {number} lat2 - Latitude of point 2 (degrees).
   * @param {number} lon2 - Longitude of point 2 (degrees).
   * @returns {number} Distance in kilometres.
   */

  function haversineKm(lat1, lon1, lat2, lon2) {
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * Computes the area of a circular sector (camera FOV wedge).
   * @param {number} rangeM - Radius in metres.
   * @param {number} fovDeg - Field of view in degrees.
   * @returns {number} Area in km^2.
   */

  function sectorAreaKm2(rangeM, fovDeg) {
    const theta = toRad(clamp(fovDeg, 12, 170));
    const areaM2 = 0.5 * rangeM * rangeM * theta;
    return areaM2 / 1_000_000;
  }

  /**
   * Returns a coarse grid key describing the viewer's current position and zoom
   * level. Used to detect meaningful view changes for auto-hop camera switching.
   * @returns {string} Grid key in the form "zoomBucket:latGrid:lonGrid".
   */

  function currentViewContext() {
    const carto = layerState._viewer?.camera?.positionCartographic;
    if (!carto) return 'none';
    const lat = Cesium.Math.toDegrees(carto.latitude);
    const lon = Cesium.Math.toDegrees(carto.longitude);
    const alt = carto.height || 0;
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
   * Reports whether the active Google Photorealistic 3D Tileset (if any) has
   * finished loading the tiles in view. Shared mesh-floor sampling is gated on
   * this so a one-shot cell never bakes in a miss from still-streaming tiles.
   * Discovers + caches the tileset lazily from scene
   * primitives (the CCTV module holds only a `_viewer` reference). When no
   * tileset is present (OSM fallback) this returns true so ground sampling is
   * not permanently blocked.
   *
   * Task 5 (review correction, spec §2): a HIDDEN tileset (`show === false`,
   * i.e. a globe stack is active) must NOT report ready — Cesium 1.138's
   * the shared sampler can only inspect *visible* 3D tilesets, so a sample taken
   * against the hidden Google tileset would silently miss.
   *
   * @returns {boolean} True when tiles are loaded AND visible (or no tileset
   *   exists to wait on).
   */

  function projectionTilesReady() {
    if (
      !layerState._activeTileset ||
      layerState._activeTileset.isDestroyed?.()
    ) {
      layerState._activeTileset = null;
      const primitives = layerState._viewer?.scene?.primitives;
      if (primitives && typeof primitives.get === 'function') {
        for (let i = 0; i < primitives.length; i++) {
          const p = primitives.get(i);
          if (p instanceof Cesium.Cesium3DTileset && !p.isDestroyed?.()) {
            layerState._activeTileset = p;
            break;
          }
        }
      }
    }
    if (!layerState._activeTileset) return true;
    if (layerState._activeTileset.show === false) return false;
    return layerState._activeTileset.tilesLoaded === true;
  }

  /**
   * Orientation quaternion for the monitor plane entity: local +Z is the plane
   * normal, pointing BACK along the view axis toward the mount so the textured
   * front face reads correctly from the natural viewpoint (focusCamera flies the
   * viewer to look along the camera heading). Local +X = viewer-right, +Y =
   * frame-up, so the 16:9 texture maps upright and unmirrored. Static geometry —
   * computed only on slider/save/activation, never per frame (§2b).
   * @param {Object} camera - Camera pose.
   * @param {Cesium.Cartesian3} capCenterPos - Plane center in ECEF.
   * @returns {Cesium.Quaternion}
   */

  function planeOrientationFor(camera, capCenterPos) {
    const frame = parts.geometry.frustumFrameEcef(camera, capCenterPos);
    const right = Cesium.Cartesian3.cross(
      frame.dir,
      frame.up,
      new Cesium.Cartesian3(),
    );
    const normal = Cesium.Cartesian3.negate(frame.dir, new Cesium.Cartesian3());
    const m = new Cesium.Matrix3(
      right.x,
      frame.up.x,
      normal.x,
      right.y,
      frame.up.y,
      normal.y,
      right.z,
      frame.up.z,
      normal.z,
    );
    return Cesium.Quaternion.fromRotationMatrix(m);
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
    if (layerState._showProjection && parts.selection.getActiveRecord())
      return true;
    return focusPassIsNeeded(
      getFocusTarget(),
      layerState._activeFocusStyleCount,
    );
  }

  /**
   * Card-frame pacer tick (owner finding 3): launches AT MOST one fetch per
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

  /**
   * Reports whether selecting a record must run the full activation path.
   * Disable re-arms the still-active record so its obstruction probe runs again
   * on its next real activation after the temporary clamp is cleared.
   * @param {string} cameraId Requested camera ID.
   * @param {string|null} activeCameraId Current active camera ID.
   * @param {Object|null} record Requested camera runtime record.
   * @returns {boolean} Whether activation work must run.
   */

  function cctvRecordNeedsActivation(cameraId, activeCameraId, record) {
    return cameraId !== activeCameraId || record?.activationDone !== true;
  }
  return {
    toRad,
    normalizeHeading,
    clamp,
    normalizeSignedAngle,
    angularDeltaAbs,
    normalizeFeedType,
    isVideoFeedType,
    safeNumber,
    headingFromId,
    quantize,
    normalizeCoverageMode,
    offsetDegrees,
    safeWindowLocalStorage,
    ensureCameraPose,
    projectPoint,
    haversineKm,
    sectorAreaKm2,
    currentViewContext,
    projectionTilesReady,
    planeOrientationFor,
    projectionLoopIsNeeded,
    cardFrameTick,
    cctvRecordNeedsActivation,
  };
}
