/**
 * Low navigation accuracy reported by ADS-B aircraft, binned into cells.
 *
 * Aircraft broadcasting DO-260 version 1/2 ADS-B report how much they trust
 * their own position: NIC (integrity containment radius) and NACp (position
 * accuracy). A cluster of aircraft reporting low values in one area is a
 * navigation-integrity anomaly. Jamming or spoofing is one common cause, so
 * such clusters are a well-known public proxy for GNSS interference, but
 * avionics faults and old transponders also report low values: suspected
 * interference is a second, unvalidated interpretation, never the primary
 * state.
 *
 * Three separately sourced parts make up the method (see `gnssProvenance`):
 * - Per-aircraft classifier, defined by GEV: aircraft-reported NIC < 7
 *   (except unknown NIC 0 with NACp >= 10) or NACp < 8 (borrowed
 *   from the US 14 CFR 91.227(c) ADS-B Out performance minima, which are not
 *   a published interference classifier) or the readsb/tar1090 `gpsOkBefore`
 *   flag. gpsjam.org does not publish its per-aircraft threshold.
 * - Cell aggregation: gpsjam.org's published formula and 2% / 10% bands.
 * - Window: a GEV-defined rolling 30 minutes over the views the user visits.
 */

/** Position source can switch to MLAT after GPS loss; quality must remain aircraft-reported. */
const QUALIFYING_TYPES = new Set(['adsb_icao', 'mlat']);
/** Restrict to decoded DO-260A/B quality fields; readsb does not decode v3 quality as v3. */
const QUALIFYING_VERSIONS = new Set([1, 2]);
/** NIC below 7: containment radius of 0.2 NM or more (below the US 91.227 ADS-B Out minimum). GEV threshold. */
export const GNSS_NIC_THRESHOLD = 7;
/** NACp below 8: position uncertainty of 93 m or more (below the US 91.227 minimum). GEV threshold. */
export const GNSS_NACP_THRESHOLD = 8;
/** Positions older than this are not current evidence of the local sky. */
const MAX_POSITION_AGE_S = 60;
/** Cell edge in degrees: roughly 55 km north-south, similar in area to an H3 res-4 cell. */
export const GNSS_CELL_DEG = 0.5;
/** Hide sparse one- and two-aircraft cells; the aggregation separately discounts one bad report. */
export const GNSS_MIN_AIRCRAFT = 3;
/** Rolling window over which aircraft seen in a cell are counted. */
export const GNSS_WINDOW_MS = 30 * 60_000;
/** gpsjam.org band edges, in percent of aircraft (after discounting one). */
export const GNSS_MEDIUM_PERCENT = 2;
export const GNSS_HIGH_PERCENT = 10;

/** Primary cell state: what the data shows (low navigation accuracy). */
export const GNSS_ANOMALY_STATE = 'navigation-integrity-anomaly';
export const GNSS_NOMINAL_STATE = 'nominal';
/** Secondary, unvalidated reading of an anomaly cell. */
export const GNSS_INTERPRETATION = 'suspected-gnss-interference';

/** The per-aircraft rule; GEV-defined and not validated against known events. */
export const GNSS_CLASSIFIER = Object.freeze({
  id: 'gev-nic-nacp-v2',
  rule: `gpsOkBefore set || aircraft-reported NACp < ${GNSS_NACP_THRESHOLD} || (aircraft-reported NIC < ${GNSS_NIC_THRESHOLD} && !(NIC === 0 && NACp >= 10))`,
  basis: '14 CFR 91.227(c) ADS-B Out performance minima (US regulation)',
  definedBy: 'GEV',
  validated: false,
});

/**
 * Machine-readable provenance of the cell output: which part of the method
 * comes from where, and which parts are unvalidated.
 *
 * @param {{windowMs?: number}} [options] The window the layer actually uses.
 */
export function gnssProvenance({ windowMs = GNSS_WINDOW_MS } = {}) {
  return Object.freeze({
    classifier: GNSS_CLASSIFIER,
    aggregation: Object.freeze({
      id: 'gpsjam-cell-bands',
      formula: '100 * max(0, bad - 1) / total',
      bands: Object.freeze([GNSS_MEDIUM_PERCENT, GNSS_HIGH_PERCENT]),
      source: 'https://gpsjam.org/faq',
      definedBy: 'gpsjam.org',
    }),
    window: Object.freeze({
      minutes: windowMs / 60_000,
      scope: 'visited-view',
      cellDeg: GNSS_CELL_DEG,
      minAircraft: GNSS_MIN_AIRCRAFT,
      definedBy: 'GEV',
    }),
    state: Object.freeze({
      id: GNSS_ANOMALY_STATE,
      meaning: 'low navigation accuracy reported by ADS-B aircraft',
    }),
    interpretation: Object.freeze({
      id: GNSS_INTERPRETATION,
      validated: false,
      note: 'one possible cause of an anomaly cell; avionics faults also report low values',
    }),
  });
}

/** Provenance at the default window. */
export const GNSS_PROVENANCE = gnssProvenance();

const HEX_PATTERN = /^~?[0-9a-f]{6}$/;

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * Reduce one adsb.lol / readsb `aircraft.json`-style payload to the integrity
 * facts the layer needs. Returns null when the payload has no aircraft array.
 *
 * @param {{ac?: object[], now?: number}} payload - readsb-style snapshot.
 * @returns {{hex: string, lat: number, lon: number, nic: number|null, nacp: number|null, gpsLost: boolean, degraded: boolean}[]|null}
 */
export function normalizeGnssAircraft(payload) {
  if (!Array.isArray(payload?.ac)) return null;
  const rows = [];
  const seen = new Set();
  for (const aircraft of payload.ac) {
    if (!aircraft || typeof aircraft !== 'object') continue;
    const hex = typeof aircraft.hex === 'string' ? aircraft.hex : '';
    if (!HEX_PATTERN.test(hex) || seen.has(hex)) continue;
    if (!QUALIFYING_TYPES.has(aircraft.type)) continue;
    if (!QUALIFYING_VERSIONS.has(aircraft.version)) continue;
    if (aircraft.alt_baro === 'ground' || !finite(aircraft.alt_baro)) continue;
    let { lat, lon } = aircraft;
    const derived = (field) =>
      aircraft.tisb?.includes(field) || aircraft.mlat?.includes(field);
    const nic = finite(aircraft.nic) && !derived('nic') ? aircraft.nic : null;
    const nacp =
      finite(aircraft.nac_p) && !derived('nac_p') ? aircraft.nac_p : null;
    if (!finite(lat) || Math.abs(lat) > 90) continue;
    if (!finite(lon) || Math.abs(lon) > 180) continue;
    // Only a position confirmed within the last minute is current evidence; a
    // missing, invalid or negative age confirms nothing.
    const age = aircraft.seen_pos;
    if (!finite(age) || age < 0 || age > MAX_POSITION_AGE_S) continue;
    // readsb exposes the flag while GPS is lost (15 s–15 min after the
    // last good position), and removes it on recovery. Locate that evidence
    // at the last good GNSS position, rather than a later MLAT estimate.
    const gpsLost = finite(aircraft.gpsOkBefore) && aircraft.gpsOkBefore > 0;
    if (nic === null && nacp === null && !gpsLost) continue;
    if (
      gpsLost &&
      finite(aircraft.gpsOkLat) &&
      Math.abs(aircraft.gpsOkLat) <= 90 &&
      finite(aircraft.gpsOkLon) &&
      Math.abs(aircraft.gpsOkLon) <= 180
    ) {
      lat = aircraft.gpsOkLat;
      lon = aircraft.gpsOkLon;
    }
    seen.add(hex);
    rows.push({
      hex,
      lat,
      lon,
      nic,
      nacp,
      gpsLost,
      degraded:
        gpsLost ||
        (nacp !== null && nacp < GNSS_NACP_THRESHOLD) ||
        (nic !== null &&
          nic < GNSS_NIC_THRESHOLD &&
          !(nic === 0 && nacp !== null && nacp >= 10)),
    });
  }
  return rows;
}

/** Stable key of the cell containing a position. */
export function gnssCellKey(lat, lon, cellDeg = GNSS_CELL_DEG) {
  const row = Math.floor((Math.min(lat, 89.999999) + 90) / cellDeg);
  const col = Math.floor((Math.min(lon, 179.999999) + 180) / cellDeg);
  return `${row}:${col}`;
}

/**
 * Fold one snapshot into a rolling observation store. Each aircraft counts
 * once per cell per window. Presence and degraded evidence age separately: a
 * degraded report keeps the aircraft degraded in that cell for one window
 * after the report itself, however many healthy reports follow, so an
 * aircraft that loses GNSS mid-cell is not averaged away and a recovered one
 * is not held degraded forever.
 *
 * Every row is dated by when the snapshot was observed, not when it arrived:
 * replaying a cached or stale snapshot never makes its evidence younger, and
 * a snapshot older than the window adds nothing.
 *
 * @param {Map<string, {cell: string, seenAt: number, degradedAt: number|null}>} store
 * @param {ReturnType<typeof normalizeGnssAircraft>} rows
 * @param {number} nowMs
 * @param {{windowMs?: number, cellDeg?: number, observedAt?: number}} [options]
 *   `observedAt` is the snapshot's observation time (defaults to `nowMs`;
 *   a future time is clamped to `nowMs`, a non-finite one adds nothing).
 * @returns {Map} The same store, pruned to the window.
 */
export function accumulateGnssObservations(
  store,
  rows,
  nowMs,
  {
    windowMs = GNSS_WINDOW_MS,
    cellDeg = GNSS_CELL_DEG,
    observedAt = nowMs,
  } = {},
) {
  const at = Number.isFinite(observedAt) ? Math.min(observedAt, nowMs) : NaN;
  if (Number.isFinite(at) && nowMs - at <= windowMs) {
    for (const row of rows || []) {
      if (!Number.isFinite(row?.lat) || !Number.isFinite(row?.lon)) continue;
      const cell = gnssCellKey(row.lat, row.lon, cellDeg);
      const key = `${row.hex}|${cell}`;
      const previous = store.get(key);
      const previousDegradedAt = previous?.degradedAt ?? null;
      store.set(key, {
        cell,
        seenAt: Math.max(previous?.seenAt ?? at, at),
        degradedAt: row.degraded
          ? Math.max(previousDegradedAt ?? at, at)
          : previousDegradedAt,
      });
    }
  }
  return pruneGnssObservations(store, nowMs, { windowMs });
}

/**
 * Drop observations older than the window and degraded evidence older than
 * the window, without adding anything. Used when no fresh snapshot arrives.
 *
 * @param {Map<string, {cell: string, seenAt: number, degradedAt: number|null}>} store
 * @param {number} nowMs
 * @param {{windowMs?: number}} [options]
 * @returns {Map} The same store.
 */
export function pruneGnssObservations(
  store,
  nowMs,
  { windowMs = GNSS_WINDOW_MS } = {},
) {
  for (const [key, entry] of store) {
    if (nowMs - entry.seenAt > windowMs) store.delete(key);
    else if (entry.degradedAt != null && nowMs - entry.degradedAt > windowMs)
      store.set(key, { ...entry, degradedAt: null });
  }
  return store;
}

/**
 * Navigation-integrity level of a cell, using gpsjam.org's published cell
 * formula and bands: the first degraded aircraft is discounted to limit false
 * positives, then under 2% is low, 2–10% medium and over 10% high. Medium and
 * high cells are navigation-integrity anomalies.
 */
export function gnssIntegrityLevel(total, degraded) {
  const percent = total > 0 ? (100 * Math.max(0, degraded - 1)) / total : 0;
  const level =
    percent > GNSS_HIGH_PERCENT
      ? 'high'
      : percent >= GNSS_MEDIUM_PERCENT
        ? 'medium'
        : 'low';
  const anomaly = level !== 'low';
  return {
    percent,
    level,
    state: anomaly ? GNSS_ANOMALY_STATE : GNSS_NOMINAL_STATE,
    interpretation: anomaly ? GNSS_INTERPRETATION : null,
  };
}

/**
 * Aggregate the observation store into displayable cells. Expects a store
 * already pruned to the window by `accumulateGnssObservations` or
 * `pruneGnssObservations`.
 *
 * @returns {{id: string, south: number, west: number, north: number, east: number, lat: number, lon: number, aircraft: number, degraded: number, percentDegraded: number, level: 'low'|'medium'|'high', state: string, interpretation: string|null}[]}
 */
export function binGnssCells(
  store,
  { cellDeg = GNSS_CELL_DEG, minAircraft = GNSS_MIN_AIRCRAFT } = {},
) {
  const tallies = new Map();
  for (const { cell, degradedAt } of store.values()) {
    const tally = tallies.get(cell) || { aircraft: 0, degraded: 0 };
    tally.aircraft += 1;
    if (degradedAt != null) tally.degraded += 1;
    tallies.set(cell, tally);
  }
  const cells = [];
  for (const [id, { aircraft, degraded }] of tallies) {
    if (aircraft < minAircraft) continue;
    const [row, col] = id.split(':').map(Number);
    const south = row * cellDeg - 90;
    const west = col * cellDeg - 180;
    const { percent, level, state, interpretation } = gnssIntegrityLevel(
      aircraft,
      degraded,
    );
    cells.push({
      id,
      south,
      west,
      north: south + cellDeg,
      east: west + cellDeg,
      lat: south + cellDeg / 2,
      lon: west + cellDeg / 2,
      aircraft,
      degraded,
      percentDegraded: Math.round(percent * 10) / 10,
      level,
      state,
      interpretation,
    });
  }
  return cells.sort((a, b) => a.id.localeCompare(b.id));
}

/** Legend colors: gpsjam's green / amber / red convention. */
export const GNSS_LEVEL_COLORS = Object.freeze({
  low: '#3fb950',
  medium: '#e3b341',
  high: '#f85149',
});
