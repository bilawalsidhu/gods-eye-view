import { makeCostRateLimiter } from '../common/rate-limit.js';

/**
 * Requests/min/IP applied to the typed agent endpoints when
 * GEV_RATELIMIT_AGENT_PER_MIN is unset.
 *
 * Counted per REQUEST, and one typed command is not one request: the browser
 * posts once per tool round, up to the loop's cap of 8, plus a config and a
 * models listing when the console opens. A cap set for commands therefore
 * bites part-way through one, which is worse than refusing it outright - the
 * transcript is left mid-exchange with an assistant turn already recorded.
 * 240 is 8 rounds for each of 30 commands a minute, well past what anyone
 * types, and still refuses a caller scripting the endpoint. What bounds a
 * runaway loop is the round cap, not this.
 */
const AGENT_DEFAULT_PER_MIN = 240;

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
