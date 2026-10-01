import { envRateLimiter } from './rate-limit.js';

/**
 * The ONE per-IP Google budget (GEV_RATELIMIT_GOOGLE_PER_MIN) that every
 * route spending the server's Google key draws from: Places nearby/text
 * search and the CCTV Street View fallback. Null = unlimited (default).
 *
 * @returns {((key:string)=>boolean)|null}
 */
export function googleRateLimiter() {
  return envRateLimiter('GEV_RATELIMIT_GOOGLE_PER_MIN');
}
