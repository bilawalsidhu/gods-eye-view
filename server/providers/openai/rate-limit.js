import {
  envRateLimiter,
  clientKey,
  retryAfterSeconds,
} from '../common/rate-limit.js';

// Built LAZILY on each request, NOT at module load: `.env` values are applied
// to process.env later (the plugin config hook calls loadEnv → process.env,
// AFTER this module is imported). envRateLimiter memoises per variable, so the
// per-IP window state persists. `null` = unlimited (default).

/** Realtime token (voice). GEV_RATELIMIT_OPENAI_PER_MIN; null = unlimited. */
function openAiTokenRateLimiter() {
  return envRateLimiter('GEV_RATELIMIT_OPENAI_PER_MIN');
}

/**
 * HUD summary. Its OWN bucket, so the HUD's background polling can never
 * spend the voice token's budget. GEV_RATELIMIT_HUD_PER_MIN; when unset it
 * takes GEV_RATELIMIT_OPENAI_PER_MIN's value (still a separate bucket), so
 * an unset environment stays unlimited.
 */
function hudSummaryRateLimiter() {
  return envRateLimiter(
    'GEV_RATELIMIT_HUD_PER_MIN',
    'GEV_RATELIMIT_OPENAI_PER_MIN',
  );
}

/**
 * Apply an opt-in limiter to a request, writing a 429 when over the cap.
 * When `limiter` is null (unlimited, the default) this is a no-op returning
 * `true`, so the handler proceeds exactly as before.
 *
 * @param {((key:string)=>boolean)|null} limiter
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {boolean} True if the request may proceed; false if a 429 was sent.
 */
function enforceOptInRateLimit(limiter, req, res) {
  if (!limiter) return true; // unlimited (default) — no behavior change
  const key = clientKey(req);
  if (limiter(key)) return true;
  res.statusCode = 429;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Retry-After', retryAfterSeconds(limiter, key));
  res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
  return false;
}

export { enforceOptInRateLimit, openAiTokenRateLimiter, hudSummaryRateLimiter };
