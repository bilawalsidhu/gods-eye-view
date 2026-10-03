import { FILTER_DEFAULT, MAX_SINCE_DAYS, PANO_MODES } from './policy.js';

const DAY_MS = 86_400_000;

/**
 * Merge a partial filter change into the current one. Unknown panorama modes
 * and negative or non-integer day counts leave the current value alone.
 * @param {{pano?: string, sinceDays?: number}|null} next
 * @param {{pano: string, sinceDays: number}} [current]
 * @returns {{pano: string, sinceDays: number}}
 */
export function normalizeFilter(next, current = FILTER_DEFAULT) {
  const pano = PANO_MODES.includes(next?.pano) ? next.pano : current.pano;
  let sinceDays = current.sinceDays;
  if (next && 'sinceDays' in next) {
    const days = Number(next.sinceDays);
    if (Number.isInteger(days) && days >= 0)
      sinceDays = Math.min(days, MAX_SINCE_DAYS);
  }
  return { pano, sinceDays };
}

/** True when two filters would show the same imagery. */
export function sameFilter(a, b) {
  return a?.pano === b?.pano && a?.sinceDays === b?.sinceDays;
}

/**
 * Turn the stored filter (relative days, stable in share links) into the
 * absolute form providers compare capture times against.
 * @returns {{pano: string, sinceMs: number|null}}
 */
export function resolveFilter(filter, now = Date.now()) {
  const days = Number(filter?.sinceDays) || 0;
  return {
    pano: PANO_MODES.includes(filter?.pano) ? filter.pano : 'all',
    sinceMs: days > 0 ? now - days * DAY_MS : null,
  };
}

/**
 * Whether one capture passes the resolved imagery filter: panorama mode
 * ('all' | 'pano' | 'flat') and an optional earliest capture time.
 * @param {{isPano?: boolean, capturedAt?: number}} record
 * @param {{pano: string, sinceMs: number|null}|null} filter
 */
export function passesImageryFilter(record, filter) {
  if (!filter) return true;
  if (filter.pano === 'pano' && !record.isPano) return false;
  if (filter.pano === 'flat' && record.isPano) return false;
  if (
    Number.isFinite(filter.sinceMs) &&
    filter.sinceMs > 0 &&
    (record.capturedAt || 0) < filter.sinceMs
  )
    return false;
  return true;
}
