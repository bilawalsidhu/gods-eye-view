import { makeCostRateLimiter } from '../common/rate-limit.js';

/**
 * Requests/min/IP applied to the typed agent endpoints when
 * GEV_RATELIMIT_AGENT_PER_MIN is unset.
 *
 * One typed command costs two or more upstream round trips, and a person types
 * a handful of commands a minute, so 60 clears ordinary use several times over
 * and bites only a caller working the endpoint far harder than the console
 * does. Local providers are throttled too: a runaway tool loop against a
 * daemon costs no money but will still saturate a GPU.
 */
const AGENT_DEFAULT_PER_MIN = 60;

// Built LAZILY on first request, NOT at module load: `.env` values reach
// process.env in the plugin's config hook, after this module is imported, so
// reading them here would always see them unset. The result is cached so the
// limiter's per-IP window state persists. `null` is the explicit 0 opt-out.
let _agentRateLimiter;

/**
 * Per-IP limiter for the typed agent endpoints. Null only when set to 0.
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {((key:string)=>boolean)|null}
 */
function agentRateLimiter(env = process.env) {
  if (_agentRateLimiter === undefined) {
    _agentRateLimiter = makeCostRateLimiter(
      env.GEV_RATELIMIT_AGENT_PER_MIN,
      AGENT_DEFAULT_PER_MIN,
    );
  }
  return _agentRateLimiter;
}

export { AGENT_DEFAULT_PER_MIN, agentRateLimiter };
