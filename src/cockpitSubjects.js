/**
 * Camera policy for first-person subjects other than aircraft: where a
 * vessel's bridge eye sits and how its reported fix advances between feed
 * refreshes. No DOM or i18n dependencies, so the policy is unit-testable.
 */
import { projectGroundArcLatLon } from './data/motionModel.js';

/** Bridge cameras look along the horizon; a ship's eye is already high. */
export const VESSEL_BRIDGE_PITCH_DEG = -2;

/** The AIS antenna usually sits on the bridge, so the eye is not moved forward. */
export const VESSEL_BRIDGE_FORWARD_OFFSET_M = 0;

/** Clearance over the shared ground floor for a camera that floats on water. */
export const VESSEL_BRIDGE_MIN_CLEARANCE_M = 2;

/** Eye height used when the vessel layer knows no height for the type. */
export const VESSEL_DEFAULT_EYE_HEIGHT_M = 12;

/**
 * A reported fix older than this stops advancing: the vessel holds where the
 * last projection left it instead of sailing on through a feed outage.
 */
export const VESSEL_DEAD_RECKON_MAX_S = 180;

/**
 * The vessel layer floats every ship on the geoid (mean sea level), but a
 * river or lake can sit well above it: the Seine through Paris is ~27 m up,
 * which put a bridge eye under the water. The bridge reads the rendered
 * surface around its ship instead: probes on a ring this far out, plus one
 * at the ship itself.
 */
export const VESSEL_WATERLINE_PROBE_RADIUS_M = 30;

/** Probes on the ring around the ship. */
export const VESSEL_WATERLINE_PROBE_COUNT = 8;

/** How often the bridge reads the water under its ship again, ms. */
export const VESSEL_WATERLINE_REFRESH_MS = 5000;

/** A surface less than this above sea level is the sea itself, metres. */
export const VESSEL_WATERLINE_MIN_RISE_M = 2;

/** Highest navigable water trusted from a sample (Lake Titicaca ~3,810 m). */
export const VESSEL_WATERLINE_MAX_RISE_M = 4000;

/**
 * Where to read the surface around a ship: the ship's own position, then a
 * ring of probes around it.
 * @param {number} latitude
 * @param {number} longitude
 * @returns {Array<{lat: number, lon: number}>}
 */
export function waterlineProbePoints(
  latitude,
  longitude,
  radiusM = VESSEL_WATERLINE_PROBE_RADIUS_M,
  count = VESSEL_WATERLINE_PROBE_COUNT,
) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
  const points = [{ lat: latitude, lon: longitude }];
  const metresPerDegLat = 111_320;
  const metresPerDegLon =
    metresPerDegLat * Math.max(0.01, Math.cos((latitude * Math.PI) / 180));
  for (let i = 0; i < count; i += 1) {
    const bearing = (2 * Math.PI * i) / count;
    points.push({
      lat: latitude + (radiusM * Math.cos(bearing)) / metresPerDegLat,
      lon: longitude + (radiusM * Math.sin(bearing)) / metresPerDegLon,
    });
  }
  return points;
}

/**
 * The water surface a bridge floats on, ellipsoidal metres. Quays, bridges,
 * moored boats and the ship's own model all stand above the water, so the
 * lowest probe is the water. A lowest probe barely above sea level is the
 * sea; one implausibly high is a bad sample. Either way the geoid stands.
 * @param {number} seaSurfaceM The geoid sea surface the layer floats ships on.
 * @param {Array<number|null|undefined>} sampleHeightsM Rendered-surface probes.
 * @returns {number}
 */
export function vesselWaterlineM(seaSurfaceM, sampleHeightsM) {
  const heights = (sampleHeightsM || []).filter(Number.isFinite);
  if (!Number.isFinite(seaSurfaceM) || !heights.length) return seaSurfaceM;
  const lowest = Math.min(...heights);
  const rise = lowest - seaSurfaceM;
  return rise >= VESSEL_WATERLINE_MIN_RISE_M &&
    rise <= VESSEL_WATERLINE_MAX_RISE_M
    ? lowest
    : seaSurfaceM;
}

/**
 * Camera placement for a vessel subject, in the shape the Cockpit camera
 * reads for every subject kind.
 * @param {{eyeHeightM?: number|null}} info Vessel subject info.
 * @returns {{forwardM: number, upM: number, pitchDeg: number, minClearanceM: number}}
 */
export function vesselCameraProfile(info) {
  return {
    forwardM: VESSEL_BRIDGE_FORWARD_OFFSET_M,
    upM: Number.isFinite(info?.eyeHeightM)
      ? info.eyeHeightM
      : VESSEL_DEFAULT_EYE_HEIGHT_M,
    pitchDeg: VESSEL_BRIDGE_PITCH_DEG,
    minClearanceM: VESSEL_BRIDGE_MIN_CLEARANCE_M,
  };
}

/**
 * How old a vessel's fix is now, seconds, or null without a fix time.
 *
 * The fix time is on the AIS feed's clock and `nowMs` on this client's, so
 * comparing them directly would turn a client clock running minutes fast
 * into minutes of age (every bridge projecting its full limit and reading
 * STALE FEED). With the time this client first received the fix (client
 * clock) and the newest fix in that refresh (feed clock), the age is the
 * time since the fix arrived plus how far it trailed that newest fix; each
 * part is read on one clock. A fix the feed keeps re-serving keeps its first
 * receipt, so it ages into STALE FEED. The age leaves out the newest fix's
 * own delay before the refresh, typically seconds: a feed that was already
 * stalled when the bridge first saw it ages from then. Without them it falls
 * back to the clock difference, never negative.
 * @param {{fixEpochMs: number|null, receivedAtMs?: number|null,
 *   feedEpochMs?: number|null}} fix
 * @param {number} nowMs Wall-clock time, ms.
 * @returns {number|null}
 */
export function vesselFixAgeSec(fix, nowMs) {
  const { fixEpochMs, receivedAtMs, feedEpochMs } = fix || {};
  if (!Number.isFinite(fixEpochMs) || !Number.isFinite(nowMs)) return null;
  if (Number.isFinite(receivedAtMs) && Number.isFinite(feedEpochMs))
    return (
      Math.max(0, (nowMs - receivedAtMs) / 1000) +
      Math.max(0, (feedEpochMs - fixEpochMs) / 1000)
    );
  return Math.max(0, (nowMs - fixEpochMs) / 1000);
}

/**
 * Advance a vessel's last reported fix along its course over ground.
 *
 * The vessel layer redraws a ship only when the feed refreshes, so its icon
 * stands still between fixes. A camera converging on that still point would
 * sail backwards against its own motion. Projecting the fix forward gives the
 * Cockpit anchor a moving target, and the bounded age keeps a silent feed from
 * carrying the ship away indefinitely.
 * @param {{latitude: number, longitude: number, courseDeg: number|null,
 *   speedMps: number|null, fixEpochMs: number|null,
 *   receivedAtMs?: number|null, feedEpochMs?: number|null}} fix Last
 *   report; its age is `vesselFixAgeSec`.
 * @param {number} nowMs Wall-clock time, ms.
 * @returns {{latitude: number, longitude: number, ageSec: number|null}}
 */
export function deadReckonVesselFix(fix, nowMs) {
  const { latitude, longitude, courseDeg, speedMps } = fix || {};
  const ageSec = vesselFixAgeSec(fix, nowMs);
  if (ageSec === null) return { latitude, longitude, ageSec: null };
  const { lat, lon } = projectGroundArcLatLon(
    latitude,
    longitude,
    courseDeg,
    speedMps,
    0,
    Math.min(ageSec, VESSEL_DEAD_RECKON_MAX_S),
  );
  return { latitude: lat, longitude: lon, ageSec };
}
