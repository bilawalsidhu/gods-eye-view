import { readResponseJsonCapped } from '../../sources/httpBody.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

function retryDelay(raw, nowMs) {
  if (!raw) return null;
  const seconds = Number(raw);
  const ms = seconds * 1000;
  if (Number.isFinite(ms) && seconds > 0)
    return Math.min(3600000, Math.max(5000, ms));
  const at = Date.parse(raw);
  return Number.isFinite(at) && at > nowMs
    ? Math.min(3600000, Math.max(5000, at - nowMs))
    : null;
}

/** Request integrity facts around a view anchor through the same-origin adsb.lol proxy. */
export function createAdsbGnssSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  return {
    async getSnapshot({ latitude, longitude } = {}, { signal } = {}) {
      signal?.throwIfAborted();
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude))
        throw new Error(msg('GNSS snapshot needs a view anchor'));
      const params = new URLSearchParams({
        lat: String(Math.round(latitude)),
        lon: String(Math.round(longitude)),
      });
      const response = await fetchImpl(`/api/gnss-integrity?${params}`, {
        signal,
      });
      if (!response.ok) {
        const limited = response.status === 429;
        const retryAfterMs = retryDelay(
          response.headers.get('retry-after'),
          now(),
        );
        throw Object.assign(
          new Error(
            // HTTP errors are matched by FEED_ERROR_PATTERNS in ui/statusText.js.
            limited
              ? msg('GNSS feed rate limited (HTTP 429)')
              : `GNSS feed unavailable (HTTP ${response.status})`,
          ),
          {
            status: response.status,
            retryable: limited || response.status >= 500,
            retryAfterMs: retryAfterMs ?? (limited ? 60000 : null),
          },
        );
      }
      const payload = await readResponseJsonCapped(
        response,
        4 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      if (!Array.isArray(payload?.rows))
        throw new Error(msg('Malformed GNSS integrity snapshot'));
      // The snapshot's age (measured on the proxy's clock) dates every row in
      // the rolling window; an undated snapshot could only be treated as new,
      // so it is refused.
      if (!Number.isFinite(payload.ageMs) || payload.ageMs < 0)
        throw new Error(msg('GNSS integrity snapshot has no observation time'));
      return {
        rows: payload.rows,
        ageMs: payload.ageMs,
        fetchedAt: Number.isFinite(payload.fetchedAt)
          ? payload.fetchedAt
          : null,
        stale: payload.stale === true,
        classifier:
          typeof payload.classifier === 'string' ? payload.classifier : null,
      };
    },
  };
}
