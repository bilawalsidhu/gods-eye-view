/**
 * ParkAPI v3 parking-site decoding (MobiData BW). Pure: no requests, no
 * Cesium, no i18n, so the portable source export stays small.
 */

/** Restriction kinds whose space counts the card names. */
const COUNTED_RESTRICTIONS = Object.freeze({
  DISABLED: 'disabled',
  CHARGING: 'charging',
});

/** A finite number from a JSON number or a numeric string, else null. */
function finite(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** A non-negative whole count, else null. */
function count(value) {
  const number = finite(value);
  return number !== null && number >= 0 && Number.isInteger(number)
    ? number
    : null;
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** An http(s) link as published, else null: the card never opens anything else. */
function webLink(value) {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function epoch(value) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : null;
}

/**
 * Map one ParkAPI v3 `ParkingSite` to a display record, or null when it has
 * no id or no usable position. Latitude and longitude arrive as JSON numbers
 * or as decimal strings; both are accepted.
 *
 * A free count is live only when ParkAPI itself says so: with its default
 * `calculate_has_realtime_data`, a site whose realtime reading is older than
 * 30 minutes (pull sources) or 24 hours (push sources) comes back with
 * `has_realtime_data: false` but keeps the old fields, and the record then
 * carries no free count at all.
 * @param {object} item ParkAPI parking site.
 * @returns {{id: string, siteId: number, sourceId: number|null,
 *   name: string|null, operator: string|null, address: string|null,
 *   type: string|null, latitude: number, longitude: number,
 *   capacity: number|null, free: number|null, liveCapacity: number|null,
 *   updatedAt: number|null, disabled: number|null, charging: number|null,
 *   url: string|null}|null} Record.
 */
export function normalizeParkingSite(item) {
  if (!item || typeof item !== 'object') return null;
  const siteId = count(item.id);
  const latitude = finite(item.lat);
  const longitude = finite(item.lon);
  if (
    siteId === null ||
    latitude === null ||
    longitude === null ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  )
    return null;
  const live = item.has_realtime_data === true;
  const free = live ? count(item.realtime_free_capacity) : null;
  const restricted = { disabled: null, charging: null };
  for (const restriction of Array.isArray(item.restrictions)
    ? item.restrictions
    : []) {
    const key = COUNTED_RESTRICTIONS[restriction?.type];
    const spaces = count(restriction?.capacity);
    if (key && spaces !== null)
      restricted[key] = (restricted[key] ?? 0) + spaces;
  }
  return {
    id: `parking:${siteId}`,
    siteId,
    sourceId: count(item.source_id),
    name: text(item.name),
    operator: text(item.operator_name),
    address: text(item.address),
    type: text(item.type),
    latitude,
    longitude,
    capacity: count(item.capacity),
    free,
    // The live total can differ from the static one (closed levels, reserved
    // contract spaces); occupancy is read against it when it is published.
    liveCapacity: free === null ? null : count(item.realtime_capacity),
    updatedAt: free === null ? null : epoch(item.realtime_data_updated_at),
    disabled: restricted.disabled,
    charging: restricted.charging,
    url: webLink(item.public_url),
  };
}

/**
 * Decode one `/v3/parking-sites` page.
 * @param {object} payload Response body.
 * @returns {{records: Array<object>, total: number, returned: number}|null}
 *   Null when the body is not a ParkAPI page. `total` is what the query
 *   matched, `returned` the rows this page carried.
 */
export function normalizeParkingPage(payload) {
  if (!Array.isArray(payload?.items)) return null;
  const total = count(payload.total_count);
  if (total === null) return null;
  const records = [
    ...new Map(
      payload.items
        .map(normalizeParkingSite)
        .filter(Boolean)
        .map((record) => [record.id, record]),
    ).values(),
  ];
  return { records, total, returned: payload.items.length };
}

/**
 * Decode `/v3/sources` into the contributor each source asks to be named,
 * by source id. Most sources publish none.
 * @param {object} payload Response body.
 * @returns {Map<number, string>} Contributors.
 */
export function normalizeParkingContributors(payload) {
  const contributors = new Map();
  for (const source of Array.isArray(payload?.items) ? payload.items : []) {
    const id = count(source?.id);
    const name = text(source?.attribution_contributor);
    if (id !== null && name) contributors.set(id, name);
  }
  return contributors;
}

/**
 * The share of spaces free, 0 to 1, for a site with a live count; null for a
 * static site or one without a usable total.
 * @param {{free: number|null, liveCapacity: number|null,
 *   capacity: number|null}} record Record.
 * @returns {number|null} Free share.
 */
export function freeShare(record) {
  if (record?.free === null || record?.free === undefined) return null;
  const total = record.liveCapacity || record.capacity;
  if (!total) return null;
  return Math.min(1, Math.max(0, record.free / total));
}

/** Free-share bands, most room first. */
export const OCCUPANCY_BANDS = Object.freeze([
  Object.freeze({ id: 'free', min: 0.3 }),
  Object.freeze({ id: 'filling', min: 0.1 }),
  Object.freeze({ id: 'full', min: 0 }),
]);

/**
 * The occupancy band of a record: `free`, `filling`, `full`, or `static`
 * when it carries no live count to judge by.
 * @param {object} record Record.
 * @returns {'free'|'filling'|'full'|'static'} Band.
 */
export function occupancyBand(record) {
  const share = freeShare(record);
  if (share === null) return 'static';
  return OCCUPANCY_BANDS.find((band) => share >= band.min).id;
}
