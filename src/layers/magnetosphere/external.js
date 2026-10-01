/**
 * Choosing which external field model to trace with.
 *
 * Two are available, and which one is usable depends entirely on what the feed
 * actually delivered:
 *
 * - T96 wants solar wind dynamic pressure, Dst, and the IMF By and Bz. Given
 *   all four it is the better model: it has an explicit magnetopause and an
 *   interconnection field, so southward IMF erodes the dayside the way it really
 *   does.
 * - T89 wants only Kp. Coarser - seven discrete disturbance bands, no boundary,
 *   no IMF - but it needs one number, so it still works when the IMF or Dst
 *   feed is down.
 *
 * When neither is available the caller gets null and traces the internal field
 * alone, which is honest but visibly wrong past a few Earth radii. Falling back
 * to a guessed storm state would be worse: a magnetosphere modelled as calm
 * during a storm looks entirely plausible and is entirely false.
 *
 * @module layers/magnetosphere/external
 */

import { t89, t89BandForKp } from './t89.js';
import { t96 } from './t96.js';

/**
 * Bounds T96 was fitted within, from the published parameter ranges.
 *
 * Outside these the model is extrapolating, which for an empirical fit of this
 * kind means the field can leave the physical regime altogether rather than
 * merely losing accuracy. The selection clamps to the edges and reports that it
 * did, rather than either refusing to draw or pretending the fit still holds.
 */
export const T96_FITTED_RANGE = Object.freeze({
  pdyn: Object.freeze({ min: 0.5, max: 10 }),
  dst: Object.freeze({ min: -100, max: 20 }),
  byimf: Object.freeze({ min: -10, max: 10 }),
  bzimf: Object.freeze({ min: -10, max: 10 }),
});

const clamp = (value, { min, max }) => Math.min(max, Math.max(min, value));

/**
 * Pick the best external field model the given state supports.
 *
 * @param {?object} state Validated magnetosphere state, or null.
 * @returns {?{name: string, label: string, evaluate: Function, parameters: *,
 *   extrapolated: boolean, key: string}} The chosen model, or null if the state
 *   supports neither.
 */
export function selectExternalModel(state) {
  if (!state || state.unavailable) return null;

  const pdyn = state.dynamicPressureNPa;
  const { dst, byNT, bzNT } = state;
  if (
    Number.isFinite(pdyn) &&
    pdyn > 0 &&
    Number.isFinite(dst) &&
    Number.isFinite(byNT) &&
    Number.isFinite(bzNT)
  ) {
    const raw = { pdyn, dst, byimf: byNT, bzimf: bzNT };
    const parameters = {
      pdyn: clamp(pdyn, T96_FITTED_RANGE.pdyn),
      dst: clamp(dst, T96_FITTED_RANGE.dst),
      byimf: clamp(byNT, T96_FITTED_RANGE.byimf),
      bzimf: clamp(bzNT, T96_FITTED_RANGE.bzimf),
    };
    const extrapolated = Object.keys(parameters).some(
      (field) => parameters[field] !== raw[field],
    );
    return {
      name: 't96',
      label: 'Tsyganenko T96',
      evaluate: t96,
      parameters,
      extrapolated,
      // Rounded, because the filaments only need re-tracing when the field
      // changes enough to move a line visibly, not on every feed tick.
      key: [
        't96',
        parameters.pdyn.toFixed(1),
        parameters.dst.toFixed(0),
        parameters.byimf.toFixed(0),
        parameters.bzimf.toFixed(0),
      ].join(':'),
    };
  }

  if (Number.isFinite(state.kp)) {
    const band = t89BandForKp(state.kp);
    return {
      name: 't89',
      label: 'Tsyganenko T89c',
      evaluate: t89,
      parameters: band,
      extrapolated: false,
      key: `t89:${band}`,
    };
  }

  return null;
}
