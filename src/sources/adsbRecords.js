/**
 * Source-agnostic records for locally received ADS-B aircraft.
 *
 * Every local receiver path produces the same plain record, so the Local ADS-B
 * renderer does not care whether the frames were demodulated in this browser
 * from a WebUSB RTL-SDR or decoded by a dump1090/readsb process on the local
 * network:
 *
 * {
 *   icao: string,                 // lowercase 24-bit hex address
 *   callsign: string|null,
 *   lat: number|null,             // degrees, null until a position decodes
 *   lon: number|null,
 *   altitudeFt: number|null,      // barometric altitude
 *   groundSpeedKt: number|null,
 *   trackDeg: number|null,        // true track over ground, [0, 360)
 *   verticalRateFpm: number|null,
 *   lastPositionAt: number|null,  // epoch ms of the newest decoded position
 *   lastMessageAt: number,        // epoch ms of the newest CRC-valid message
 *   messageCount: number,
 *   rssiDbfs: number|null,
 *   source: 'rtl-sdr'|'dump1090',
 * }
 *
 * This module is portable: no Cesium, DOM, network or storage access.
 */

/** A marker is dropped once its newest position is this old. */
export const LOCAL_ADSB_POSITION_STALE_MS = 60_000;
/** An aircraft is forgotten once no message has arrived for this long. */
export const LOCAL_ADSB_MESSAGE_STALE_MS = 60_000;

const ICAO_PATTERN = /^[0-9a-f]{6}$/;

function finiteOrNull(value) {
  const number = typeof value === 'string' ? Number.NaN : Number(value);
  return value !== null && value !== undefined && Number.isFinite(number)
    ? number
    : null;
}

function normalizeIcao(value) {
  const icao = String(value ?? '')
    .trim()
    .toLowerCase();
  return ICAO_PATTERN.test(icao) ? icao : null;
}

function normalizeCallsign(value) {
  const callsign = String(value ?? '')
    .replace(/[^0-9A-Za-z]/g, ' ')
    .trim()
    .toUpperCase();
  return callsign || null;
}

function normalizeTrack(value) {
  const track = finiteOrNull(value);
  return track === null ? null : ((track % 360) + 360) % 360;
}

function normalizePosition(lat, lon) {
  const latitude = finiteOrNull(lat);
  const longitude = finiteOrNull(lon);
  if (
    latitude === null ||
    longitude === null ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  )
    return { lat: null, lon: null };
  return { lat: latitude, lon: longitude };
}

/**
 * Map one track from the browser Mode S decoder into a local ADS-B record.
 * @param {object} track Decoder track (icao, callsign, latitude, longitude,
 *   altitudeFt, speedKt, headingDeg, verticalRateFpm, messages, lastSeen,
 *   lastPositionAt).
 * @returns {object|null} Normalized record, or null without a valid address.
 */
export function recordFromDecoderTrack(track) {
  const icao = normalizeIcao(track?.icao);
  if (!icao) return null;
  const { lat, lon } = normalizePosition(track.latitude, track.longitude);
  return {
    icao,
    callsign: normalizeCallsign(track.callsign),
    lat,
    lon,
    altitudeFt: finiteOrNull(track.altitudeFt),
    groundSpeedKt: finiteOrNull(track.speedKt),
    trackDeg: normalizeTrack(track.headingDeg),
    verticalRateFpm: finiteOrNull(track.verticalRateFpm),
    lastPositionAt: lat === null ? null : finiteOrNull(track.lastPositionAt),
    lastMessageAt: finiteOrNull(track.lastSeen) ?? 0,
    messageCount: Math.max(0, Math.trunc(finiteOrNull(track.messages) ?? 0)),
    rssiDbfs: null,
    source: 'rtl-sdr',
  };
}

/**
 * Map a dump1090/readsb `aircraft.json` document into local ADS-B records.
 *
 * Ages (`seen`, `seen_pos`) are relative to the document's own `now`, so they
 * are anchored to the caller's receipt clock rather than trusting the
 * receiver host's wall clock. Entries without a valid 24-bit address (for
 * example non-ICAO TIS-B `~` addresses) are skipped.
 * @param {object} json Parsed aircraft.json document.
 * @param {number} nowMs Local epoch ms at which the document was received.
 * @returns {object[]} Normalized records.
 */
export function normalizeDump1090Aircraft(json, nowMs) {
  const receivedAt = finiteOrNull(nowMs);
  if (receivedAt === null || !Array.isArray(json?.aircraft)) return [];
  const records = [];
  for (const entry of json.aircraft) {
    const icao = normalizeIcao(entry?.hex);
    if (!icao) continue;
    const seenS = Math.max(0, finiteOrNull(entry.seen) ?? 0);
    const seenPosS = finiteOrNull(entry.seen_pos);
    const position = normalizePosition(entry.lat, entry.lon);
    const hasPosition = position.lat !== null && seenPosS !== null;
    const altitude =
      entry.alt_baro === 'ground' ? 0 : finiteOrNull(entry.alt_baro);
    records.push({
      icao,
      callsign: normalizeCallsign(entry.flight),
      lat: hasPosition ? position.lat : null,
      lon: hasPosition ? position.lon : null,
      altitudeFt: altitude,
      groundSpeedKt: finiteOrNull(entry.gs),
      trackDeg: normalizeTrack(entry.track),
      verticalRateFpm: finiteOrNull(entry.baro_rate),
      lastPositionAt: hasPosition
        ? receivedAt - Math.max(0, seenPosS) * 1000
        : null,
      lastMessageAt: receivedAt - seenS * 1000,
      messageCount: Math.max(0, Math.trunc(finiteOrNull(entry.messages) ?? 0)),
      rssiDbfs: finiteOrNull(entry.rssi),
      source: 'dump1090',
    });
  }
  return records;
}

/**
 * Whether a record has been heard recently enough to keep.
 * @param {object} record Local ADS-B record.
 * @param {number} nowMs Current epoch ms.
 * @returns {boolean}
 */
export function localAdsbRecordIsLive(record, nowMs) {
  return (
    Number.isFinite(record?.lastMessageAt) &&
    nowMs - record.lastMessageAt < LOCAL_ADSB_MESSAGE_STALE_MS
  );
}

/**
 * Whether a record carries a position fresh enough to draw a marker.
 * @param {object} record Local ADS-B record.
 * @param {number} nowMs Current epoch ms.
 * @returns {boolean}
 */
export function localAdsbPositionIsFresh(record, nowMs) {
  return (
    localAdsbRecordIsLive(record, nowMs) &&
    Number.isFinite(record.lat) &&
    Number.isFinite(record.lon) &&
    Number.isFinite(record.lastPositionAt) &&
    nowMs - record.lastPositionAt < LOCAL_ADSB_POSITION_STALE_MS
  );
}

/**
 * Receiver counts shown beside the gain control.
 * @param {object[]} records Local ADS-B records.
 * @param {number} nowMs Current epoch ms.
 * @returns {{heard:number, positioned:number}}
 */
export function summarizeLocalAdsb(records, nowMs) {
  let heard = 0;
  let positioned = 0;
  for (const record of Array.isArray(records) ? records : []) {
    if (!localAdsbRecordIsLive(record, nowMs)) continue;
    heard += 1;
    if (localAdsbPositionIsFresh(record, nowMs)) positioned += 1;
  }
  return { heard, positioned };
}
