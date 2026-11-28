/**
 * Parse an HTTP `Retry-After` header into milliseconds.
 * Accepts delta-seconds or an HTTP-date. Returns 0 when absent/unparseable.
 * @param {string|number|undefined|null} raw
 * @param {number} [nowMs] Wall-clock reference for the HTTP-date form.
 * @returns {number}
 */
export function parseRetryAfterMs(raw, nowMs = Date.now()) {
  if (raw === null || raw === undefined) return 0;
  const text = String(raw).trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const date = Date.parse(text);
  if (Number.isFinite(date)) return Math.max(0, date - nowMs);
  return 0;
}

/**
 * Seconds a Retry-After header asks to wait — delay seconds, or an HTTP date
 * against `nowMs` (negative once past) — rounded up; null when absent or
 * malformed. A numeric-looking text is never read as a date.
 */
export function parseRetryAfterSeconds(value, nowMs) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) ? Math.ceil(seconds) : null;
  }
  // HTTP dates include a named weekday or month.
  if (!/[a-z]/i.test(text)) return null;
  const deadline = Date.parse(text);
  return Number.isFinite(deadline) && Number.isFinite(nowMs)
    ? Math.ceil((deadline - nowMs) / 1000)
    : null;
}
