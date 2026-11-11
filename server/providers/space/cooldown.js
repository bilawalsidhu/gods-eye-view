/** Bound an upstream Retry-After delay (seconds or HTTP date). */
export function providerCooldownMs(response, now = Date.now()) {
  const raw = response?.headers?.get('retry-after')?.trim();
  const seconds = raw && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN;
  const deadline = raw && !Number.isFinite(seconds) ? Date.parse(raw) : NaN;
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Number.isFinite(deadline)
      ? deadline - now
      : 60000;
  return Math.min(30 * 60000, Math.max(5000, delay));
}
