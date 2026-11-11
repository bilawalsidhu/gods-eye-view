import { makeCostRateLimiter, clientKey } from '../common/rate-limit.js';

/**
 * Requests/min/IP applied when GEV_RATELIMIT_OPENAI_PER_MIN is unset. Both
 * places that already name a value agree on it: `.env.example` recommends 30
 * and the Pinokio build ships 30 (pinokio/_ENVIRONMENT), so the packaged app
 * is unaffected and only an unconfigured server changes. The HUD asks for a
 * summary every 15s (HUD_SUMMARY_INTERVAL_MS), so an open tab spends 4/min and
 * a voice session adds one token mint; the cap clears ordinary use several
 * times over and bites only a caller working the endpoint far harder than the
 * app does.
 */
const OPENAI_DEFAULT_PER_MIN = 30;

// Built LAZILY on first request, NOT at module load: `.env` values are applied to process.env later
// (the plugin config hook calls loadEnv → process.env, AFTER this module is imported), so reading
// process.env here at import time would always see them unset and fall back to the default even when
// configured via .env. Building on first request (like the OPENAI_API_KEY reads) sees the loaded env;
// the result is cached so the limiter's per-IP window state persists. `null` = the explicit 0 opt-out.
let _openAiRateLimiter;

/** OpenAI cost endpoints (realtime/token + hud-summary). Null only when set to 0. */
function openAiRateLimiter() {
  if (_openAiRateLimiter === undefined)
    _openAiRateLimiter = makeCostRateLimiter(
      process.env.GEV_RATELIMIT_OPENAI_PER_MIN,
      OPENAI_DEFAULT_PER_MIN,
    );
  return _openAiRateLimiter;
}

/**
 * Apply the limiter to a request, writing a 429 when over the cap.
 * When `limiter` is null — the explicit `0` opt-out — this is a no-op
 * returning `true`, so the handler proceeds unthrottled.
 *
 * @param {((key:string)=>boolean)|null} limiter
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {boolean} True if the request may proceed; false if a 429 was sent.
 */
function enforceRateLimit(limiter, req, res) {
  if (!limiter) return true; // explicit 0 opt-out — unthrottled
  if (limiter(clientKey(req))) return true;
  res.statusCode = 429;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Retry-After', '5');
  res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
  return false;
}

export { enforceRateLimit, openAiRateLimiter, OPENAI_DEFAULT_PER_MIN };
