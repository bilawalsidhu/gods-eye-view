import { isRecognizedAisEnvelope } from '../../../src/data/aisStreamAdapter.js';
import { aisHistoryEnabled, openAisHistory } from './ais-history.js';
import { flagFromMmsi, isValidImo } from './ais-identity.js';
import { createSanctionsScreening } from './ais-sanctions.js';
import {
  buildCoverageCells,
  classifyGap,
  reckonVessel,
  reckoningEnabled,
  reckoningMaxHours,
} from './ais-reckoning.js';
export const AISSTREAM_CACHE_MAX = 50000;
export const AISSTREAM_STALE_MS = 30 * 60 * 1000;

/**
 * Coverage budget. Both are read per call rather than frozen at import so a
 * restart picks up a changed .env, matching how the rest of this provider
 * re-derives its configuration.
 *
 * Raising them holds more of the world at once — the feed delivers roughly
 * 1,800 distinct vessels a minute, so the cache fills for about half an hour
 * before the retention window balances the inflow. The cost is memory (~500
 * bytes per vessel row, plus its track buffer) and, above the client's own
 * render cap, nothing visible on screen.
 */
export function aisCacheMax() {
  const parsed = Number.parseInt(
    String(process.env.AISSTREAM_CACHE_MAX ?? '').trim(),
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : AISSTREAM_CACHE_MAX;
}

export function aisStaleMs() {
  const parsed = Number.parseInt(
    String(process.env.AISSTREAM_RETENTION_MIN ?? '').trim(),
    10,
  );
  return Number.isFinite(parsed) && parsed > 0
    ? parsed * 60 * 1000
    : AISSTREAM_STALE_MS;
}
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
/** @type {Map<string,{min:number,max:number}>} mmsi -> draught range seen this run (seeded from history when present) */
const _aisDraughtRange = new Map();
/** MMSIs already looked up in history, so a cold hull costs one read, not one per fix. */
const _aisHydrated = new Set();
/** @type {Object|null} Durable history sink, or null when GEV_AIS_HISTORY is unset. */
let _aisHistory = null;
/** @type {Object|null} Lazily created sanctions screening service. */
let _aisSanctions = null;

/** Screening service, created on first use so imports stay side-effect free. */
export function aisSanctions() {
  if (!_aisSanctions) _aisSanctions = createSanctionsScreening();
  return _aisSanctions;
}

/** Test seam: swaps the screening service. */
export function setAisSanctionsForTesting(service) {
  _aisSanctions = service;
}

/**
 * Lazily opens the durable history sink. Kept out of module scope so that
 * importing this file never touches the filesystem — the provider contract
 * says acquisition starts on first use, not at import.
 * @returns {Object|null}
 */
export function aisHistory() {
  if (_aisHistory !== null) return _aisHistory.disabled ? null : _aisHistory;
  if (!aisHistoryEnabled()) {
    _aisHistory = { disabled: true };
    return null;
  }
  _aisHistory = openAisHistory();
  return _aisHistory.disabled ? null : _aisHistory;
}

/** Releases the history sink (server close / tests). */
export function closeAisHistory() {
  if (_aisHistory && !_aisHistory.disabled) _aisHistory.close();
  _aisHistory = null;
}

/** Test seam: forces a specific sink (or null to disable). */
export function setAisHistoryForTesting(handle) {
  _aisHistory = handle || { disabled: true };
}

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
    const previous = _aisStreamStatic.get(mmsi);
    const hull = hullDimensions(message);
    const staticData = {
      name: vesselNameFromAis(metadata, message, previous),
      type: vesselTypeFromAis(message, previous),
      destination: stringValue(message.Destination),
      imo: stringValue(message.ImoNumber ?? message.IMO),
      callSign:
        stringValue(message.CallSign ?? message.Callsign) ||
        previous?.callSign ||
        '',
      draught: draughtFromAis(message) ?? previous?.draught ?? null,
      eta: etaFromAis(message) || previous?.eta || '',
      length: hull.length ?? previous?.length ?? null,
      beam: hull.beam ?? previous?.beam ?? null,
    };
    _aisStreamStatic.set(mmsi, staticData);
    observeDraught(mmsi, staticData.draught);
    mergeAisStaticIntoLiveVessel(mmsi, staticData);
    aisHistory()?.queueIdentity(mmsi, staticData);
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

  const staticData = hydratedStatic(mmsi);
  const draught = draughtFromAis(message) ?? staticData.draught ?? null;
  observeDraught(mmsi, draught);
  const navStatus = navigationStatusFromAis(message);
  const hull = hullDimensions(message);
  const name =
    vesselNameFromAis(metadata, message, staticData) || `MMSI ${mmsi}`;
  const imo = stringValue(message.ImoNumber ?? message.IMO ?? staticData.imo);
  const callSign = stringValue(
    message.CallSign ?? message.Callsign ?? staticData.callSign,
  );
  _aisStreamVessels.set(mmsi, {
    lat,
    lon,
    name,
    mmsi,
    imo,
    type: vesselTypeFromAis(message, staticData),
    destination: stringValue(message.Destination ?? staticData.destination),
    speed: numberValue(message.Sog ?? message.SOG),
    course: numberValue(message.Cog ?? message.COG),
    heading: normalizedHeading(message.TrueHeading ?? message.Heading),
    call_sign: stringValue(
      message.CallSign ?? message.Callsign ?? staticData.callSign,
    ),
    draught,
    load_state: loadStateFor(mmsi, draught),
    eta: etaFromAis(message) || staticData.eta || '',
    length: hull.length ?? staticData.length ?? null,
    beam: hull.beam ?? staticData.beam ?? null,
    nav_status: navStatus,
    nav_status_text: navigationStatusText(navStatus),
    ...identityFields(mmsi, imo, name, callSign),
    last_position_UTC: normalizeAisTimestamp(
      metadata.time_utc ?? metadata.TimeUtc,
    ),
    // Use the AIS message's own report time, not server ingest wall-clock —
    // trail spacing and dead reckoning depend on true fix epochs.
    last_position_epoch: aisEpochSeconds(metadata.time_utc ?? metadata.TimeUtc),
    _updatedAt: Date.now(),
  });

  const epochSec = aisEpochSeconds(metadata.time_utc ?? metadata.TimeUtc);
  appendAisTrackSample(mmsi, lat, lon, epochSec);

  const history = aisHistory();
  if (history) {
    history.queuePosition(
      mmsi,
      lat,
      lon,
      epochSec,
      numberValue(message.Sog ?? message.SOG),
      numberValue(message.Cog ?? message.COG),
    );
    history.queueVoyage(
      mmsi,
      {
        destination: stringValue(message.Destination ?? staticData.destination),
        eta: etaFromAis(message) || staticData.eta || '',
        draught,
        navStatus,
      },
      epochSec,
    );
  }

  pruneAisStreamCache();
  return true;
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
    if (!pending) {
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
  if (staticData.name && (!existing.name || existing.name === `MMSI ${mmsi}`))
    existing.name = staticData.name;
  if (staticData.type && !existing.type) existing.type = staticData.type;
  if (staticData.destination && !existing.destination)
    existing.destination = staticData.destination;
  if (staticData.imo && !existing.imo) existing.imo = staticData.imo;
  if (staticData.callSign && !existing.call_sign)
    existing.call_sign = staticData.callSign;
  if (staticData.eta && !existing.eta) existing.eta = staticData.eta;
  if (staticData.length && !existing.length)
    existing.length = staticData.length;
  if (staticData.beam && !existing.beam) existing.beam = staticData.beam;
  if (staticData.draught !== null && staticData.draught !== undefined) {
    if (existing.draught === null || existing.draught === undefined)
      existing.draught = staticData.draught;
    existing.load_state = loadStateFor(mmsi, existing.draught);
  }
}

/**
 * AIS navigational status codes (ITU-R M.1371 message 1/2/3, field 2).
 * Index is the wire value; 15 and the reserved slots stay undefined on screen.
 */
const NAV_STATUS_TEXT = Object.freeze([
  'UNDER WAY (ENGINE)',
  'AT ANCHOR',
  'NOT UNDER COMMAND',
  'RESTRICTED MANOEUVRABILITY',
  'CONSTRAINED BY DRAUGHT',
  'MOORED',
  'AGROUND',
  'FISHING',
  'UNDER WAY (SAILING)',
  '',
  '',
  'TOWING ASTERN',
  'PUSHING AHEAD',
  '',
  'AIS-SART / MOB / EPIRB',
  '',
]);

/** Minimum spread (metres) before a hull's draught range can classify load. */
const DRAUGHT_RANGE_MIN_M = 0.5;

/** Reported static draught in metres, or null when the field is absent/zero. */
function draughtFromAis(message) {
  const value = numberValue(
    message.MaximumStaticDraught ??
      message.MaxStaticDraught ??
      message.Draught ??
      message.Draft,
  );
  // 0 is AIS for "not available", not a hull floating on the surface.
  return value !== null && value > 0 && value < 30 ? value : null;
}

/** Navigational status code (0-15), or null when absent. */
function navigationStatusFromAis(message) {
  const value = numberValue(
    message.NavigationalStatus ?? message.NavigationStatus ?? message.Status,
  );
  if (value === null) return null;
  const code = Math.trunc(value);
  return code >= 0 && code <= 15 ? code : null;
}

/** Human-readable navigational status, or '' for undefined/reserved codes. */
function navigationStatusText(code) {
  if (code === null || code === undefined) return '';
  return NAV_STATUS_TEXT[code] || '';
}

/**
 * Overall length and beam from the AIS antenna-offset quartet: A/B are the
 * distances fore and aft of the antenna, C/D port and starboard.
 * @returns {{length:number|null, beam:number|null}}
 */
function hullDimensions(message) {
  const dimension =
    message.Dimension || message.Dimensions || message.ReportB?.Dimension;
  if (!dimension) return { length: null, beam: null };
  const a = numberValue(dimension.A);
  const b = numberValue(dimension.B);
  const c = numberValue(dimension.C);
  const d = numberValue(dimension.D);
  const length = a !== null && b !== null ? a + b : null;
  const beam = c !== null && d !== null ? c + d : null;
  return {
    length: length !== null && length > 0 ? length : null,
    beam: beam !== null && beam > 0 ? beam : null,
  };
}

/**
 * AIS ETA as "MM-DD HH:MM" UTC. The wire format carries no year, and a zeroed
 * month or day is the standard "not available" encoding.
 */
function etaFromAis(message) {
  const eta = message.Eta || message.ETA || message.EtaUtc;
  if (!eta || typeof eta !== 'object') return '';
  const month = numberValue(eta.Month);
  const day = numberValue(eta.Day);
  const hour = numberValue(eta.Hour);
  const minute = numberValue(eta.Minute);
  if (!month || !day || month > 12 || day > 31) return '';
  if (hour === null || minute === null || hour > 23 || minute > 59) return '';
  return `${pad2(month)}-${pad2(day)} ${pad2(hour)}:${pad2(minute)}`;
}

function pad2(value) {
  return String(Math.trunc(value)).padStart(2, '0');
}

/**
 * Widens the draught range observed for a vessel, seeding from durable history
 * on first sight so a long-running database keeps its reference range across
 * restarts.
 */
function observeDraught(mmsi, draught) {
  if (draught === null || draught === undefined) return;
  let range = _aisDraughtRange.get(mmsi);
  if (!range) {
    const seeded = aisHistory()?.draughtExtremes(mmsi);
    range = seeded
      ? { min: seeded.min, max: seeded.max }
      : { min: draught, max: draught };
    _aisDraughtRange.set(mmsi, range);
  }
  if (draught < range.min) range.min = draught;
  if (draught > range.max) range.max = draught;
}

/**
 * Infers whether a hull is loaded from how deep it sits relative to its own
 * observed extremes.
 *
 * AIS never carries cargo. Draught is the only loading signal on the wire, and
 * it only means something once the SAME vessel has been seen both deep and
 * shallow — so this stays UNKNOWN until the observed range is wide enough to
 * separate the two. A vessel seen once is always UNKNOWN, by design.
 *
 * @returns {'LADEN'|'BALLAST'|'PART LADEN'|'UNKNOWN'}
 */
function loadStateFor(mmsi, draught) {
  if (draught === null || draught === undefined) return 'UNKNOWN';
  const range = _aisDraughtRange.get(mmsi);
  if (!range) return 'UNKNOWN';
  const spread = range.max - range.min;
  if (spread < DRAUGHT_RANGE_MIN_M) return 'UNKNOWN';
  const ratio = (draught - range.min) / spread;
  if (ratio >= 0.75) return 'LADEN';
  if (ratio <= 0.25) return 'BALLAST';
  return 'PART LADEN';
}

/**
 * Flag, IMO validity and sanctions status for one contact.
 *
 * Flag and IMO validity are derived offline, so every contact carries them.
 * Screening is an index lookup keyed primarily on IMO; the confidence field
 * reports which identifier matched, because a name-only hit against a reused
 * ship name is not the same claim as an IMO hit.
 */
function identityFields(mmsi, imo, name, callSign) {
  const flag = flagFromMmsi(mmsi);
  const fields = {
    flag: flag?.name || '',
    flag_code: flag?.code || '',
    mmsi_kind: flag?.kind || '',
    imo_valid: imo ? isValidImo(imo) : null,
    sanctioned: false,
    sanction_confidence: '',
    sanction_programs: '',
  };
  let screening;
  try {
    screening = aisSanctions().screen({ imo, name, callSign });
  } catch {
    // Screening must never break ingest; an unavailable list means no verdict.
    return fields;
  }
  // A shared ship name is not a verdict: it is recorded so the dossier route
  // can show it, but it never marks the contact sanctioned.
  if (screening.possibleNameMatch) {
    fields.sanction_confidence = 'NAME';
    return fields;
  }
  if (!screening.listed) return fields;
  fields.sanctioned = true;
  fields.sanction_confidence = screening.confidence;
  fields.sanction_programs = [
    ...new Set(screening.matches.map((entry) => entry.program).filter(Boolean)),
  ]
    .join(', ')
    .slice(0, 120);
  return fields;
}

/** Draught range observed for a vessel (testing/diagnostics). */
export function draughtRangeFor(mmsi) {
  const range = _aisDraughtRange.get(mmsi);
  return range ? { ...range } : null;
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

function vesselTypeFromAis(message, staticData = {}) {
  return stringValue(
    message.Type ??
      message.ShipType ??
      message.ReportB?.ShipType ??
      staticData.type,
  );
}

/**
 * Ingests already-normalized positions from a partner feed (BarentsWatch and
 * anything added later).
 *
 * Partner rows join the same cache as AISStream, so they inherit history,
 * sanctions screening and dead reckoning without a parallel pipeline. A
 * partner never overwrites a fresher AIS fix — the newest observation wins
 * regardless of who supplied it.
 *
 * @param {Array<Object>} rows Normalized rows: mmsi, lat, lon, and optionally
 *   name/speed/course/heading/nav_status/last_position_UTC.
 * @param {string} source Label recorded on the row.
 * @returns {number} Rows accepted.
 */
export function ingestPartnerRows(rows, source = 'partner') {
  if (!Array.isArray(rows)) return 0;
  let accepted = 0;
  for (const row of rows) {
    const mmsi = stringValue(row?.mmsi);
    const lat = numberValue(row?.lat);
    const lon = numberValue(row?.lon);
    if (!mmsi || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const epochSec = row?.last_position_UTC
      ? aisEpochSeconds(row.last_position_UTC)
      : Math.floor(Date.now() / 1000);
    const existing = _aisStreamVessels.get(mmsi);
    // Never let a partner poll rewind a vessel to an older position.
    if (existing && Number(existing.last_position_epoch) > epochSec) continue;

    const staticData = _aisStreamStatic.get(mmsi) || {};
    const name = stringValue(row?.name) || staticData.name || `MMSI ${mmsi}`;
    const imo = stringValue(staticData.imo);
    const callSign = stringValue(staticData.callSign);
    const navStatus = numberValue(row?.nav_status);

    _aisStreamVessels.set(mmsi, {
      lat,
      lon,
      name,
      mmsi,
      imo,
      type: stringValue(staticData.type),
      destination: stringValue(staticData.destination),
      speed: numberValue(row?.speed),
      course: numberValue(row?.course),
      heading: normalizedHeading(row?.heading),
      call_sign: callSign,
      draught: staticData.draught ?? null,
      load_state: loadStateFor(mmsi, staticData.draught ?? null),
      eta: stringValue(staticData.eta),
      length: staticData.length ?? null,
      beam: staticData.beam ?? null,
      nav_status: navStatus,
      nav_status_text: navigationStatusText(navStatus),
      ...identityFields(mmsi, imo, name, callSign),
      source,
      last_position_UTC: normalizeAisTimestamp(row?.last_position_UTC),
      last_position_epoch: epochSec,
      _updatedAt: Date.now(),
    });

    appendAisTrackSample(mmsi, lat, lon, epochSec);
    aisHistory()?.queuePosition(
      mmsi,
      lat,
      lon,
      epochSec,
      numberValue(row?.speed),
      numberValue(row?.course),
    );
    accepted += 1;
  }
  if (accepted) pruneAisStreamCache();
  return accepted;
}

/**
 * Searches the whole server-side cache.
 *
 * The browser only ever holds the rows it asked for, so a client-side search
 * can only find what is already on screen. This searches everything the feed
 * has heard, which is the difference between "not found" and "not loaded".
 *
 * Exact identifiers rank above name matches, and a name prefix above a
 * substring, so typing a full MMSI or a vessel's opening letters puts the
 * intended hull first.
 *
 * @param {string} query MMSI, IMO or vessel name (or part of one).
 * @param {number} limit Maximum rows to return.
 * @returns {Array<Object>} Matching rows, best first.
 */
export function searchAisVessels(query, limit = 20) {
  const raw = String(query ?? '').trim();
  if (raw.length < 2) return [];
  const upper = raw.toUpperCase();
  const digits = raw.replace(/\D/g, '');
  const cap = Math.max(1, Math.min(200, Math.floor(limit) || 20));

  const exact = [];
  const prefix = [];
  const contains = [];
  for (const row of _aisStreamVessels.values()) {
    if (digits.length >= 7) {
      if (row.mmsi === digits || row.imo === digits) {
        exact.push(row);
        if (exact.length >= cap) break;
        continue;
      }
    }
    const name = String(row.name || '').toUpperCase();
    if (!name) continue;
    if (name === upper) exact.push(row);
    else if (name.startsWith(upper)) prefix.push(row);
    else if (upper.length >= 3 && name.includes(upper)) contains.push(row);
  }
  // Freshest first within each tier — a stale duplicate name is less useful.
  const byRecency = (a, b) => b._updatedAt - a._updatedAt;
  exact.sort(byRecency);
  prefix.sort(byRecency);
  contains.sort(byRecency);
  return [...exact, ...prefix, ...contains]
    .slice(0, cap)
    .map(({ _updatedAt, ...row }) => row);
}

/**
 * Static data for a vessel, seeded from durable history the first time this
 * process sees the MMSI.
 *
 * AIS sends position reports every few seconds but static reports only every
 * few minutes, so a restarted server knows thousands of hulls by position
 * alone — no type, no dimensions, no draught, no destination. Everything
 * downstream (cards, cargo, narrative) then reports "unknown" about a vessel
 * the database already describes. Seeding closes that window.
 */
function hydratedStatic(mmsi) {
  const existing = _aisStreamStatic.get(mmsi);
  if (existing) return existing;
  if (_aisHydrated.has(mmsi)) return {};
  _aisHydrated.add(mmsi);
  const seeded = aisHistory()?.hydrate(mmsi);
  if (!seeded) return {};
  _aisStreamStatic.set(mmsi, seeded);
  observeDraught(mmsi, seeded.draught);
  return seeded;
}

/** Cache diagnostics — what the store is holding and under what budget. */
export function aisCacheStats() {
  const now = Date.now();
  const liveCutoff = now - aisStaleMs();
  let live = 0;
  let oldestMs = 0;
  for (const row of _aisStreamVessels.values()) {
    if (row._updatedAt >= liveCutoff) live += 1;
    const age = now - row._updatedAt;
    if (age > oldestMs) oldestMs = age;
  }
  return {
    cached: _aisStreamVessels.size,
    live,
    cacheMax: aisCacheMax(),
    retentionMin: Math.round(aisStaleMs() / 60000),
    reckonHours: reckoningMaxHours(),
    oldestAgeMin: Math.round(oldestMs / 60000),
    staticEntries: _aisStreamStatic.size,
    tracks: _aisStreamTracks.size,
  };
}

/** One vessel's current row (identity routes), or null when not cached. */
export function aisStreamRowFor(mmsi) {
  const row = _aisStreamVessels.get(String(mmsi || '').trim());
  if (!row) return null;
  const { _updatedAt, ...rest } = row;
  return rest;
}

/**
 * Current vessel rows: live observations first, then dead-reckoned estimates
 * for hulls that have gone quiet but are still within the projection horizon.
 *
 * Estimates are clearly marked and sorted after every real fix, so a caller
 * that takes the first N rows gets observations in preference to projections.
 */
export function aisStreamRows(maxRows) {
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const liveCutoff = now - aisStaleMs();
  const live = [];
  const quiet = [];
  for (const row of _aisStreamVessels.values()) {
    if (row._updatedAt >= liveCutoff) live.push(row);
    else quiet.push(row);
  }
  live.sort((a, b) => b._updatedAt - a._updatedAt);
  const rows = live.slice(0, maxRows).map(({ _updatedAt, ...row }) => row);
  if (!quiet.length || rows.length >= maxRows || !reckoningEnabled())
    return rows;

  // The live feed doubles as the coverage map, so a hull's silence can be read
  // against whether that patch of sea is still being heard at all.
  const coverage = buildCoverageCells(rows, nowSec);
  const maxHours = reckoningMaxHours();
  const estimates = [];
  for (const row of quiet) {
    const projection = reckonVessel(row, nowSec, maxHours);
    if (!projection || projection.confidence <= 0) continue;
    const { _updatedAt, ...rest } = row;
    estimates.push({
      ...rest,
      lat: projection.lat,
      lon: projection.lon,
      estimated: true,
      est_moved: projection.moved,
      est_age_sec: Math.round(projection.elapsedSec),
      est_confidence: projection.confidence,
      // The fix the estimate was projected from, so a client can draw the leg.
      est_from_lat: rest.lat,
      est_from_lon: rest.lon,
      gap_kind: classifyGap(rest, coverage),
    });
  }
  estimates.sort((a, b) => b.est_confidence - a.est_confidence);
  return rows.concat(estimates.slice(0, maxRows - rows.length));
}

function pruneAisStreamCache() {
  // Vessels are held for the longer of the live window and the reckoning
  // horizon: dropping a hull at the live cutoff is exactly the vanishing
  // behaviour dead reckoning exists to fix.
  const holdMs = reckoningEnabled()
    ? Math.max(aisStaleMs(), reckoningMaxHours() * 3600 * 1000)
    : aisStaleMs();
  const cutoff = Date.now() - holdMs;
  const cacheMax = aisCacheMax();
  for (const [mmsi, row] of _aisStreamVessels) {
    if (row._updatedAt < cutoff) {
      _aisStreamVessels.delete(mmsi);
      _aisStreamTracks.delete(mmsi);
      _aisStreamTrackPending.delete(mmsi);
      _aisDraughtRange.delete(mmsi);
      _aisHydrated.delete(mmsi);
    }
  }
  // Pending single-fix entries for vessels never seen again must not leak
  const pendingCutoffSec = Math.floor(cutoff / 1000);
  for (const [mmsi, pending] of _aisStreamTrackPending) {
    if (pending.epochSec < pendingCutoffSec)
      _aisStreamTrackPending.delete(mmsi);
  }
  if (_aisStreamVessels.size <= cacheMax) return;
  const ordered = [..._aisStreamVessels.entries()].sort(
    (a, b) => a[1]._updatedAt - b[1]._updatedAt,
  );
  for (const [mmsi] of ordered.slice(0, _aisStreamVessels.size - cacheMax)) {
    _aisStreamVessels.delete(mmsi);
    _aisStreamTracks.delete(mmsi);
    _aisStreamTrackPending.delete(mmsi);
    _aisDraughtRange.delete(mmsi);
    _aisHydrated.delete(mmsi);
  }
}

export function newestAisPositionAt(rows) {
  return rows[0]?.last_position_UTC || null;
}

function stringValue(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
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

function normalizeAisTimestamp(value) {
  const text = stringValue(value);
  if (!text) return new Date().toISOString();
  const normalized = text.replace(' +0000 UTC', 'Z').replace(' UTC', 'Z');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString();
}
