/**
 * @module render/conformance/expect
 * @description Assertions for the conformance suite. Plain functions that
 * throw, so the suite runs in Node and in a browser page alike.
 */

export class ConformanceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConformanceError';
  }
}

export function ok(value, message) {
  if (!value) throw new ConformanceError(message);
}

export function equal(actual, expected, message) {
  if (!Object.is(actual, expected))
    throw new ConformanceError(
      `${message}: expected ${show(expected)}, got ${show(actual)}`,
    );
}

export function deepEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new ConformanceError(
      `${message}: expected ${show(expected)}, got ${show(actual)}`,
    );
}

export function near(actual, expected, tolerance, message) {
  if (
    !(Number.isFinite(actual) && Number.isFinite(expected)) ||
    Math.abs(actual - expected) > tolerance
  )
    throw new ConformanceError(
      `${message}: expected ${expected} ± ${tolerance}, got ${actual}`,
    );
}

/** Angles in radians, compared around the circle. */
export function nearAngle(actual, expected, tolerance, message) {
  const tau = Math.PI * 2;
  let d = Math.abs(actual - expected) % tau;
  if (d > Math.PI) d = tau - d;
  if (!(d <= tolerance))
    throw new ConformanceError(
      `${message}: expected ${expected} ± ${tolerance} rad, got ${actual}`,
    );
}

export function nearVec(actual, expected, tolerance, message) {
  if (actual === null || expected === null) {
    equal(actual, expected, message);
    return;
  }
  const d = Math.hypot(
    actual.x - expected.x,
    actual.y - expected.y,
    (actual.z ?? 0) - (expected.z ?? 0),
  );
  if (!(d <= tolerance))
    throw new ConformanceError(
      `${message}: ${show(actual)} is ${d} from ${show(expected)} (± ${tolerance})`,
    );
}

export async function rejects(promiseOrFn, message) {
  try {
    await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
  } catch {
    return;
  }
  throw new ConformanceError(`${message}: did not throw`);
}

export function throws(fn, message) {
  try {
    fn();
  } catch {
    return;
  }
  throw new ConformanceError(`${message}: did not throw`);
}

function show(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
