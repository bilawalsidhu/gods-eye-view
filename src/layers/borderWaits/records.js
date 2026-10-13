import { BORDER_CROSSING_LOCATIONS } from './crossings.js';

// CBP lane groups, in card order, and the lane types each one reports.
const LANE_GROUPS = Object.freeze([
  Object.freeze({
    mode: 'passenger',
    key: 'passenger_vehicle_lanes',
    lanes: Object.freeze([
      ['standard', 'standard_lanes'],
      ['nexus-sentri', 'NEXUS_SENTRI_lanes'],
      ['ready', 'ready_lanes'],
    ]),
  }),
  Object.freeze({
    mode: 'pedestrian',
    key: 'pedestrian_lanes',
    lanes: Object.freeze([
      ['standard', 'standard_lanes'],
      ['ready', 'ready_lanes'],
    ]),
  }),
  Object.freeze({
    mode: 'commercial',
    key: 'commercial_vehicle_lanes',
    lanes: Object.freeze([
      ['standard', 'standard_lanes'],
      ['fast', 'FAST_lanes'],
    ]),
  }),
]);

const BORDERS = Object.freeze({
  'Canadian Border': 'canada',
  'Mexican Border': 'mexico',
});

/** Trimmed single-line text, or null for blank, oversized or markup-bearing values. */
function text(value, max = 120) {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed || trimmed.length > max || /[<>\u0000-\u001f]/.test(trimmed))
    return null;
  return trimmed;
}

/** CBP sends counts as strings; blank means not reported. */
function count(value, max) {
  if (typeof value !== 'string' || !/^\d{1,4}$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return parsed <= max ? parsed : null;
}

/** "At 9:00 am EDT" → "9:00 am EDT". */
function updateTime(value) {
  const parsed = text(value, 40);
  return parsed ? parsed.replace(/^At\s+/i, '') : null;
}

function normalizeLane(mode, kind, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const status = text(raw.operational_status, 40);
  // N/A: this crossing has no such lane.
  if (!status || status === 'N/A') return null;
  return {
    mode,
    kind,
    status: status.toLowerCase(),
    delayMinutes: count(raw.delay_minutes, 1440),
    lanesOpen: count(raw.lanes_open, 99),
    updated: updateTime(raw.update_time),
  };
}

/**
 * The lane that colours a crossing: passenger standard, else pedestrian
 * standard, else commercial standard — the first one CBP reports.
 */
export function headlineLane(lanes) {
  for (const mode of ['passenger', 'pedestrian', 'commercial']) {
    const lane = lanes.find(
      (candidate) => candidate.mode === mode && candidate.kind === 'standard',
    );
    if (lane) return lane;
  }
  return null;
}

/**
 * Validate CBP's all-ports document and join each crossing to its bundled
 * location. Returns null for a malformed document, so a bad upstream response
 * can never replace the last good snapshot. Crossings that cannot be placed
 * (no bundled location, unknown border or no port name) are returned by id in
 * `unlocated` rather than silently dropped.
 * @param {unknown} payload - Parsed https://bwt.cbp.gov/api/bwtnew response.
 * @param {Record<string, {lat: number, lon: number}>} [locations]
 * @returns {{rows: Array<Object>, unlocated: string[]}|null}
 */
export function normalizeBorderWaitSnapshot(
  payload,
  locations = BORDER_CROSSING_LOCATIONS,
) {
  if (!Array.isArray(payload) || payload.length > 500) return null;
  const rows = [];
  const unlocated = [];
  const ids = new Set();
  for (const port of payload) {
    if (!port || typeof port !== 'object' || Array.isArray(port)) return null;
    const id = text(port.port_number, 12);
    if (!id || !/^[0-9A-Za-z]{6}$/.test(id) || ids.has(id)) return null;
    ids.add(id);
    const border = Object.hasOwn(BORDERS, port.border)
      ? BORDERS[port.border]
      : null;
    const portName = text(port.port_name, 80);
    const location = Object.hasOwn(locations, id) ? locations[id] : null;
    // One unplaceable crossing must not blank the other 84.
    if (!border || !portName || !location) {
      unlocated.push(id);
      continue;
    }
    const lanes = [];
    for (const group of LANE_GROUPS) {
      const raw = port[group.key];
      if (raw == null) continue;
      if (typeof raw !== 'object' || Array.isArray(raw)) return null;
      for (const [kind, key] of group.lanes) {
        const lane = normalizeLane(group.mode, kind, raw[key]);
        if (lane) lanes.push(lane);
      }
    }
    const headline = headlineLane(lanes);
    rows.push({
      id,
      border,
      port: portName,
      crossing: text(port.crossing_name, 80),
      lat: location.lat,
      lon: location.lon,
      portStatus: text(port.port_status, 40)?.toLowerCase() ?? null,
      hours: text(port.hours, 60),
      notice: text(port.construction_notice, 400),
      lanes,
      // Flattened for the analyst engine and the legend.
      delayMinutes: headline?.delayMinutes ?? null,
      delayStatus: headline?.status ?? null,
    });
  }
  return { rows, unlocated };
}
