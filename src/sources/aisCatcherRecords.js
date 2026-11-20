/**
 * Validate AIS-catcher's `ships.json` observations. The station block of the
 * document is never read. Field names and meanings follow AIS-catcher's public
 * JSON documentation: `last_signal` is the age in seconds of the newest
 * message, `validated` is 1 once a position passed the receiver's plausibility
 * check, 0 while it is still pending and -1 when it was rejected.
 */
const MMSI = /^[0-9]{9}$/;
const MAX_AGE_MS = 600_000;
const MAX_ROWS = 5000;
// Ship classes AIS-catcher reports for vessels. Above 8 are not vessels the
// layer draws: SAR aircraft (9, 10) and base stations and aids to navigation
// (11, 12) are left out. Class 13 is not a beacon test: AIS-catcher gives
// class 13 to every MMSI from 970000000 to 980000000, so most class-13 rows are
// not beacons. Only the MMSI blocks 970 (AIS-SART), 972 (man overboard) and 974
// (EPIRB-AIS) mark a beacon, which the layer draws apart from vessels. Every
// other class-13 row is filtered.
const MAX_VESSEL_CLASS = 8;
const BEACON_PREFIXES = Object.freeze({
  970: 'sart',
  972: 'mob',
  974: 'epirb',
});

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function text(value, maxLength = 80) {
  return typeof value === 'string'
    ? value
        .replace(/[\x00-\x1f\x7f]/g, ' ')
        .trim()
        .slice(0, maxLength)
    : '';
}
/**
 * What kind of distress or test beacon an observation is, or null for a
 * vessel: `sart`, `mob` or `epirb`, decided by the reserved MMSI block alone.
 * The receiver's ship class is never used, because it marks other MMSIs too.
 */
function beaconTypeOf(mmsi) {
  if (!MMSI.test(mmsi)) return null;
  return BEACON_PREFIXES[mmsi.slice(0, 3)] ?? null;
}
function optionalNumber(value, min, max) {
  const n = finite(value);
  return n !== null && n >= min && n <= max ? n : null;
}

/**
 * Normalise one AIS-catcher ship list. Nothing is invented: a measurement the
 * receiver did not give, or gave as a "not available" value, stays null, and a
 * position that has not been validated is flagged, not dropped.
 *
 * @param {object} payload AIS-catcher `/ships.json` response.
 * @param {number} receivedAt Epoch milliseconds at receipt.
 * @returns {{records: object[], dropped: number, rejected: number,
 *   filtered: number, newestSignalAt: number|null}}
 *   Fresh vessel and beacon positions; how many rows were left out in all (`dropped`,
 *   including old, duplicate and filtered rows); how many of those were
 *   invalid data (`rejected`, counted only while the row's `last_signal` is
 *   600 s or less or unknown, so an old refused row the receiver still lists
 *   is stale, not rejected data); how many were non-vessel classes dropped by
 *   design (`filtered`: SAR aircraft, base stations, aids to navigation and
 *   class-13 rows whose MMSI is not a beacon block);
 *   beacons are records of their own (`beaconType` set, never a vessel); and the receipt-relative time of the newest message
 *   among usable or filtered rows, however old. `newestSignalAt` dates the
 *   receiver's last activity even when no row is fresh, so a receiver that
 *   hears only filtered classes is alive, not silent.
 */
export function normalizeAisCatcherShips(payload, receivedAt = Date.now()) {
  const empty = {
    records: [],
    dropped: 0,
    rejected: 0,
    filtered: 0,
    newestSignalAt: null,
  };
  if (!Array.isArray(payload?.ships)) return empty;
  const rows = payload.ships.slice(0, MAX_ROWS);
  const records = new Map();
  let dropped = Math.max(0, payload.ships.length - rows.length);
  let rejected = 0;
  let filtered = 0;
  let newestSignalAt = null;
  const hearing = (ageSeconds) => {
    if (ageSeconds === null || ageSeconds < 0) return;
    const at = receivedAt - Math.round(ageSeconds * 1000);
    if (newestSignalAt === null || at > newestSignalAt) newestSignalAt = at;
  };
  for (const ship of rows) {
    if (!ship || typeof ship !== 'object' || Array.isArray(ship)) {
      dropped += 1;
      rejected += 1;
      continue;
    }
    const mmsi = String(ship.mmsi ?? '');
    const shipClass = finite(ship.shipclass);
    const lat = finite(ship.lat);
    const lon = finite(ship.lon);
    const ageSeconds = finite(ship.last_signal);
    const beaconType = beaconTypeOf(mmsi);
    // Base stations, aids to navigation and the like are not vessels: left out
    // by design, which is not the receiver sending bad data.
    if (
      !beaconType &&
      MMSI.test(mmsi) &&
      Number.isInteger(shipClass) &&
      shipClass > MAX_VESSEL_CLASS
    ) {
      dropped += 1;
      filtered += 1;
      // The receiver is alive: a filtered row dates its last activity.
      hearing(ageSeconds);
      continue;
    }
    if (
      !MMSI.test(mmsi) ||
      // A beacon may come without a class; a vessel may not.
      (shipClass === null ? !beaconType : !Number.isInteger(shipClass)) ||
      (shipClass !== null && shipClass < 0) ||
      // -1 is the receiver's own rejection of a position jump.
      Number(ship.validated) === -1 ||
      lat === null ||
      lon === null ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180 ||
      // A 0,0 fix is an unset position, not a place.
      (lat === 0 && lon === 0) ||
      ageSeconds === null ||
      ageSeconds < 0
    ) {
      dropped += 1;
      // The receiver is alive: a refused row dates its last activity, so a
      // receiver that sends only refused rows reads stale with an age, not
      // "never".
      hearing(ageSeconds);
      // A refused row counts as rejected data only while it is recent; an old
      // one that the receiver still lists is just stale.
      if (ageSeconds === null || ageSeconds * 1000 <= MAX_AGE_MS) rejected += 1;
      continue;
    }
    const lastSeenAt = receivedAt - Math.round(ageSeconds * 1000);
    hearing(ageSeconds);
    if (ageSeconds * 1000 > MAX_AGE_MS) {
      dropped += 1;
      continue;
    }
    const record = {
      id: `local-ais:${mmsi}`,
      mmsi,
      name: text(ship.shipname || ship.name),
      lat,
      lon,
      speed: optionalNumber(ship.speed, 0, 102.2),
      course: optionalNumber(ship.cog, 0, 359.9),
      heading: optionalNumber(ship.heading, 0, 359),
      // 0 is AIS "not available", not a ship type.
      shipType: optionalNumber(ship.shiptype, 1, 9999),
      shipClass,
      // null for a vessel; for a distress or test beacon, which kind.
      beaconType,
      destination: text(ship.destination, 120),
      approx: ship.approx === true || ship.approx === 1,
      // Only 1 means the receiver validated the position; 0 is pending and
      // anything else is unknown, which is not the same as validated.
      validated: Number(ship.validated) === 1,
      lastSeenAt,
      source: 'local-ais',
    };
    const previous = records.get(mmsi);
    if (previous) dropped += 1;
    if (!previous || record.lastSeenAt > previous.lastSeenAt)
      records.set(mmsi, record);
  }
  return {
    records: [...records.values()],
    dropped,
    rejected,
    filtered,
    newestSignalAt,
  };
}
