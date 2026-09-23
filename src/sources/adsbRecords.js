/**
 * Source-agnostic records for locally received ADS-B aircraft.
 *
 * Every local receiver path produces the same plain record, so the Local ADS-B
 * renderer does not care whether the frames were demodulated in this browser
 * from a WebUSB RTL-SDR or decoded by a dump1090/readsb/dump978 process whose
 * `aircraft.json` the server reads as a decoder feed:
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
 *   band: '1090'|'978',           // 1090 MHz Mode S/ES or 978 MHz UAT
 *   source: 'webusb'|'feed',      // browser SDR or decoder feed
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
    band: '1090',
    source: 'webusb',
  };
}

/**
 * Map a dump1090/readsb `aircraft.json` document into local ADS-B records.
 *
 * Ages (`seen`, `seen_pos`) are relative to the document's own `now`, so they
 * are anchored to the caller's receipt clock rather than trusting the
 * receiver host's wall clock. Entries without a valid 24-bit address (for
 * example non-ICAO TIS-B `~` addresses) are skipped.
 * skyaware978 writes the same document shape for 978 MHz UAT, so one adapter
 * serves both bands; the caller names the band.
 * @param {object} json Parsed aircraft.json document.
 * @param {number} nowMs Local epoch ms at which the document was received.
 * @param {object} [options]
 * @param {'1090'|'978'} [options.band='1090'] Band the feed decodes.
 * @returns {object[]} Normalized records.
 */
export function normalizeDump1090Aircraft(json, nowMs, { band = '1090' } = {}) {
  const recordBand = band === '978' ? '978' : '1090';
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
      band: recordBand,
      source: 'feed',
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

const BAND_ORDER = Object.freeze(['1090', '978']);
const SOURCE_ORDER = Object.freeze(['webusb', 'feed']);

function ordered(values, order) {
  return order.filter((value) => values.has(value));
}

function positionTime(record) {
  return Number.isFinite(record?.lastPositionAt)
    ? record.lastPositionAt
    : Number.NEGATIVE_INFINITY;
}

function messageTime(record) {
  return Number.isFinite(record?.lastMessageAt)
    ? record.lastMessageAt
    : Number.NEGATIVE_INFINITY;
}

/**
 * Whether `candidate` should replace `current` for the same ICAO: the most
 * recent position wins, and on a tie the most recent message.
 * @param {object} candidate
 * @param {object} current
 * @returns {boolean}
 */
export function localAdsbRecordIsNewer(candidate, current) {
  const byPosition = positionTime(candidate) - positionTime(current);
  if (byPosition !== 0 && !Number.isNaN(byPosition)) return byPosition > 0;
  return messageTime(candidate) > messageTime(current);
}

/**
 * Merge records from every local input (browser SDR, decoder feeds) into one
 * record per ICAO.
 *
 * Keeps the record with the most recent position (tie: most recent message)
 * and annotates it with every band and source that heard the aircraft within
 * the last 60 s. `memory` (a Map owned by the caller) carries those
 * receptions across calls, so an input that drops an aircraft does not erase
 * that it was heard there moments ago.
 * @param {object[][]} inputs Record lists; each record has `band`/`source`.
 * @param {number} nowMs Current epoch ms.
 * @param {Map<string, Map<string, number>>} [memory] Per-ICAO reception log
 *   keyed `band|source`, mutated in place and pruned to 60 s.
 * @returns {object[]} Merged records with `bands` and `sources` arrays.
 */
export function mergeLocalAdsbRecords(inputs, nowMs, memory = new Map()) {
  const best = new Map();
  for (const list of Array.isArray(inputs) ? inputs : []) {
    for (const record of Array.isArray(list) ? list : []) {
      if (!record?.icao || !localAdsbRecordIsLive(record, nowMs)) continue;
      const current = best.get(record.icao);
      if (!current || localAdsbRecordIsNewer(record, current))
        best.set(record.icao, record);
      let heard = memory.get(record.icao);
      if (!heard) {
        heard = new Map();
        memory.set(record.icao, heard);
      }
      const key = `${record.band || '1090'}|${record.source || 'webusb'}`;
      heard.set(key, Math.max(heard.get(key) ?? 0, record.lastMessageAt));
    }
  }
  for (const [icao, heard] of memory) {
    for (const [key, at] of heard)
      if (nowMs - at >= LOCAL_ADSB_MESSAGE_STALE_MS) heard.delete(key);
    if (!heard.size) memory.delete(icao);
  }
  const merged = [];
  for (const [icao, record] of best) {
    const bands = new Set();
    const sources = new Set();
    for (const key of memory.get(icao)?.keys() || []) {
      const [band, source] = key.split('|');
      bands.add(band);
      sources.add(source);
    }
    merged.push({
      ...record,
      bands: ordered(bands, BAND_ORDER),
      sources: ordered(sources, SOURCE_ORDER),
    });
  }
  return merged;
}
