/**
 * GNSS interference inferred from ADS-B navigation integrity.
 *
 * Aircraft broadcasting DO-260 version 1/2 ADS-B report how much they trust
 * their own position: NIC (integrity containment radius) and NACp (position
 * accuracy). Both collapse when the GNSS receiver is jammed or spoofed, so a
 * cluster of aircraft reporting low values in one area is a well-known public
 * proxy for interference (the method popularized by gpsjam.org and the
 * readsb/tar1090 `gpsOkBefore` flag). It is an inference, not a detection:
 * avionics faults and old transponders also report low values, which is why
 * cells need several aircraft and the first degraded aircraft is discounted.
 */

/** Direct 1090ES ADS-B only: MLAT, TIS-B and ADS-R positions are not self-reported. */
const QUALIFYING_TYPES = new Set(['adsb_icao']);
/** NIC below 7 means a containment radius above 0.2 NM (RNP 0.3 and worse). */
export const GNSS_NIC_THRESHOLD = 7;
/** NACp below 8 means an estimated position uncertainty of 93 m or more. */
export const GNSS_NACP_THRESHOLD = 8;
/** Positions older than this are not current evidence of the local sky. */
const MAX_POSITION_AGE_S = 60;
/** Cell edge in degrees: roughly 55 km north-south, similar in area to an H3 res-4 cell. */
export const GNSS_CELL_DEG = 0.5;
/** Fewer aircraft than this in a cell cannot distinguish one faulty transponder from interference. */
export const GNSS_MIN_AIRCRAFT = 3;
/** Rolling window over which aircraft seen in a cell are counted. */
export const GNSS_WINDOW_MS = 30 * 60_000;

const HEX_PATTERN = /^~?[0-9a-f]{6}$/;

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * Reduce one adsb.lol / readsb `aircraft.json`-style payload to the integrity
 * facts the layer needs. Returns null when the payload has no aircraft array.
 *
 * @param {{ac?: object[], now?: number}} payload - readsb-style snapshot.
 * @returns {{hex: string, lat: number, lon: number, nic: number, nacp: number, gpsLost: boolean, degraded: boolean}[]|null}
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
    if (!finite(aircraft.version) || aircraft.version < 1) continue;
    if (aircraft.alt_baro === 'ground' || !finite(aircraft.alt_baro)) continue;
    const { lat, lon, nic, nac_p: nacp } = aircraft;
    if (!finite(lat) || Math.abs(lat) > 90) continue;
    if (!finite(lon) || Math.abs(lon) > 180) continue;
    if (!finite(nic) || !finite(nacp)) continue;
    if (finite(aircraft.seen_pos) && aircraft.seen_pos > MAX_POSITION_AGE_S)
      continue;
    const gpsLost = aircraft.gpsOkBefore != null;
    seen.add(hex);
    rows.push({
      hex,
      lat,
      lon,
      nic,
      nacp,
      gpsLost,
      degraded:
        gpsLost || nic < GNSS_NIC_THRESHOLD || nacp < GNSS_NACP_THRESHOLD,
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
 * once per cell per window; a degraded report in the window keeps it degraded
 * there, so an aircraft that loses GNSS mid-cell is not averaged away.
 *
 * @param {Map<string, {cell: string, degraded: boolean, seenAt: number}>} store
 * @param {ReturnType<typeof normalizeGnssAircraft>} rows
 * @param {number} nowMs
 * @param {{windowMs?: number, cellDeg?: number}} [options]
 * @returns {Map} The same store, pruned to the window.
 */
export function accumulateGnssObservations(
  store,
  rows,
  nowMs,
  { windowMs = GNSS_WINDOW_MS, cellDeg = GNSS_CELL_DEG } = {},
) {
  for (const row of rows || []) {
    const cell = gnssCellKey(row.lat, row.lon, cellDeg);
    const key = `${row.hex}|${cell}`;
    const previous = store.get(key);
    store.set(key, {
      cell,
      degraded: row.degraded || (previous?.degraded ?? false),
      seenAt: nowMs,
    });
  }
  for (const [key, entry] of store) {
    if (nowMs - entry.seenAt > windowMs) store.delete(key);
  }
  return store;
}

/**
 * Interference level of a cell, using gpsjam.org's published formula and
 * bands: the first degraded aircraft is discounted to limit false positives,
 * then under 2% is low, 2–10% medium and over 10% high.
 */
export function gnssInterferenceLevel(total, degraded) {
  const percent = total > 0 ? (100 * Math.max(0, degraded - 1)) / total : 0;
  return {
    percent,
    level: percent > 10 ? 'high' : percent >= 2 ? 'medium' : 'low',
  };
}

/**
 * Aggregate the observation store into displayable cells.
 *
 * @returns {{id: string, south: number, west: number, north: number, east: number, lat: number, lon: number, aircraft: number, degraded: number, percentDegraded: number, level: 'low'|'medium'|'high'}[]}
 */
export function binGnssCells(
  store,
  { cellDeg = GNSS_CELL_DEG, minAircraft = GNSS_MIN_AIRCRAFT } = {},
) {
  const tallies = new Map();
  for (const { cell, degraded } of store.values()) {
    const tally = tallies.get(cell) || { aircraft: 0, degraded: 0 };
    tally.aircraft += 1;
    if (degraded) tally.degraded += 1;
    tallies.set(cell, tally);
  }
  const cells = [];
  for (const [id, { aircraft, degraded }] of tallies) {
    if (aircraft < minAircraft) continue;
    const [row, col] = id.split(':').map(Number);
    const south = row * cellDeg - 90;
    const west = col * cellDeg - 180;
    const { percent, level } = gnssInterferenceLevel(aircraft, degraded);
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
