import { isRecognizedAisEnvelope } from '../../../src/data/aisStreamAdapter.js';
import {
  aidToNavigationTypeName,
  isAidToNavigation,
} from '../../../src/data/vesselTypes.js';
export const AISSTREAM_CACHE_MAX = 50000;
export const AISSTREAM_STALE_MS = 30 * 60 * 1000;
// Per-MMSI recent-path ring buffers (PRD WS-F F3). Float32 lat/lon (~1m
// precision, fine for 25m thinning) + Uint32 epoch seconds ≈ 12B/sample;
// 64 samples × 50k MMSIs worst case ≈ 38MB. Tracks exist only while the dev
// server runs — this is "recent path", not voyage history.
const AIS_TRACK_SAMPLES = 64;
const AIS_TRACK_MIN_GAP_SEC = 30;
const AIS_TRACK_MIN_MOVE_M = 25;
/** @type {Map<string,object>} */
const _aisStreamVessels = new Map();
/** @type {Map<string,object>} */
const _aisStreamStatic = new Map();
/** @type {Map<string,{lats:Float32Array,lons:Float32Array,times:Uint32Array,head:number,len:number}>} mmsi -> track ring buffer */
const _aisStreamTracks = new Map();
/** @type {Map<string,{lat:number,lon:number,epochSec:number}>} mmsi -> first fix awaiting second (lazy buffer allocation) */
const _aisStreamTrackPending = new Map();
/** Full prune walks so far; diagnostics only (see aisStreamCacheStats). */
let _aisStreamPruneWalks = 0;

/**
 * Store one parsed AIS envelope.
 *
 * The return value is the feed's ONLY liveness proof, so it is true strictly
 * when the envelope carried a real AIS record. Malformed frames and error
 * envelopes never reach here — the adapter classifies those — and a JSON
 * object without an MMSI proves nothing about the feed.
 *
 * @param {Object} envelope Parsed, non-error AIS envelope.
 * @returns {boolean} True when an AIS record was recognised.
 */
export function ingestAisStreamEnvelope(envelope) {
  // Single shared recognition rule (also used by the adapter's tests), so the
  // liveness predicate that ships is the one under test. An envelope carrying
  // only an MMSI is not proof the feed works.
  if (!isRecognizedAisEnvelope(envelope)) return false;

  const messageType = envelope?.MessageType;
  const message = envelope?.Message?.[messageType] || {};
  const metadata = envelope?.MetaData || envelope?.Metadata || {};
  const mmsi = stringValue(
    metadata.MMSI ?? message.UserID ?? message.UserId ?? message.Mmsi,
  );
  if (!mmsi) return false;

  if (messageType === 'ShipStaticData' || messageType === 'StaticDataReport') {
    const previous = _aisStreamStatic.get(mmsi) || {};
    const live = _aisStreamVessels.get(mmsi);
    const liveName = live?.name === `MMSI ${mmsi}` ? '' : live?.name;
    const fields =
      messageType === 'StaticDataReport'
        ? {
            Name:
              message.ReportA?.Valid === false
                ? undefined
                : message.ReportA?.Name,
            Type:
              message.ReportB?.Valid === false
                ? undefined
                : message.ReportB?.ShipType,
            Dimension:
              message.ReportB?.Valid === false
                ? undefined
                : message.ReportB?.Dimension,
          }
        : message;
    const dimensions = aisDimensions(fields.Dimension);
    // Static reports may be partial (including Class B's separate A/B parts).
    // Keep known values in the cache as well as in the current live row.
    const staticData = {
      // The envelope repeats a cached name even on Class B's type-only part.
      // Only an actual static name report replaces a known live name.
      name:
        stringValue(fields.Name ?? fields.ShipName) ||
        liveName ||
        previous.name ||
        stringValue(metadata.ShipName),
      type:
        staticCode(fields.Type ?? fields.ShipType) ||
        staticCode(live?.type) ||
        staticCode(previous.type) ||
        '',
      destination:
        stringValue(fields.Destination) ||
        live?.destination ||
        previous.destination ||
        '',
      imo:
        staticCode(fields.ImoNumber ?? fields.IMO) ||
        staticCode(live?.imo) ||
        staticCode(previous.imo) ||
        '',
      length: dimensions.length ?? live?.length ?? previous.length ?? null,
      beam: dimensions.beam ?? live?.beam ?? previous.beam ?? null,
    };
    _aisStreamStatic.set(mmsi, staticData);
    mergeAisStaticIntoLiveVessel(mmsi, staticData);
    // AISStream repeats the last known position in a static message's
    // MetaData, but the message has no speed, course or heading and is not a
    // new fix. Rebuilding a tracked vessel from it would blank its motion and
    // restamp its position time, so only merge the static fields.
    if (_aisStreamVessels.has(mmsi)) return true;
  }

  const lat = numberValue(
    metadata.latitude ?? metadata.Latitude ?? message.Latitude,
  );
  const lon = numberValue(
    metadata.longitude ?? metadata.Longitude ?? message.Longitude,
  );
  // A positionless but well-formed record (static data) is still the feed
  // delivering AIS traffic, so it counts as liveness.
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return true;

  const staticData = _aisStreamStatic.get(mmsi) || {};
  const aidReport = messageType === 'AidsToNavigationReport';
  // Re-insert rather than overwrite: a Map iterates in insertion order, so
  // this keeps the least recently updated vessel first and the cap can evict
  // from the front instead of sorting every row.
  _aisStreamVessels.delete(mmsi);
  _aisStreamVessels.set(mmsi, {
    lat,
    lon,
    name:
      (aidReport && aidNameFromAis(message)) ||
      vesselNameFromAis(metadata, message, staticData) ||
      `MMSI ${mmsi}`,
    mmsi,
    imo: stringValue(message.ImoNumber ?? message.IMO ?? staticData.imo),
    // An aid-to-navigation report's type is the kind of aid (0 to 31), not
    // a ship type: it is carried as the aid's name ("Cardinal Mark N").
    type: aidReport
      ? aidToNavigationTypeName(message.Type)
      : vesselTypeFromAis(message, staticData),
    destination: stringValue(message.Destination ?? staticData.destination),
    length: staticData.length ?? null,
    beam: staticData.beam ?? null,
    speed: normalizedSpeedOverGround(message.Sog ?? message.SOG),
    course: normalizedCourseOverGround(message.Cog ?? message.COG),
    heading: normalizedHeading(message.TrueHeading ?? message.Heading),
    last_position_UTC: normalizeAisTimestamp(
      metadata.time_utc ?? metadata.TimeUtc,
    ),
    // Use the AIS message's own report time, not server ingest wall-clock —
    // trail spacing and dead reckoning depend on true fix epochs.
    last_position_epoch: aisEpochSeconds(metadata.time_utc ?? metadata.TimeUtc),
    // A virtual aid is broadcast where nothing physical stands. Only such a
    // row carries the field, so ship rows stay their size.
    ...(aidReport && message.VirtualAtoN === true && { virtual: true }),
    _updatedAt: Date.now(),
  });

  appendAisTrackSample(
    mmsi,
    lat,
    lon,
    aisEpochSeconds(metadata.time_utc ?? metadata.TimeUtc),
  );

  // Only the cap is enforced per message, and that is O(1). Expiry needs a
  // walk of every row, so it runs on the caller's timer (pruneAisStreamCache);
  // readers check age themselves in between.
  while (_aisStreamVessels.size > AISSTREAM_CACHE_MAX)
    dropAisVessel(_aisStreamVessels.keys().next().value);
  return true;
}

/** Forget one vessel entirely, so no side map can outgrow the vessel map. */
function dropAisVessel(mmsi) {
  _aisStreamVessels.delete(mmsi);
  _aisStreamStatic.delete(mmsi);
  _aisStreamTracks.delete(mmsi);
  _aisStreamTrackPending.delete(mmsi);
}

/**
 * Parses an AISStream UTC timestamp into epoch seconds (fallback: now).
 */
function aisEpochSeconds(value) {
  const ms = Date.parse(normalizeAisTimestamp(value));
  return Number.isFinite(ms)
    ? Math.floor(ms / 1000)
    : Math.floor(Date.now() / 1000);
}

/**
 * Appends a thinned position sample to a vessel's track ring buffer.
 * Buffers allocate lazily on the second fix (most MMSIs are seen once);
 * samples are kept only when >=AIS_TRACK_MIN_GAP_SEC and
 * >=AIS_TRACK_MIN_MOVE_M from the previous stored sample, so anchored
 * vessels collapse to a single point.
 */
function appendAisTrackSample(mmsi, lat, lon, epochSec) {
  let track = _aisStreamTracks.get(mmsi);
  if (!track) {
    const pending = _aisStreamTrackPending.get(mmsi);
    // A first fix older than the retention window is treated as absent: the
    // timed prune may not have removed it yet, and it must not seed a track.
    const pendingCutoffSec = Math.floor(
      (Date.now() - AISSTREAM_STALE_MS) / 1000,
    );
    if (!pending || pending.epochSec < pendingCutoffSec) {
      _aisStreamTrackPending.set(mmsi, { lat, lon, epochSec });
      return;
    }
    if (epochSec - pending.epochSec < AIS_TRACK_MIN_GAP_SEC) return;
    if (
      approxMetersBetween(pending.lat, pending.lon, lat, lon) <
      AIS_TRACK_MIN_MOVE_M
    )
      return;
    track = {
      lats: new Float32Array(AIS_TRACK_SAMPLES),
      lons: new Float32Array(AIS_TRACK_SAMPLES),
      times: new Uint32Array(AIS_TRACK_SAMPLES),
      head: 0,
      len: 0,
    };
    _aisStreamTracks.set(mmsi, track);
    _aisStreamTrackPending.delete(mmsi);
    writeAisTrackSample(track, pending.lat, pending.lon, pending.epochSec);
    writeAisTrackSample(track, lat, lon, epochSec);
    return;
  }

  const lastIdx = (track.head - 1 + AIS_TRACK_SAMPLES) % AIS_TRACK_SAMPLES;
  const lastEpoch = track.times[lastIdx];
  if (epochSec - lastEpoch < AIS_TRACK_MIN_GAP_SEC) return;
  if (
    approxMetersBetween(track.lats[lastIdx], track.lons[lastIdx], lat, lon) <
    AIS_TRACK_MIN_MOVE_M
  )
    return;
  writeAisTrackSample(track, lat, lon, epochSec);
}

function writeAisTrackSample(track, lat, lon, epochSec) {
  track.lats[track.head] = lat;
  track.lons[track.head] = lon;
  track.times[track.head] = epochSec;
  track.head = (track.head + 1) % AIS_TRACK_SAMPLES;
  track.len = Math.min(track.len + 1, AIS_TRACK_SAMPLES);
}

/**
 * Reads a vessel's accumulated track in chronological order.
 * @returns {Array<{lat:number,lon:number,t:number}>}
 */
export function readAisTrack(mmsi) {
  const track = _aisStreamTracks.get(mmsi);
  if (!track || !track.len) return [];
  // An expired vessel stays in the maps until the next timed prune; its track
  // must read as gone straight away, as its row does in aisStreamRows.
  const row = _aisStreamVessels.get(mmsi);
  if (!row || row._updatedAt < Date.now() - AISSTREAM_STALE_MS) return [];
  const samples = [];
  const start =
    (track.head - track.len + AIS_TRACK_SAMPLES) % AIS_TRACK_SAMPLES;
  for (let i = 0; i < track.len; i++) {
    const idx = (start + i) % AIS_TRACK_SAMPLES;
    samples.push({
      lat: track.lats[idx],
      lon: track.lons[idx],
      t: track.times[idx],
    });
  }
  return samples;
}

/** Equirectangular distance approximation — plenty for 25m thinning. */
function approxMetersBetween(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * 111320;
  const dLon =
    (lon2 - lon1) * 111320 * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  return Math.hypot(dLat, dLon);
}

function mergeAisStaticIntoLiveVessel(mmsi, staticData) {
  const existing = _aisStreamVessels.get(mmsi);
  if (!existing) return;
  if (staticData.name) existing.name = staticData.name;
  if (staticData.type) existing.type = staticData.type;
  if (staticData.destination) existing.destination = staticData.destination;
  if (staticData.imo) existing.imo = staticData.imo;
  if (staticData.length) existing.length = staticData.length;
  if (staticData.beam) existing.beam = staticData.beam;
}

/**
 * A static report's hull size from its AIS dimensions: the antenna's
 * distances to bow (A), stern (B), port (C) and starboard (D), in metres.
 * Zero is AIS's "not available", so a side missing its two parts has none.
 * @param {{A?: number, B?: number, C?: number, D?: number}|undefined} dimension
 * @returns {{length: number|null, beam: number|null}}
 */
function aisDimensions(dimension) {
  const part = (value) => {
    const number = numberValue(value);
    return number !== null && number > 0 ? number : 0;
  };
  const length = part(dimension?.A) + part(dimension?.B);
  const beam = part(dimension?.C) + part(dimension?.D);
  return { length: length > 0 ? length : null, beam: beam > 0 ? beam : null };
}

function vesselNameFromAis(metadata, message, staticData = {}) {
  return stringValue(
    metadata.ShipName ??
      message.Name ??
      message.ShipName ??
      message.ReportA?.Name ??
      staticData.name,
  );
}

/**
 * An aid's whole name: an aid-to-navigation report carries the first 20
 * characters in `Name` and the rest, up to 14 more, in `NameExtension`.
 */
function aidNameFromAis(message) {
  const name = stringValue(message.Name);
  return name ? stringValue(name + stringValue(message.NameExtension)) : '';
}

function vesselTypeFromAis(message, staticData = {}) {
  return stringValue(
    message.Type ??
      message.ShipType ??
      message.ReportB?.ShipType ??
      staticData.type,
  );
}

/**
 * The current rows, newest first, with every vessel ahead of every aid to
 * navigation: a capped request never gives up a ship for a buoy.
 */
export function aisStreamRows(maxRows) {
  const cutoff = Date.now() - AISSTREAM_STALE_MS;
  const vessels = [];
  const aids = [];
  for (const row of _aisStreamVessels.values()) {
    if (row._updatedAt >= cutoff)
      (isAidToNavigation(row) ? aids : vessels).push(row);
  }
  const newestFirst = (a, b) => b._updatedAt - a._updatedAt;
  vessels.sort(newestFirst);
  if (vessels.length < maxRows) aids.sort(newestFirst);
  return vessels
    .concat(aids)
    .slice(0, maxRows)
    .map(({ _updatedAt, ...row }) => row);
}

/**
 * Drop expired vessels and everything kept for them.
 *
 * This walks every row, so it runs on a timer (the AIS watchdog tick in
 * ais-live.js) and not per message. Nothing depends on it for correctness:
 * readers filter by age and ingest enforces the cap. It only frees memory.
 */
export function pruneAisStreamCache() {
  _aisStreamPruneWalks++;
  const cutoff = Date.now() - AISSTREAM_STALE_MS;
  for (const [mmsi, row] of _aisStreamVessels) {
    if (row._updatedAt < cutoff) dropAisVessel(mmsi);
  }
  // Pending single-fix entries for vessels never seen again must not leak
  const pendingCutoffSec = Math.floor(cutoff / 1000);
  for (const [mmsi, pending] of _aisStreamTrackPending) {
    if (pending.epochSec < pendingCutoffSec)
      _aisStreamTrackPending.delete(mmsi);
  }
  // Static data that arrived without a position has no vessel row to be
  // dropped with. It is kept for the position that may follow, but only up to
  // the vessel cap, oldest first, so the static map is bounded too.
  for (const mmsi of _aisStreamStatic.keys()) {
    if (_aisStreamStatic.size <= AISSTREAM_CACHE_MAX) break;
    if (!_aisStreamVessels.has(mmsi)) _aisStreamStatic.delete(mmsi);
  }
}

/** Map sizes and the number of prune walks, for tests and diagnostics. */
export function aisStreamCacheStats() {
  return {
    vessels: _aisStreamVessels.size,
    statics: _aisStreamStatic.size,
    tracks: _aisStreamTracks.size,
    pendingTracks: _aisStreamTrackPending.size,
    pruneWalks: _aisStreamPruneWalks,
  };
}

export function newestAisPositionAt(rows) {
  return rows[0]?.last_position_UTC || null;
}

function stringValue(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

// AIS uses zero for unavailable ship type and IMO, not as a replacement value.
function staticCode(value) {
  const number = numberValue(value);
  return Number.isInteger(number) && number > 0 ? String(number) : '';
}

function numberValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizedHeading(value) {
  const heading = numberValue(value);
  return heading !== null && heading >= 0 && heading <= 360 ? heading : null;
}

/**
 * Speed over ground in knots, or null when the report carries AIS's "not
 * available" code. ITU-R M.1371 encodes SOG in 0.1-knot units where 1022 means
 * "102.2 knots or higher" and 1023 means unavailable, so 102.3 is a sentinel
 * and not a reading. It is finite, so every consumer would otherwise treat it
 * as a genuine speed.
 */
function normalizedSpeedOverGround(value) {
  const speed = numberValue(value);
  return speed !== null && speed >= 0 && speed < 102.3 ? speed : null;
}

/**
 * Course over ground in degrees, or null when the report carries AIS's "not
 * available" code (3600 in 0.1-degree units, i.e. 360). Valid courses stop at
 * 359.9; heading keeps its own separate sentinel of 511.
 */
function normalizedCourseOverGround(value) {
  const course = numberValue(value);
  return course !== null && course >= 0 && course < 360 ? course : null;
}

function normalizeAisTimestamp(value) {
  const text = stringValue(value);
  if (!text) return new Date().toISOString();
  const normalized = text.replace(' +0000 UTC', 'Z').replace(' UTC', 'Z');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString();
}
