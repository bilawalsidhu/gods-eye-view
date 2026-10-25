/**
 * Emergency services records: Seattle Fire 911 dispatches (data.seattle.gov
 * kzjm-xkqj), Everett Police calls (data.everettwa.gov f6vp-3svh) and King
 * County Sheriff offense reports (data.kingcounty.gov 4kmt-kfqf).
 */

export const SEATTLE_TIME_ZONE = 'America/Los_Angeles';
export const MAX_DISPATCH_CALLS = 1000;

/** Call categories, in legend order, with the type-text patterns that select them. */
export const DISPATCH_CATEGORIES = Object.freeze([
  Object.freeze({
    id: 'fire',
    label: 'Fire',
    color: '#ff5a36',
    pattern: /fire|burn|smoke|explosion/i,
  }),
  Object.freeze({
    id: 'medical',
    label: 'Medical',
    color: '#3fa9ff',
    pattern: /aid|medic|overdose|medical|acuity|amr|crisis|violence/i,
  }),
  Object.freeze({
    id: 'alarm',
    label: 'Alarm',
    color: '#ffb020',
    pattern: /alarm|bell|detector/i,
  }),
  Object.freeze({
    id: 'vehicle',
    label: 'Vehicle',
    color: '#c08bff',
    pattern: /\bmvi\b|motor vehicle|vehicle|freeway/i,
  }),
  Object.freeze({
    id: 'rescue',
    label: 'Rescue',
    color: '#4dd88a',
    pattern: /rescue|extrication|water|elevator|marine/i,
  }),
  Object.freeze({
    id: 'hazard',
    label: 'Hazard',
    color: '#ffe14d',
    pattern: /gas|hazmat|wires|odor|\bco\b|spill|leak/i,
  }),
  Object.freeze({ id: 'police', label: 'Police', color: '#ff4fa3' }),
  Object.freeze({ id: 'sheriff', label: 'Sheriff report', color: '#00c8d7' }),
  Object.freeze({ id: 'other', label: 'Other', color: '#9aa7b4' }),
]);

const categoryById = (id) =>
  DISPATCH_CATEGORIES.find((category) => category.id === id);
const ALARM = categoryById('alarm');
const OTHER = categoryById('other');
const POLICE = categoryById('police');
const SHERIFF = categoryById('sheriff');

/** Feeds, keyed by the prefix that keeps their ids apart. */
export const DISPATCH_AGENCIES = Object.freeze({
  sfd: Object.freeze({ id: 'sfd', name: 'Seattle Fire', idLabel: 'Incident' }),
  epd: Object.freeze({ id: 'epd', name: 'Everett Police', idLabel: 'Event' }),
  kcso: Object.freeze({
    id: 'kcso',
    name: 'King County Sheriff',
    idLabel: 'Case',
  }),
});
// Rows stamped later than this are clock or entry errors, not calls.
const FUTURE_TOLERANCE_MS = 10 * 60 * 1000;

/** Pick the category for a dispatch type such as "Aid Response" or "Car Fire". */
export function dispatchCategory(type) {
  const value = String(type || '');
  // "Auto Fire Alarm" is an alarm, not a fire.
  if (ALARM.pattern.test(value)) return ALARM;
  return (
    DISPATCH_CATEGORIES.find((category) => category.pattern?.test(value)) ||
    OTHER
  );
}

function zoneOffsetMs(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const part = (type) =>
    Number(parts.find((entry) => entry.type === type)?.value);
  const asUtc = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Convert a zone-less Socrata timestamp ("2026-10-12T14:13:00.000"), which the
 * dataset records in Seattle local time, to epoch milliseconds.
 * @returns {number|null}
 */
export function seattleLocalToEpoch(value, timeZone = SEATTLE_TIME_ZONE) {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(
      String(value || ''),
    );
  if (!match) return null;
  const [, y, mo, d, h, mi, s = '0'] = match;
  const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  if (!Number.isFinite(wall)) return null;
  // Resolve the offset at the guessed instant, then again across DST edges.
  const guess = wall - zoneOffsetMs(wall, timeZone);
  return wall - zoneOffsetMs(guess, timeZone);
}

/** Format an epoch as Seattle wall time for a Socrata `$where` clause. */
export function epochToSeattleLocal(epochMs, timeZone = SEATTLE_TIME_ZONE) {
  const local = new Date(epochMs + zoneOffsetMs(epochMs, timeZone));
  return local.toISOString().slice(0, 19);
}

function validPosition(lat, lon) {
  return (
    lat !== null &&
    lon !== null &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    !(lat === 0 && lon === 0)
  );
}

function clean(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Socrata sends coordinates as strings; blank or missing is not zero. */
function coordinate(value) {
  if (typeof value === 'string' && !value.trim()) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Validate one Socrata page. Rows without a valid position, type, incident
 * number or time are dropped, as are test calls; a non-array payload rejects
 * the whole snapshot.
 * @returns {Array<object>|null}
 */
export function normalizeDispatchSnapshot(payload) {
  const agency = DISPATCH_AGENCIES.sfd;
  if (!Array.isArray(payload)) return null;
  const calls = [];
  const seen = new Set();
  for (const row of payload) {
    if (calls.length >= MAX_DISPATCH_CALLS) break;
    if (!row || typeof row !== 'object') continue;
    const incident = clean(row.incident_number, 32);
    const type = clean(row.type, 80);
    const time = seattleLocalToEpoch(row.datetime);
    if (!incident || !type || time === null || seen.has(incident)) continue;
    if (/^test\b/i.test(type)) continue;
    const lat = coordinate(row.latitude);
    const lon = coordinate(row.longitude);
    if (!validPosition(lat, lon)) continue;
    seen.add(incident);
    const category = dispatchCategory(type);
    calls.push({
      id: `${agency.id}:${incident}`,
      agency: agency.id,
      incident,
      type,
      category: category.id,
      color: category.color,
      address: clean(row.address, 120),
      lat,
      lon,
      time,
    });
  }
  return calls;
}

/**
 * Validate one page of Everett Police calls for service. Addresses are already
 * generalized to the 100 block by the city. Rows stamped in the future are
 * dropped.
 * @returns {Array<object>|null}
 */
export function normalizeEverettPoliceSnapshot(
  payload,
  { now = Date.now() } = {},
) {
  if (!Array.isArray(payload)) return null;
  const agency = DISPATCH_AGENCIES.epd;
  const calls = [];
  const seen = new Set();
  for (const row of payload) {
    if (calls.length >= MAX_DISPATCH_CALLS) break;
    if (!row || typeof row !== 'object') continue;
    const incident = clean(row.eventnumber, 32);
    const type = clean(row.incidenttype, 80);
    const time = seattleLocalToEpoch(row.datetimereceived);
    if (!incident || !type || time === null || seen.has(incident)) continue;
    if (time > now + FUTURE_TOLERANCE_MS) continue;
    const [lonValue, latValue] = Array.isArray(row.geomcoordinate?.coordinates)
      ? row.geomcoordinate.coordinates
      : [];
    const lat = coordinate(latValue);
    const lon = coordinate(lonValue);
    if (!validPosition(lat, lon)) continue;
    seen.add(incident);
    calls.push({
      id: `${agency.id}:${incident}`,
      agency: agency.id,
      incident,
      type,
      category: POLICE.id,
      color: POLICE.color,
      address: clean(row.eventaddressby100block, 120).replace(/\s+,/g, ','),
      lat,
      lon,
      time,
    });
  }
  return calls;
}

/**
 * Index King County Sheriff reporting areas (data.kingcounty.gov wab8-9yes)
 * by area code, keeping each area's published label point.
 * @returns {Map<string, {lat: number, lon: number}>|null}
 */
export function normalizeReportingAreas(payload) {
  if (!Array.isArray(payload)) return null;
  const areas = new Map();
  for (const row of payload) {
    const area = clean(row?.area, 16).toUpperCase();
    const lat = coordinate(row?.y_coord);
    const lon = coordinate(row?.x_coord);
    if (area && validPosition(lat, lon)) areas.set(area, { lat, lon });
  }
  return areas;
}

/** "Reporting Area H03024" -> "H03024". */
export function reportingAreaCode(value) {
  return /([A-Z]\d{4,6})\s*$/i.exec(clean(value, 40))?.[1]?.toUpperCase() || '';
}

// Reports share their area's single label point; spread them on a small
// sunflower spiral so each stays clickable. Positions are approximate anyway.
const SPREAD_STEP_M = 45;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function spread(origin, index) {
  if (!index) return origin;
  const radius = SPREAD_STEP_M * Math.sqrt(index);
  const angle = index * GOLDEN_ANGLE;
  const lat = origin.lat + (radius * Math.cos(angle)) / 111_320;
  const lon =
    origin.lon +
    (radius * Math.sin(angle)) /
      (111_320 * Math.cos((origin.lat * Math.PI) / 180));
  return { lat, lon };
}

/**
 * Validate one page of King County Sheriff offense reports. The dataset has
 * no coordinates, so each case is placed at its reporting area's label point
 * and marked approximate; cases in unknown areas are dropped. A case with
 * several offenses becomes one entry.
 * @returns {Array<object>|null}
 */
export function normalizeSheriffReports(
  payload,
  areas,
  { now = Date.now() } = {},
) {
  if (!Array.isArray(payload) || !(areas instanceof Map)) return null;
  const agency = DISPATCH_AGENCIES.kcso;
  const calls = [];
  const byCase = new Map();
  const perArea = new Map();
  for (const row of payload) {
    if (!row || typeof row !== 'object') continue;
    const incident = clean(row.case_number, 32);
    const type = clean(row.nibrs_code_name, 80);
    const time = seattleLocalToEpoch(row.incident_datetime);
    if (!incident || !type || time === null) continue;
    if (time > now + FUTURE_TOLERANCE_MS) continue;
    const existing = byCase.get(incident);
    if (existing) {
      if (!existing.offenses.includes(type)) existing.offenses.push(type);
      continue;
    }
    if (calls.length >= MAX_DISPATCH_CALLS) continue;
    const area = reportingAreaCode(row.reporting_area);
    const origin = areas.get(area);
    if (!origin) continue;
    const index = perArea.get(area) || 0;
    perArea.set(area, index + 1);
    const { lat, lon } = spread(origin, index);
    const block = clean(row.block_address, 100);
    const city = clean(row.city, 40);
    const call = {
      id: `${agency.id}:${incident}`,
      agency: agency.id,
      incident,
      type,
      offenses: [type],
      category: SHERIFF.id,
      color: SHERIFF.color,
      address: [block, city].filter(Boolean).join(', '),
      area,
      approximate: true,
      lat,
      lon,
      time,
    };
    byCase.set(incident, call);
    calls.push(call);
  }
  for (const call of calls) {
    if (call.offenses.length > 1)
      call.type = `${call.offenses[0]} (+${call.offenses.length - 1})`;
  }
  return calls;
}
