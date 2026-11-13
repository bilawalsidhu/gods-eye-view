const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** OpenAQ documents reset as seconds; also accept an absolute epoch. */
function resetTime(raw, now) {
  if (!raw?.trim()) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  const at = n > 1e12 ? n : n > 1e9 ? n * 1000 : now + n * 1000;
  return Math.min(now + 24 * HOUR, Math.max(now, at));
}

/** One conservative budget for all views, including provider cooldown headers. */
export function createOpenAqBudget(now = Date.now) {
  let calls = [],
    blockedUntil = 0,
    remaining = null,
    resetAt = 0;
  const state = () => {
    const time = now();
    calls = calls.filter((at) => time - at < HOUR);
    if (time >= resetAt) remaining = null;
    const recent = calls.filter((at) => time - at < MINUTE);
    const retryAt = Math.max(
      blockedUntil,
      calls.length >= 1800 ? calls[0] + HOUR : 0,
      recent.length >= 45 ? recent[0] + MINUTE : 0,
      remaining === 0 ? resetAt : 0,
    );
    return {
      remaining: Math.max(
        0,
        Math.min(
          1800 - calls.length,
          45 - recent.length,
          remaining ?? Infinity,
        ),
      ),
      retryAt: retryAt > time ? retryAt : null,
      nextMinute: recent.length ? recent[0] + MINUTE : time + MINUTE,
    };
  };
  return {
    state,
    take() {
      const { retryAt } = state();
      if (retryAt)
        throw Object.assign(new Error('OpenAQ request budget reached'), {
          status: 429,
          retryAt,
        });
      calls.push(now());
      if (remaining !== null) remaining--;
    },
    observe(response) {
      const time = now();
      const reset = resetTime(response.headers.get('x-ratelimit-reset'), time);
      const rawRemaining = response.headers.get('x-ratelimit-remaining');
      const available = rawRemaining?.trim()
        ? Math.floor(Number(rawRemaining))
        : NaN;
      if (reset && Number.isFinite(available) && available >= 0) {
        remaining =
          Math.abs(reset - resetAt) < 2000 && remaining !== null
            ? Math.min(remaining, available)
            : available;
        resetAt = reset;
      }
      if (response.status === 429) {
        const raw = response.headers.get('retry-after');
        const retry =
          raw && /^\d+(\.\d+)?$/.test(raw.trim())
            ? time + Number(raw) * 1000
            : Date.parse(raw);
        blockedUntil = Math.max(
          blockedUntil,
          Math.min(
            time + 24 * HOUR,
            Number.isFinite(retry) && retry > time
              ? retry
              : reset || time + MINUTE,
          ),
        );
      }
    },
  };
}
