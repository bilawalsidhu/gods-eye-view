/**
 * Magnetosphere layer: field-line filaments and a live magnetopause.
 *
 * The filaments come from the vendored IGRF table and are computed here, not
 * fetched. They depend on the date, not the solar wind, so they are traced
 * once per enable and then left alone. Only the boundary follows the feed.
 *
 * What this layer does NOT claim: IGRF models the field produced inside the
 * Earth. Out past a few Earth radii the external magnetospheric currents
 * dominate and the real field lines are stretched into a tail this model does
 * not have. The filaments are therefore honest near Earth and increasingly
 * schematic with distance, and the UI says so rather than letting a tidy
 * closed arc imply otherwise.
 *
 * @module layers/magnetosphere
 */
import * as Cesium from 'cesium';
import { coefficientsFor, decimalYear, IGRF_VALID_UNTIL } from './field.js';
import { fieldLineSeeds } from './geometry.js';
import { createMagnetosphereRendering } from './rendering.js';
import { createMagnetosphereSource } from './source.js';
import { externalFieldFor } from './gsm.js';
import { t89, t89BandForKp } from './t89.js';
import { shueParameters } from './magnetopause.js';
import { EARTH_RADIUS_KM, traceFullLine } from './trace.js';

const REFRESH_MS = 120_000;

/**
 * Earth-fixed unit vector toward the Sun.
 *
 * The magnetopause is a surface of revolution about the Earth-Sun line, so
 * this is the only ephemeris the layer needs — not a full GSM frame, whose
 * remaining axes the boundary is symmetric in anyway.
 */
export function sunDirectionFixed(cesium, julianDate) {
  const inertial =
    cesium.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
      julianDate,
      new cesium.Cartesian3(),
    );
  const toFixed =
    cesium.Transforms.computeIcrfToFixedMatrix(
      julianDate,
      new cesium.Matrix3(),
    ) ||
    cesium.Transforms.computeTemeToPseudoFixedMatrix(
      julianDate,
      new cesium.Matrix3(),
    );
  // ICRF data is loaded asynchronously and may not be ready on first frame.
  // Without it the direction would be wrong rather than merely late, so the
  // caller is told to try again instead of being handed a plausible lie.
  if (!toFixed) return null;
  const fixed = cesium.Matrix3.multiplyByVector(
    toFixed,
    inertial,
    new cesium.Cartesian3(),
  );
  const length = cesium.Cartesian3.magnitude(fixed);
  if (!(length > 0)) return null;
  return { x: fixed.x / length, y: fixed.y / length, z: fixed.z / length };
}
const OPACITY = Object.freeze({ light: 0.4, strong: 0.8 });

/**
 * Trace every seed, yielding between lines.
 *
 * Tracing 80 field lines is a few seconds of arithmetic. Done in one go it
 * freezes the frame; yielding lets the globe keep drawing while the structure
 * fills in, which also reads better than a sudden appearance.
 */
export async function traceFilaments(
  coefficients,
  seeds,
  {
    signal,
    externalField = null,
    yieldTo = () => new Promise((r) => setTimeout(r, 0)),
  } = {},
) {
  const lines = [];
  for (const seed of seeds) {
    if (signal?.aborted) break;
    const { points } = traceFullLine(coefficients, seed.position, {
      stepKm: 150,
      // With an external field the high-latitude lines open and run down the
      // tail instead of closing, so the budget has to reach far enough to
      // show that rather than clipping it into a false closed arc.
      maxRadiusKm: (externalField ? 40 : 18) * EARTH_RADIUS_KM,
      externalField,
    });
    if (points.length >= 2) lines.push({ seed, points });
    await yieldTo();
  }
  return lines;
}

export function createMagnetosphereLayer({
  source = createMagnetosphereSource(),
  createRendering = createMagnetosphereRendering,
  meridians = 8,
  now = () => Date.now(),
} = {}) {
  let rendering = null;
  let state = null;
  let error = null;
  let filaments = [];
  let sunDirection = null;
  let opacity = 'strong';
  let lastFetch = 0;
  let listener = null;
  let tracing = null;
  const notify = () => listener?.();

  function parameters() {
    if (!state || state.unavailable) return null;
    return { r0: state.standoffRe, alpha: state.flaring };
  }

  function refreshSunDirection(viewer, options = {}) {
    if (options.sunDirection) {
      sunDirection = options.sunDirection;
      return;
    }
    const cesium = layer._cesium;
    if (!cesium) return;
    const time = viewer?.clock?.currentTime || cesium.JulianDate.now();
    const next = sunDirectionFixed(cesium, time);
    if (next) sunDirection = next;
  }

  function redraw() {
    if (!rendering) return;
    rendering.setBoundary(parameters(), sunDirection);
    rendering.setFilaments(filaments, {
      parameters: parameters(),
      sunDirection,
    });
  }

  const layer = {
    id: 'magnetosphere',
    name: 'Magnetosphere',
    icon: '*',
    source: 'IGRF-14 · NOAA SWPC solar wind',
    showInTogglePanel: true,
    updateInterval: REFRESH_MS,

    async init(viewer, options = {}) {
      const cesium = options.cesium || Cesium;
      layer._cesium = cesium;
      rendering = createRendering({ viewer, cesium });
      const year = decimalYear(new Date(now()));
      const coefficients = coefficientsFor(year);
      // Kept so the panel can say the model is being run past its published
      // secular-variation span rather than quietly drifting.
      layer.modelExtrapolated = coefficients.extrapolatedBeyondModel;
      layer.modelValidUntil = IGRF_VALID_UNTIL;
      tracing = traceFilaments(coefficients, fieldLineSeeds(meridians));
      filaments = await tracing;
      tracing = null;
    },

    async enable(viewer, options = {}) {
      refreshSunDirection(viewer, options);
      redraw();
      notify();
    },

    async disable() {
      rendering?.clear();
      notify();
    },

    async update(viewer, options = {}) {
      refreshSunDirection(viewer, options);
      if (now() - lastFetch < REFRESH_MS && state) {
        redraw();
        return;
      }
      lastFetch = now();
      try {
        const next = await source.load(options?.signal);
        state = next.unavailable ? null : next;
        error = next.unavailable ? next.reason : null;
      } catch (cause) {
        // The filaments do not depend on the feed, so a boundary failure is
        // reported without taking the layer down with it.
        error = cause?.message || 'magnetosphere_unavailable';
      }
      redraw();
      notify();
    },

    getStats() {
      const pause = parameters();
      return {
        count: filaments.length,
        lastUpdate: state ? Date.parse(state.observedAt) || now() : null,
        source: layer.source,
        error,
        stale: Boolean(state?.stale),
        standoffRe: pause ? Number(pause.r0.toFixed(2)) : null,
        insideGeosynchronous: Boolean(state?.insideGeosynchronous),
      };
    },

    getParams() {
      return { opacity };
    },

    setParams(next = {}) {
      if (next.opacity && OPACITY[next.opacity]) {
        opacity = next.opacity;
        rendering?.setOpacity(OPACITY[opacity]);
        notify();
        return true;
      }
      return false;
    },

    setRowControlsListener(fn) {
      listener = typeof fn === 'function' ? fn : null;
    },

    destroy() {
      rendering?.destroy();
      rendering = null;
      filaments = [];
      state = null;
      listener = null;
    },
  };
  return layer;
}

export { shueParameters };
