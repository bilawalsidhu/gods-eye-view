import { requiredFiniteQueryNumber } from '../common/query.js';
import {
  ALPHA_EARTH_DEFAULT_THRESHOLD,
  ALPHA_EARTH_MAX_BOX_KM,
} from './constants.js';
import { measureBox } from './grid.js';

/** Upstream byte budgets per detail tier, MB (both years together). */
export const ALPHA_EARTH_DETAIL_BUDGET_MB = Object.freeze({
  standard: 64,
  high: 256,
});

const FIRST_YEAR = 2017;
const LAST_PLAUSIBLE_YEAR = 2100;
/** Box edges are snapped to ~10 m so nearby requests share a cache entry. */
const SNAP_DEGREES = 1e-4;

const snap = (value) => Math.round(value / SNAP_DEGREES) * SNAP_DEGREES;
const fixed = (value) => Number(value.toFixed(4));

function year(params, key) {
  const value = requiredFiniteQueryNumber(params, key);
  return Number.isInteger(value) &&
    value >= FIRST_YEAR &&
    value <= LAST_PLAUSIBLE_YEAR
    ? value
    : null;
}

/**
 * Validate `/api/alpha-earth/change` query parameters.
 *
 * @param {URLSearchParams} params
 * @returns {{ok:true, value:object} | {ok:false, error:string}}
 */
export function parseAlphaEarthChangeQuery(params) {
  const box = {
    west: requiredFiniteQueryNumber(params, 'west'),
    south: requiredFiniteQueryNumber(params, 'south'),
    east: requiredFiniteQueryNumber(params, 'east'),
    north: requiredFiniteQueryNumber(params, 'north'),
  };
  if (Object.values(box).some((v) => v === null)) {
    return { ok: false, error: 'west, south, east and north are required' };
  }
  const snapped = {
    west: fixed(snap(box.west)),
    south: fixed(snap(box.south)),
    east: fixed(snap(box.east)),
    north: fixed(snap(box.north)),
  };
  const size = measureBox(snapped);
  if (!size) return { ok: false, error: 'invalid box' };
  const maxMeters = ALPHA_EARTH_MAX_BOX_KM * 1000;
  if (size.widthMeters > maxMeters || size.heightMeters > maxMeters) {
    return {
      ok: false,
      error: `box sides must be at most ${ALPHA_EARTH_MAX_BOX_KM} km`,
    };
  }
  const from = year(params, 'from');
  const to = year(params, 'to');
  if (from === null || to === null) {
    return { ok: false, error: 'from and to must be years from 2017' };
  }
  if (from === to) return { ok: false, error: 'from and to must differ' };

  let threshold = ALPHA_EARTH_DEFAULT_THRESHOLD;
  if (params.get('threshold') !== null) {
    const value = requiredFiniteQueryNumber(params, 'threshold');
    if (value === null || value <= 0 || value > 1) {
      return { ok: false, error: 'threshold must be in (0, 1]' };
    }
    threshold = value;
  }
  const detail = params.get('detail') || 'standard';
  if (!Object.hasOwn(ALPHA_EARTH_DETAIL_BUDGET_MB, detail)) {
    return { ok: false, error: 'detail must be standard or high' };
  }
  return {
    ok: true,
    value: {
      box: snapped,
      from: Math.min(from, to),
      to: Math.max(from, to),
      threshold,
      detail,
      budgetBytes: ALPHA_EARTH_DETAIL_BUDGET_MB[detail] * 1024 * 1024,
    },
  };
}

/** Stable cache key for a parsed query. */
export function alphaEarthChangeKey({ box, from, to, threshold, detail }) {
  return [
    box.west,
    box.south,
    box.east,
    box.north,
    from,
    to,
    threshold,
    detail,
  ].join(',');
}
