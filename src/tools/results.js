/** Result sizing shared by tools that return lists. */

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 200;

/** JSON Schema for the `limit` argument. */
export const LIMIT_SCHEMA = Object.freeze({
  type: 'integer',
  minimum: 1,
  maximum: MAX_LIMIT,
  description: `Most rows to return (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}).`,
});

/** Keep the first `limit` rows and report how many matched in total. */
export function capRows(rows, limit = DEFAULT_LIMIT) {
  const kept = rows.slice(0, Math.min(limit, MAX_LIMIT));
  return {
    total: rows.length,
    returned: kept.length,
    truncated: kept.length < rows.length,
    rows: kept,
  };
}

/** Most groups a breakdown lists before counting the rest as other. */
export const MAX_GROUPS = 10;

/**
 * Count rows by one text field over every row, not just those returned.
 * Values group case-insensitively and keep their first spelling; rows
 * without a value are counted as unknown. `valueOf` derives the value when
 * it is not a row field as it stands.
 */
export function breakdown(rows, field, valueOf = (row) => row[field]) {
  const groups = new Map();
  let unknown = 0;
  for (const row of rows) {
    const raw = valueOf(row);
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) {
      unknown += 1;
      continue;
    }
    const key = value.toLowerCase();
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { value, count: 1 });
  }
  const sorted = [...groups.values()].sort(
    (a, b) => b.count - a.count || a.value.localeCompare(b.value),
  );
  const listed = sorted.slice(0, MAX_GROUPS);
  return {
    field,
    groups: listed,
    other_count: rows.length - unknown - sum(listed.map((g) => g.count)),
    unknown_count: unknown,
  };
}

/** Minimum, median, mean and maximum of one numeric field, or null. */
export function numericSummary(rows, field) {
  const values = rows
    .map((row) => row[field])
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!values.length) return null;
  const middle = values.length >> 1;
  const median =
    values.length % 2
      ? values[middle]
      : (values[middle - 1] + values[middle]) / 2;
  const round1 = (value) => Number(value.toFixed(1));
  return {
    count: values.length,
    min: values[0],
    median: round1(median),
    mean: round1(sum(values) / values.length),
    max: values.at(-1),
  };
}

/**
 * "; most by operator: Delta (12), United (9), American (7); 4 unknown", or
 * "; no operator reported" when no row carries the field.
 */
export function breakdownPhrase(result, label) {
  if (!result.groups.length)
    return result.unknown_count ? `; no ${label} reported` : '';
  const top = result.groups
    .slice(0, 3)
    .map((group) => `${group.value} (${group.count})`);
  const unknown = result.unknown_count
    ? `; ${result.unknown_count} unknown`
    : '';
  return `; most by ${label}: ${top.join(', ')}${unknown}`;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

/** Format an epoch millisecond time as ISO 8601, or null. */
export function isoTime(ms) {
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** "1 earthquake", "3 earthquakes". */
export function countNoun(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Keep the first and last items and evenly spaced items between them. */
export function thinEvenly(items, max) {
  if (items.length <= max) return items;
  const step = (items.length - 1) / (max - 1);
  return Array.from(
    { length: max },
    (_, index) => items[Math.round(index * step)],
  );
}

/** Base64-encode bytes with the platform's btoa, in chunks. */
export function toBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
