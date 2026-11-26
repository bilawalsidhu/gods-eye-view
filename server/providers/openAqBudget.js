import { parseRetryAfter } from './regional/nominatimGate.js';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Requests all views together may make in an hour. */
export const OPENAQ_HOURLY_CALLS = 1800;

/** OpenAQ supplies the seconds until its request window resets. */
function resetTime(raw, now) {
  const value = raw?.trim();
  if (!value || !/^\d+$/.test(value)) return null;
  return Math.min(now + 24 * HOUR, now + Number(value) * 1000);
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
      calls.length >= OPENAQ_HOURLY_CALLS ? calls[0] + HOUR : 0,
      recent.length >= 45 ? recent[0] + MINUTE : 0,
      remaining === 0 ? resetAt : 0,
    );
    return {
      remaining: Math.max(
        0,
        Math.min(
          OPENAQ_HOURLY_CALLS - calls.length,
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
        const delay = parseRetryAfter(
          response.headers.get('retry-after'),
          time,
        );
        blockedUntil = Math.max(
          blockedUntil,
          Math.min(
            time + 24 * HOUR,
            delay ? time + delay : reset || time + MINUTE,
          ),
        );
      }
    },
  };
}
