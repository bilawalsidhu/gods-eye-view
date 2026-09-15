/**
 * Registered historic fire events — pure validation and FIRMS archive
 * request planning. No network, no Cesium, no filesystem: the server proxy
 * and the browser layer both consume these helpers.
 *
 * Upstream area API (standard-processing archive):
 *   https://firms.modaps.eosdis.nasa.gov/api/area/csv/{KEY}/{SOURCE}/{W,S,E,N}/{DAYS}/{YYYY-MM-DD}
 * With an explicit start date FIRMS caps `DAYS` at 5 (confirmed live
 * 2026-09-15: "Invalid day range. Expects [1..5]."), so a multi-week event is
 * split into consecutive windows by {@link splitDateWindows}.
 */

/** FIRMS caps one dated area request at this many days. */
export const FIRMS_MAX_WINDOW_DAYS = 5;

/** Archive (standard-processing) sources accepted in an event definition. */
export const FIRE_HISTORY_SOURCES = Object.freeze([
  'VIIRS_SNPP_SP',
  'VIIRS_NOAA20_SP',
  'VIIRS_NOAA21_SP',
  'MODIS_SP',
]);

const DAY_MS = 86_400_000;
const ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse an inclusive `YYYY-MM-DD` UTC day into epoch ms at 00:00Z.
 * @param {*} value - Candidate date string.
 * @returns {number} Epoch ms, or NaN when not a real calendar day.
 */
export function parseUtcDay(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return NaN;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms)) return NaN;
  // Reject "2018-02-31" style inputs that Date.parse silently rolls over.
  return new Date(ms).toISOString().slice(0, 10) === value ? ms : NaN;
}

/**
 * Format epoch ms as the `YYYY-MM-DD` UTC day FIRMS expects.
 * @param {number} ms - Epoch ms.
 * @returns {string}
 */
export function formatUtcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Validate one event definition and return a frozen normalized copy, or
 * null when any field would produce an unsafe or meaningless upstream
 * request. The id is also used as a cache filename, so it is strict.
 * @param {*} raw - Candidate event from config.
 * @returns {?object} Normalized event.
 */
export function normalizeFireEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!ID_PATTERN.test(id)) return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return null;
  const startMs = parseUtcDay(raw.startDate);
  const endMs = parseUtcDay(raw.endDate);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs)
    return null;
  if (!Array.isArray(raw.bbox) || raw.bbox.length !== 4) return null;
  const [west, south, east, north] = raw.bbox.map(Number);
  if (
    ![west, south, east, north].every(Number.isFinite) ||
    west < -180 ||
    east > 180 ||
    south < -90 ||
    north > 90 ||
    west >= east ||
    south >= north
  )
    return null;
  const sources = Array.isArray(raw.sources)
    ? raw.sources.filter((source) => FIRE_HISTORY_SOURCES.includes(source))
    : [];
  if (!sources.length) return null;
  const burnedHa = Number(raw.burnedHa);
  const references = Array.isArray(raw.references)
    ? raw.references
        .filter(
          (reference) =>
            reference &&
            typeof reference.label === 'string' &&
            typeof reference.url === 'string' &&
            /^https:\/\//.test(reference.url),
        )
        .map((reference) =>
          Object.freeze({ label: reference.label, url: reference.url }),
        )
    : [];
  return Object.freeze({
    id,
    name,
    region: typeof raw.region === 'string' ? raw.region.trim() : '',
    startDate: formatUtcDay(startMs),
    endDate: formatUtcDay(endMs),
    startMs,
    // Inclusive end day → the instant the following UTC day begins.
    endMs: endMs + DAY_MS,
    bbox: Object.freeze([west, south, east, north]),
    sources: Object.freeze([...new Set(sources)]),
    summary: typeof raw.summary === 'string' ? raw.summary.trim() : '',
    burnedHa: Number.isFinite(burnedHa) && burnedHa > 0 ? burnedHa : null,
    references: Object.freeze(references),
  });
}

/**
 * Validate a whole config payload. Invalid entries are dropped and reported
 * rather than aborting the list, so one typo cannot hide every event.
 * @param {*} payload - Parsed config JSON.
 * @returns {{events: object[], rejected: string[]}}
 */
export function normalizeFireEventCatalog(payload) {
  const list = Array.isArray(payload?.events) ? payload.events : [];
  const events = [];
  const rejected = [];
  const ids = new Set();
  for (const [index, raw] of list.entries()) {
    const event = normalizeFireEvent(raw);
    const label = String(raw?.id ?? `#${index + 1}`);
    if (!event || ids.has(event.id)) {
      rejected.push(label);
      continue;
    }
    ids.add(event.id);
    events.push(event);
  }
  return { events, rejected };
}

/**
 * Split an inclusive day range into consecutive FIRMS-sized windows.
 * @param {string} startDate - Inclusive first UTC day.
 * @param {string} endDate - Inclusive last UTC day.
 * @param {number} [maxDays] - Window cap (FIRMS allows at most 5).
 * @returns {Array<{date: string, days: number}>} Ordered windows.
 */
export function splitDateWindows(
  startDate,
  endDate,
  maxDays = FIRMS_MAX_WINDOW_DAYS,
) {
  const startMs = parseUtcDay(startDate);
  const endMs = parseUtcDay(endDate);
  const cap = Math.min(
    FIRMS_MAX_WINDOW_DAYS,
    Math.max(1, Math.floor(Number(maxDays) || 0)),
  );
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs)
    return [];
  const totalDays = Math.round((endMs - startMs) / DAY_MS) + 1;
  const windows = [];
  for (let offset = 0; offset < totalDays; offset += cap) {
    windows.push({
      date: formatUtcDay(startMs + offset * DAY_MS),
      days: Math.min(cap, totalDays - offset),
    });
  }
  return windows;
}

/**
 * The `W,S,E,N` area segment FIRMS expects, with bounded precision so a
 * config value cannot smuggle path characters into the upstream URL.
 * @param {number[]} bbox - [west, south, east, north].
 * @returns {string}
 */
export function firmsAreaSegment(bbox) {
  return bbox.map((value) => Number(value).toFixed(4)).join(',');
}

/**
 * Keep records inside the event's box and day range. FIRMS already filters
 * by area, but a window's final day can spill past the configured end.
 * @param {Array<object>} records - Parsed CSV records with lat/lon/acqDate.
 * @param {object} event - Normalized event.
 * @returns {Array<object>}
 */
export function filterRecordsToEvent(records, event) {
  if (!Array.isArray(records) || !event) return [];
  const [west, south, east, north] = event.bbox;
  return records.filter((record) => {
    const lat = Number(record?.lat);
    const lon = Number(record?.lon);
    if (lat < south || lat > north || lon < west || lon > east) return false;
    const dayMs = parseUtcDay(record?.acqDate);
    return (
      Number.isFinite(dayMs) && dayMs >= event.startMs && dayMs < event.endMs
    );
  });
}
