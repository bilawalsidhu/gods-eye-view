export function analystRecordLimit(maxCount) {
  return Number.isFinite(maxCount)
    ? Math.max(0, Math.floor(maxCount))
    : Infinity;
}
