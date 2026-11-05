/** Period lengths offered under the row; "today" runs to the newest record. */
export const PERIOD_SPANS = Object.freeze(['today', 1, 5, 10]);

/** The record's year, or null when it has no usable date. */
export function recordYear(record) {
  const match = /^(-?\d{4})-/.exec(record?.date || '');
  return match ? Number(match[1]) : null;
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

/**
 * Merge a (partial) period request into the current one. `from: null` means
 * the first year in the data; an unknown span or year keeps the current one.
 * @param {{from?: number|null, span?: string|number}} params
 * @param {{from: number|null, span: string|number}} current
 * @returns {{from: number|null, span: string|number}}
 */
export function normalizePeriod(
  params = {},
  current = { from: null, span: 'today' },
) {
  const next = { ...current };
  if (params.from === null) next.from = null;
  else if (Number.isInteger(params.from) && Math.abs(params.from) < 10000)
    next.from = params.from;
  const span = /^\d+$/.test(String(params.span ?? ''))
    ? Number(params.span)
    : params.span;
  if (PERIOD_SPANS.includes(span)) next.span = span;
  return next;
}

/**
 * The inclusive year range a period covers over the data's extent.
 * @returns {{from: number, to: number, all: boolean}|null}
 */
export function periodRange(period, extent) {
  if (!extent) return null;
  const from = Math.min(
    extent.max,
    Math.max(extent.min, period.from ?? extent.min),
  );
  const to =
    period.span === 'today'
      ? extent.max
      : Math.min(extent.max, from + period.span - 1);
  return { from, to, all: from === extent.min && to === extent.max };
}

/** Whether a record falls in the range; undated records only when all years show. */
export function inPeriod(record, range) {
  if (!range || range.all) return true;
  const year = recordYear(record);
  return year !== null && year >= range.from && year <= range.to;
}
