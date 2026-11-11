/**
 * The selected vessel as a Cockpit bridge subject: identity, motion, its
 * displayed type and a representative bridge eye height from the AIS type.
 * The Cockpit owns camera placement; this module owns what AIS says.
 */
import { normalizeVesselType } from '../../data/vesselTypes.js';
import { displayVesselType } from '../../data/vesselLabels.js';

/** The layer id a vessel subject carries through Cockpit events and state. */
export const VESSEL_COCKPIT_LAYER_ID = 'ais-live-vessels';

/** Knots to metres per second, as the AIS source uses. */
const KNOTS_TO_MPS = 0.514444;

/**
 * Bridge eye height above the waterline by normalized AIS type family. AIS
 * reports no hull height, so these are representative values: deep-sea
 * cargo and tanker bridges, passenger and cruise ship bridges, harbour
 * craft, small craft. River and harbour ferries, matched by name in the
 * patterns below, sit low. Text types from non-numeric feeds fall through
 * to the patterns.
 */
const EYE_HEIGHT_BY_FAMILY = Object.freeze({
  CARGO: 30,
  TANKER: 30,
  PASSENGER: 25,
  MILITARY: 18,
  'HIGH-SPEED': 8,
  DREDGER: 10,
  TOWING: 7,
  TUG: 7,
  PILOT: 6,
  SAR: 6,
  'PORT TENDER': 6,
  'ANTI-POLLUTION': 7,
  'LAW ENFORCE': 7,
  MEDICAL: 7,
  'DIVE OPS': 5,
  FISHING: 6,
  SAILING: 3,
  PLEASURE: 3,
  // AIS "Other" (90-99) is mostly small craft such as river boats. Only
  // that type takes it (see isAisOther).
  OTHER: 4,
});

const EYE_HEIGHT_PATTERNS = Object.freeze([
  { pattern: /tanker|cargo|container|bulk|carrier/i, heightM: 30 },
  { pattern: /passenger|cruise|ro-?ro/i, heightM: 25 },
  // River and harbour ferries: a low wheelhouse just above the water.
  { pattern: /ferry/i, heightM: 4 },
  { pattern: /tug|tow|pilot|supply|service/i, heightM: 7 },
  { pattern: /fishing|trawler/i, heightM: 6 },
  { pattern: /sail|pleasure|yacht/i, heightM: 3 },
]);

/**
 * Whether a raw type is AIS "Other" proper: codes 90 to 99, or a feed's text
 * type. normalizeVesselType also files the reserved, wing-in-ground and
 * spare codes (1-29, 38-39, 56-57, 59) under OTHER, but they name no family.
 */
function isAisOther(type) {
  const text = String(type ?? '').trim();
  if (!/^\d+$/.test(text)) return true;
  const code = Number(text);
  return code >= 90 && code <= 99;
}

/**
 * Representative bridge eye height for an AIS vessel type.
 * @param {string|number} type Raw AIS type: a numeric code or feed text.
 * @returns {number|null} Metres above the waterline, or null when the type
 *   names no known family (the Cockpit then uses its default).
 */
export function vesselEyeHeightM(type) {
  const family = normalizeVesselType(type).toUpperCase();
  if (family === 'OTHER' && !isAisOther(type)) return null;
  if (Object.hasOwn(EYE_HEIGHT_BY_FAMILY, family))
    return EYE_HEIGHT_BY_FAMILY[family];
  const matched = EYE_HEIGHT_PATTERNS.find((entry) =>
    entry.pattern.test(family),
  );
  return matched ? matched.heightM : null;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Normalize a selected vessel record into Cockpit subject info.
 *
 * `track` is where the camera looks and `motionCourse` is where the hull
 * moves: a ship faces its true heading while current and wind set it along
 * its course over ground. Either falls back to the other when one is missing.
 * @param {object|null} record Vessel record from the vessel layer.
 * @returns {object|null} Subject info, or null without a usable fix.
 */
export function vesselCockpitInfo(record) {
  if (!record?.id) return null;
  const latitude = Number(record.lat);
  const longitude = Number(record.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const heading = finiteOrNull(record.heading);
  const course = finiteOrNull(record.course);
  const speedKt = finiteOrNull(record.speed);
  const epochSec = finiteOrNull(record.lastPositionEpoch);
  const feedEpochSec = finiteOrNull(record.fixFeedEpoch);
  return {
    kind: 'vessel',
    layerId: VESSEL_COCKPIT_LAYER_ID,
    id: String(record.id),
    mmsi: String(record.mmsi || ''),
    name: String(record.name || record.mmsi || record.id),
    type: String(record.type || ''),
    typeLabel: displayVesselType(record.type),
    destination: String(record.destination || '').trim(),
    latitude,
    longitude,
    heading,
    course,
    speedKt,
    velocityMps: speedKt === null ? null : Math.max(0, speedKt) * KNOTS_TO_MPS,
    track: heading ?? course,
    // What `track` is: the true heading, or course over ground standing in
    // for a ship that reports none. The HUD says which.
    trackSource:
      heading !== null ? 'heading' : course !== null ? 'course' : null,
    motionCourse: course ?? heading,
    fixEpochMs: epochSec === null ? null : epochSec * 1000,
    // When this client first received the fix (its own clock) and the
    // newest fix in that refresh (the feed's clock): the fix's age without
    // clock skew, still ageing while the feed re-serves it.
    receivedAtMs: finiteOrNull(record.fixReceivedAtMs),
    feedEpochMs: feedEpochSec === null ? null : feedEpochSec * 1000,
    eyeHeightM: vesselEyeHeightM(record.type),
    stale: (record.missedRefreshes || 0) > 0,
    onGround: false,
  };
}
