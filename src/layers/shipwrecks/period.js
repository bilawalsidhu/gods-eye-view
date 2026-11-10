/**
 * The sinking year, or null when it is unknown (ancient wrecks dated only by
 * period, "C1st AD", have none).
 */
export function recordYear(record) {
  return Number.isInteger(record?.year) ? record.year : null;
}

/** First and last year present in the records (null when none is dated). */
export function yearExtent(records) {
  let min = Infinity;
  let max = -Infinity;
  for (const record of records) {
    const year = recordYear(record);
    if (year === null) continue;
    if (year < min) min = year;
    if (year > max) max = year;
  }
  return Number.isFinite(min) ? { min, max } : null;
}

function yearParam(value) {
  if (value === null) return null;
  const year =
    typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
  return Number.isInteger(year) && Math.abs(year) < 10000 ? year : undefined;
}

/**
 * Merge a (partial) period request into the current one. `from: null` means
 * the first year in the data and `to: null` the latest; an invalid year keeps
 * the current one, and a start after the end is stored as the reverse.
 * @param {{from?: number|string|null, to?: number|string|null}} params
 * @param {{from: number|null, to: number|null}} current
 * @returns {{from: number|null, to: number|null}}
 */
export function normalizePeriod(
  params = {},
  current = { from: null, to: null },
) {
  const next = { ...current };
  for (const end of ['from', 'to']) {
    if (!(end in params)) continue;
    const year = yearParam(params[end]);
    if (year !== undefined) next[end] = year;
  }
  // Stored in the order it is shown, so a later edit to one end (the picker
  // sends only that end) changes the end the reader picked, not the other.
  if (Number.isInteger(next.from) && Number.isInteger(next.to))
    if (next.from > next.to) [next.from, next.to] = [next.to, next.from];
  return next;
}

/**
 * The inclusive year range a period covers over the data's extent. Years are
 * clamped to the data, and a start after the end is read as the reverse.
 * @returns {{from: number, to: number, all: boolean}|null}
 */
export function periodRange(period, extent) {
  if (!extent) return null;
  const clamp = (year, fallback) =>
    Math.min(extent.max, Math.max(extent.min, year ?? fallback));
  const start = clamp(period.from, extent.min);
  const end = clamp(period.to, extent.max);
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  return { from, to, all: from === extent.min && to === extent.max };
}

/** Whether a record falls in the range; undated records only when all years show. */
export function inPeriod(record, range) {
  if (!range || range.all) return true;
  const year = recordYear(record);
  return year !== null && year >= range.from && year <= range.to;
}
