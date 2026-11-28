/**
 * How many analyst records a query may return: `maxCount` floored and at
 * least `min`, or `fallback` when it is not a finite number.
 */
export function analystRecordLimit(
  maxCount,
  { fallback = Infinity, min = 0 } = {},
) {
  return Number.isFinite(maxCount)
    ? Math.max(min, Math.floor(maxCount))
    : fallback;
}
