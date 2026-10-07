/**
 * Field-line tracing.
 *
 * Integrates along the field direction with RK4. Step size is in kilometres of
 * arc, not in time: a field line has no time along it, and treating the unit
 * field vector as a velocity is the whole trick.
 *
 * Everything here is in kilometres and geocentric Earth-fixed Cartesian, the
 * same frame `field.js` returns. The renderer converts.
 *
 * @module layers/magnetosphere/trace
 */
import { fieldCartesian } from './field.js';

/** Mean Earth radius in km, for the surface the tracer terminates on. */
export const EARTH_RADIUS_KM = 6371.0;

/** Why a trace stopped. Callers show this; it is not an error channel. */
export const TRACE_END = Object.freeze({
  closed: 'closed', // returned to the surface — a closed field line
  escaped: 'escaped', // left the modelled volume — open, or beyond IGRF's reach
  exhausted: 'exhausted', // hit the step budget without resolving
  degenerate: 'degenerate', // field vanished; a null point, or a bad model
});

/**
 * Unit field direction, internal plus whatever external field is supplied.
 *
 * `externalField` returns Earth-fixed nT for a position in km, or null. It is
 * a parameter rather than an import because the internal field alone is a
 * complete, useful answer — the tracer must not require a magnetospheric
 * model to run, and the tests must be able to isolate one from the other.
 */
function unitField(coefficients, position, externalField) {
  const internal = fieldCartesian(coefficients, position);
  let bx = internal.x;
  let by = internal.y;
  let bz = internal.z;
  if (externalField) {
    const external = externalField(position);
    if (external) {
      bx += external.x;
      by += external.y;
      bz += external.z;
    }
  }
  const magnitude = Math.hypot(bx, by, bz);
  if (!(magnitude > 0)) return null;
  return { x: bx / magnitude, y: by / magnitude, z: bz / magnitude };
}

/**
 * Trace one field line.
 *
 * @param {object} coefficients From `coefficientsFor`.
 * @param {{x:number,y:number,z:number}} start Geocentric km.
 * @param {object} [options]
 * @param {number} [options.direction=1] +1 traces along B, -1 against it.
 * @param {number} [options.stepKm=80] Arc length per step at the surface.
 * @param {number} [options.maxStepScale=12] Cap on how far the step may grow.
 * @param {number} [options.maxRadiusKm] Stop beyond this geocentric radius.
 * @param {number} [options.maxSteps=4000] Budget.
 * @param {(p:object)=>object|null} [options.externalField] Magnetospheric
 *   field in Earth-fixed nT, added to the internal field at every stage.
 * @returns {{points:Array<{x,y,z}>, end:string}}
 */
export function traceFieldLine(coefficients, start, options = {}) {
  const {
    direction = 1,
    stepKm = 80,
    maxRadiusKm = 20 * EARTH_RADIUS_KM,
    maxSteps = 4000,
    maxStepScale = 12,
    externalField = null,
  } = options;
  const sign = Math.sign(direction || 1);
  // The field varies fastest where it is strongest. Scaling the step with
  // radius keeps the near-Earth geometry accurate while refusing to crawl
  // through the smooth outer field one surface-sized step at a time — a long
  // high-latitude line costs several times less for the same shape.
  const stepFor = (radius) =>
    stepKm *
    Math.min(maxStepScale, Math.max(1, radius / EARTH_RADIUS_KM)) *
    sign;
  const points = [{ ...start }];
  let current = { ...start };

  for (let step = 0; step < maxSteps; step++) {
    const h = stepFor(Math.hypot(current.x, current.y, current.z));
    // Classic RK4 on dr/ds = B_hat(r). Each stage is a full field evaluation,
    // which is what makes tracing expensive and why this runs server-side.
    const k1 = unitField(coefficients, current, externalField);
    if (!k1) return { points, end: TRACE_END.degenerate };
    const p2 = {
      x: current.x + (h / 2) * k1.x,
      y: current.y + (h / 2) * k1.y,
      z: current.z + (h / 2) * k1.z,
    };
    const k2 = unitField(coefficients, p2, externalField);
    if (!k2) return { points, end: TRACE_END.degenerate };
    const p3 = {
      x: current.x + (h / 2) * k2.x,
      y: current.y + (h / 2) * k2.y,
      z: current.z + (h / 2) * k2.z,
    };
    const k3 = unitField(coefficients, p3, externalField);
    if (!k3) return { points, end: TRACE_END.degenerate };
    const p4 = {
      x: current.x + h * k3.x,
      y: current.y + h * k3.y,
      z: current.z + h * k3.z,
    };
    const k4 = unitField(coefficients, p4, externalField);
    if (!k4) return { points, end: TRACE_END.degenerate };

    const next = {
      x: current.x + (h / 6) * (k1.x + 2 * k2.x + 2 * k3.x + k4.x),
      y: current.y + (h / 6) * (k1.y + 2 * k2.y + 2 * k3.y + k4.y),
      z: current.z + (h / 6) * (k1.z + 2 * k2.z + 2 * k3.z + k4.z),
    };
    const radius = Math.hypot(next.x, next.y, next.z);

    if (radius <= EARTH_RADIUS_KM) {
      // Land exactly on the surface rather than one step inside it, so the
      // footpoint is usable as a geographic coordinate.
      const previousRadius = Math.hypot(current.x, current.y, current.z);
      const span = previousRadius - radius;
      const t = span > 0 ? (previousRadius - EARTH_RADIUS_KM) / span : 0;
      points.push({
        x: current.x + (next.x - current.x) * t,
        y: current.y + (next.y - current.y) * t,
        z: current.z + (next.z - current.z) * t,
      });
      return { points, end: TRACE_END.closed };
    }
    points.push(next);
    if (radius >= maxRadiusKm) return { points, end: TRACE_END.escaped };
    current = next;
  }
  return { points, end: TRACE_END.exhausted };
}

/**
 * Trace both ways from a seed and join the halves into one line.
 *
 * A seed in the middle of a field line belongs to a line that runs in both
 * directions; tracing one way alone silently returns half of it.
 */
export function traceFullLine(coefficients, seed, options = {}) {
  const forward = traceFieldLine(coefficients, seed, {
    ...options,
    direction: 1,
  });
  const backward = traceFieldLine(coefficients, seed, {
    ...options,
    direction: -1,
  });
  const points = [...backward.points.slice(1).reverse(), ...forward.points];
  return { points, ends: [backward.end, forward.end] };
}

/** Geocentric Cartesian km for a geographic surface point. */
export function surfacePoint(
  latitudeDeg,
  longitudeDeg,
  radiusKm = EARTH_RADIUS_KM,
) {
  const theta = ((90 - latitudeDeg) * Math.PI) / 180;
  const phi = (longitudeDeg * Math.PI) / 180;
  return {
    x: radiusKm * Math.sin(theta) * Math.cos(phi),
    y: radiusKm * Math.sin(theta) * Math.sin(phi),
    z: radiusKm * Math.cos(theta),
  };
}
