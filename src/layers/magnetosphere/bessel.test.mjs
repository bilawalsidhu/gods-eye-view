import test from 'node:test';
import assert from 'node:assert/strict';
import { besselJ0, besselJ1 } from './bessel.js';

/**
 * Reference values from a spectrally-accurate quadrature of
 *   J_n(x) = (1/2pi) * integral over one period of cos(n t - x sin t) dt,
 * which converges geometrically because the integrand is analytic and
 * periodic. Independent of the series/asymptotic pair under test: it shares no
 * coefficients, no crossover and no truncation rule with it.
 *
 * Below x = 1e-3 the quadrature is replaced by the three-term ascending
 * series, because the quadrature holds absolute rather than relative accuracy
 * and builds a result of order x/2 out of terms of order 1. The arguments
 * deliberately cluster at the x = 12 crossover and at the first few zeros of
 * each order, where any mismatch would be worst.
 *
 * @type {ReadonlyArray<readonly [number, number, number]>}
 */
const REFERENCE = Object.freeze([
  [0.0, 1.0, 0.0],
  [1e-06, 0.99999999999975, 4.999999999999375e-07],
  [0.001, 0.9999997500000156, 0.000499999937499912],
  [0.05, 0.9993750976494686, 0.024992188313759656],
  [0.2, 0.9900249722395764, 0.09950083263923595],
  [0.5, 0.9384698072408129, 0.24226845767487387],
  [0.9, 0.8075237981225447, 0.4059495460788056],
  [1.4, 0.5668551203742886, 0.5419477139308545],
  [2.0, 0.22389077914123562, 0.5767248077568734],
  [2.404825557695773, -1.3877787807814457e-16, 0.5191474972894667],
  [2.5, -0.04838377646819804, 0.497094102464274],
  [3.1, -0.29206434765069755, 0.30092113310105756],
  [3.8318060604, -0.40275939368513936, -4.031173887862616e-05],
  [4.2, -0.3765570543675677, -0.13864694212604625],
  [5.0, -0.17759677131433832, -0.3275791375914653],
  [5.5201, 7.448284425611712e-06, -0.3402634571717276],
  [6.3, 0.22381200613219102, -0.20808694020724236],
  [7.0, 0.3000792705195556, -0.004682823482345874],
  [7.0155866698, 0.30011575252613254, -4.687411916948214e-12],
  [8.4, 0.06915726165698513, 0.2707862682768354],
  [9.3, -0.15765518994340316, 0.20041392784370218],
  [10.0, -0.2459357644513484, 0.04347274616886142],
  [11.0, -0.17119030040719613, -0.17678529895672154],
  [11.7915344391, 1.9925904676254547e-11, -0.232459831363035],
  [11.95, 0.03643859701301826, -0.2264904588470348],
  [11.999, 0.04746583057345663, -0.22351330619483206],
  [12.0, 0.047689310796833514, -0.22344710449062766],
  [12.001, 0.047912724710314464, -0.22338068641687708],
  [12.05, 0.05877429313244205, -0.21986293310666807],
  [13.3237, 0.21835940724077374, 1.7607811137118623e-06],
  [14.0, 0.17107347611045864, 0.13337515469879319],
  [14.9309177086, -2.317726566225531e-11, 0.20654643307644366],
  [16.0, -0.17489907398362922, 0.09039717566130412],
  [17.6, -0.08632791549800783, -0.17194274211763233],
  [18.0711, 6.764254208660447e-06, -0.18772842860483852],
  [19.6, 0.18004072743245714, -0.0028565724034052328],
  [21.2116, 6.3467142637262455e-06, 0.1732661933223277],
  [22.9, -0.16555416503869513, -0.02324426371585],
  [24.3525, 4.603519293020636e-06, -0.16170136158678466],
  [26.0, 0.15599931552242108, 0.015045730586915768],
  [28.0, -0.07315701054899963, 0.13055148833509375],
  [30.0, -0.08636798358104023, -0.11875106261662297],
  [33.7758, 2.775262696978753e-06, 0.13729702554762296],
  [37.0, 0.010862369724899686, -0.13058003873375645],
  [40.0, 0.007366890584237286, 0.12603831803758495],
  [45.0, 0.1158186706732563, 0.028348854376424537],
  [50.0, 0.05581232766925176, -0.09751182812517521],
  [55.0, -0.07454830264823689, -0.07825003830868472],
  [60.0, -0.09147180408906194, 0.04659838375816633]
]);

test('agrees with an independent quadrature across the range T96 uses', () => {
  let worst = 0;
  let worstAt = 0;
  for (const [x, j0, j1] of REFERENCE) {
    for (const [mine, reference] of [
      [besselJ0(x), j0],
      [besselJ1(x), j1],
    ]) {
      const error = Math.abs(mine - reference);
      if (error > worst) {
        worst = error;
        worstAt = x;
      }
    }
  }
  // Measured worst case over a 6001-point sweep of 0 to 60 is 8.6e-13, which
  // lands exactly at the crossover. Anything an order of magnitude above that
  // means the series, the asymptotic expansion or the handoff has moved.
  assert.ok(
    worst < 1e-11,
    `worst absolute error ${worst.toExponential(3)} at x = ${worstAt}`,
  );
});

test('reproduces the published values at the origin and the first zeros', () => {
  // Spot values that do not come from the quadrature at all, so a systematic
  // error in the reference cannot hide here.
  assert.equal(besselJ0(0), 1);
  assert.equal(besselJ1(0), 0);
  assert.ok(Math.abs(besselJ0(1) - 0.7651976865579666) < 1e-14);
  assert.ok(Math.abs(besselJ1(1) - 0.4400505857449335) < 1e-14);
  assert.ok(Math.abs(besselJ0(10) - -0.2459357644513483) < 1e-13);
  assert.ok(Math.abs(besselJ1(10) - 0.04347274616886144) < 1e-13);
  // First zero of each order.
  assert.ok(Math.abs(besselJ0(2.404825557695773)) < 1e-15);
  assert.ok(Math.abs(besselJ1(3.831705970207512)) < 1e-15);
});

test('carries the right parity', () => {
  // J0 is even and J1 odd. cylharm and cylhar1 only ever pass a radius, so
  // negative arguments do not arise in T96 - but getting the parity wrong
  // would be a silent trap for any later caller.
  for (const x of [0.3, 2.2, 7.5, 13.4, 25]) {
    assert.equal(besselJ0(-x), besselJ0(x));
    assert.equal(besselJ1(-x), -besselJ1(x));
  }
});

test('stays finite and bounded well past the range T96 needs', () => {
  // The asymptotic expansion is divergent, and the term loop stops at the
  // floor rather than a fixed count. If that guard were wrong, large arguments
  // would return nonsense rather than failing loudly.
  for (const x of [60, 100, 250, 1000, 1e6]) {
    for (const value of [besselJ0(x), besselJ1(x)]) {
      assert.ok(Number.isFinite(value), `not finite at x = ${x}`);
      // |J_n(x)| <= sqrt(2 / (pi x)) for x in this range.
      assert.ok(
        Math.abs(value) < Math.sqrt(2 / (Math.PI * x)) * 1.01,
        `too large at x = ${x}: ${value}`,
      );
    }
  }
});

test('the two branches join smoothly at the crossover', () => {
  // Both expansions are valid near x = 12, so the handoff must not introduce a
  // step. Comparing the one-sided values directly would only measure the
  // derivative, so instead the measured step is checked against the derivative
  // the recurrences require: J0' = -J1 and J1' = J0 - J1/x. That ties the
  // series side and the asymptotic side together through an identity neither of
  // them was built from.
  const h = 1e-6;
  const x = 12;

  const stepJ0 = besselJ0(x) - besselJ0(x - h);
  const expectedJ0 = -besselJ1(x) * h;
  assert.ok(
    Math.abs(stepJ0 - expectedJ0) < 1e-11,
    `J0 step ${stepJ0} but J0' = -J1 predicts ${expectedJ0}`,
  );

  const stepJ1 = besselJ1(x) - besselJ1(x - h);
  const expectedJ1 = (besselJ0(x) - besselJ1(x) / x) * h;
  assert.ok(
    Math.abs(stepJ1 - expectedJ1) < 1e-11,
    `J1 step ${stepJ1} but J1' = J0 - J1/x predicts ${expectedJ1}`,
  );
});

test('the two orders agree with each other through J0 prime = -J1', () => {
  // A central difference of J0 must reproduce -J1. Unlike rearranging the
  // Bessel equation - which collapses to an identity that holds for any two
  // numbers - this compares values the implementation actually computed at
  // three different arguments, so a drift in either order shows up. Sampled on
  // both sides of the crossover.
  const h = 1e-4;
  for (const x of [1.7, 5.3, 9.1, 11.6, 13.8, 18.4, 31.2]) {
    const derivative = (besselJ0(x + h) - besselJ0(x - h)) / (2 * h);
    const error = Math.abs(derivative + besselJ1(x));
    // Truncation of the central difference dominates at h^2 / 6 times the third
    // derivative, so about 2e-9 here; anything near 1e-6 is a real defect.
    assert.ok(
      error < 1e-8,
      `J0 prime is ${derivative} but -J1 is ${-besselJ1(x)} at x = ${x}`,
    );
  }
});
