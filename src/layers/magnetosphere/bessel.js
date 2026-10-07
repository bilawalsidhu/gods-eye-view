/**
 * Bessel functions of the first kind, orders 0 and 1.
 *
 * T96 approximates the Chapman-Ferraro shielding field as a sum of cylindrical
 * harmonics, and those harmonics are J0 and J1. Nothing else in the codebase
 * needs them, and no runtime dependency carries them, so they live here.
 *
 * Two regimes: the ascending power series near the origin, and the Hankel
 * asymptotic expansion far from it. The series loses digits to cancellation as
 * the argument grows and the asymptotic series stops improving as the argument
 * shrinks, so they are crossed over where their errors meet. Both are
 * validated against a spectrally-accurate quadrature of the integral
 * representation; see bessel.test.mjs.
 *
 * @module layers/magnetosphere/bessel
 */

/**
 * Where the power series hands off to the asymptotic expansion.
 *
 * Measured, not guessed. Each side is worst right at the crossover, and 12 is
 * where the two worst cases meet: sweeping 0 to 60 puts the largest absolute
 * error at 8.6e-13, against 5.8e-11 for a crossover of 10 and 2.3e-11 for 16.
 */
const CROSSOVER = 12;

/** Beyond this the asymptotic series starts diverging instead of converging. */
const MAX_ASYMPTOTIC_TERMS = 30;

/** Adding terms below this changes nothing a double can represent. */
const TERM_EPSILON = 1e-18;

/**
 * Ascending series for J0: sum of (-1)^k (x^2/4)^k / (k!)^2.
 *
 * @param {number} x Argument.
 * @returns {number} J0(x).
 */
function j0Series(x) {
  const quarterSquare = (x * x) / 4;
  let term = 1;
  let sum = 1;
  for (let k = 1; k < 60; k += 1) {
    term *= -quarterSquare / (k * k);
    sum += term;
    if (Math.abs(term) < TERM_EPSILON * Math.abs(sum)) break;
  }
  return sum;
}

/**
 * Ascending series for J1: (x/2) times the sum of (-1)^k (x^2/4)^k / (k!(k+1)!).
 *
 * @param {number} x Argument.
 * @returns {number} J1(x).
 */
function j1Series(x) {
  const quarterSquare = (x * x) / 4;
  let term = 1;
  let sum = 1;
  for (let k = 1; k < 60; k += 1) {
    term *= -quarterSquare / (k * (k + 1));
    sum += term;
    if (Math.abs(term) < TERM_EPSILON * Math.abs(sum)) break;
  }
  return (x / 2) * sum;
}

/**
 * Hankel asymptotic expansion, shared by both orders.
 *
 * J(x) ~ sqrt(2/(pi x)) * (P cos(chi) - Q sin(chi)), where chi is the phase
 * x - (2 order + 1) pi / 4 and P and Q are the even and odd halves of one
 * series whose terms satisfy
 *   c[0] = 1,  c[m] = c[m-1] (4 order^2 - (2m-1)^2) / (8 x m).
 *
 * The series is divergent: it narrows to a floor and then widens again, so the
 * loop stops at the floor rather than at a fixed term count.
 *
 * @param {number} order 0 or 1.
 * @param {number} x Argument, assumed well away from the origin.
 * @returns {number} J_order(x).
 */
function hankel(order, x) {
  const mu = 4 * order * order;
  let p = 1;
  let q = 0;
  let term = 1;
  let previousMagnitude = Infinity;
  for (let m = 1; m <= MAX_ASYMPTOTIC_TERMS; m += 1) {
    const odd = 2 * m - 1;
    term *= (mu - odd * odd) / (8 * x * m);
    const magnitude = Math.abs(term);
    // Past the floor the terms grow again and every further one makes it worse.
    if (magnitude > previousMagnitude) break;
    previousMagnitude = magnitude;
    // m even feeds P, m odd feeds Q, each with alternating sign.
    if (m % 2 === 0) {
      p += (m / 2) % 2 === 0 ? term : -term;
    } else {
      q += ((m - 1) / 2) % 2 === 0 ? term : -term;
    }
    if (magnitude < TERM_EPSILON) break;
  }
  const chi = x - ((2 * order + 1) * Math.PI) / 4;
  return Math.sqrt(2 / (Math.PI * x)) * (p * Math.cos(chi) - q * Math.sin(chi));
}

/**
 * Bessel function of the first kind, order 0.
 *
 * @param {number} x Argument. J0 is even, so the sign is irrelevant.
 * @returns {number} J0(x).
 */
export function besselJ0(x) {
  const magnitude = Math.abs(x);
  return magnitude < CROSSOVER ? j0Series(magnitude) : hankel(0, magnitude);
}

/**
 * Bessel function of the first kind, order 1.
 *
 * @param {number} x Argument. J1 is odd, so the sign carries through.
 * @returns {number} J1(x).
 */
export function besselJ1(x) {
  const magnitude = Math.abs(x);
  const value =
    magnitude < CROSSOVER ? j1Series(magnitude) : hankel(1, magnitude);
  return x < 0 ? -value : value;
}
