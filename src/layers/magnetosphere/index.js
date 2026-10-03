/**
 * Magnetosphere layer: field-line filaments and a live magnetopause.
 *
 * The filaments come from the vendored IGRF table and are computed here, not
 * fetched. They depend on the date, not the solar wind, so they are traced
 * once per enable and then left alone. Only the boundary follows the feed.
 *
 * IGRF alone models only the field produced inside the Earth, and past a few
 * Earth radii the external magnetospheric currents dominate: without them the
 * lines balloon out on the dayside and never form a tail. So once the feed
 * arrives the filaments are re-traced with whichever Tsyganenko model the feed
 * supports - T96 given the full solar wind state, T89 given only Kp. The first
 * trace runs before any of that, from IGRF alone, so the layer paints
 * immediately rather than waiting on the network; it is then replaced.
 *
 * When the feed supports neither model the filaments stay internal-only. They
 * are honest near Earth and increasingly schematic with distance, and the UI
 * says which model produced them rather than letting a tidy closed arc imply
 * otherwise.
 *
 * @module layers/magnetosphere
 */
import * as Cesium from 'cesium';
import { coefficientsFor, decimalYear, IGRF_VALID_UNTIL } from './field.js';
import { fieldLineSeeds } from './geometry.js';
import { createMagnetosphereRendering } from './rendering.js';
import { createMagnetosphereSource } from './source.js';
import { externalFieldFor } from './gsm.js';
import { selectExternalModel } from './external.js';
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
  let coefficients = null;
  let model = null;
  let tracedKey = null;
  let retracing = null;
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
      coefficients = coefficientsFor(year);
      // Kept so the panel can say the model is being run past its published
      // secular-variation span rather than quietly drifting.
      layer.modelExtrapolated = coefficients.extrapolatedBeyondModel;
      layer.modelValidUntil = IGRF_VALID_UNTIL;
      tracing = traceFilaments(coefficients, fieldLineSeeds(meridians));
      filaments = await tracing;
      tracing = null;
    },

    /**
     * Re-trace with the external field once the feed names a usable model.
     *
     * Skipped when the field has not changed enough to move a line visibly -
     * the selector's key is rounded for exactly that reason - because tracing
     * every seed is seconds of arithmetic, not milliseconds.
     *
     * @param {AbortSignal} [signal] Aborts an in-progress trace.
     * @returns {Promise<boolean>} Whether the filaments were replaced.
     */
    async retrace(signal) {
      const next = selectExternalModel(state);
      model = next;
      const key = next ? next.key : 'internal';
      if (key === tracedKey || !coefficients) return false;
      // One trace at a time. A second refresh arriving mid-trace would other-
      // wise race the first and the loser would overwrite the winner.
      if (retracing) return false;
      if (!sunDirection) return false;
      const externalField = next
        ? externalFieldFor({
            coefficients,
            sunDirection,
            parameters: next.parameters,
            evaluate: next.evaluate,
            earthRadiusKm: EARTH_RADIUS_KM,
          })
        : null;
      // A missing GSM frame means the Sun direction was degenerate; leave the
      // existing filaments rather than replacing them with internal-only ones.
      if (next && !externalField) return false;
      retracing = traceFilaments(coefficients, fieldLineSeeds(meridians), {
        signal,
        externalField,
      });
      const traced = await retracing;
      retracing = null;
      if (signal?.aborted) return false;
      filaments = traced;
      tracedKey = key;
      return true;
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
      // Re-tracing is the expensive half of an update, so it happens after the
      // boundary has already been redrawn from the new state.
      redraw();
      notify();
      try {
        if (await layer.retrace(options?.signal)) {
          redraw();
          notify();
        }
      } catch (cause) {
        // A failed re-trace leaves the previous filaments in place, which is a
        // worse model but not a blank globe.
        error = cause?.message || 'magnetosphere_retrace_failed';
        notify();
      }
    },

    getStats() {
      const pause = parameters();
      return {
        count: filaments.length,
        lastUpdate: state ? Date.parse(state.observedAt) || now() : null,
        // Naming the external model in the row's own meta line is the only
        // place a user sees which one drew the filaments, and the difference
        // between T96, T89 and neither is visible in the shape of the tail.
        source: model
          ? `IGRF-14 · ${model.name.toUpperCase()}${model.extrapolated ? ' (extrapolated)' : ''} · NOAA SWPC solar wind`
          : layer.source,
        error,
        stale: Boolean(state?.stale),
        standoffRe: pause ? Number(pause.r0.toFixed(2)) : null,
        insideGeosynchronous: Boolean(state?.insideGeosynchronous),
        // Which external model the filaments on screen actually came from, so
        // the panel can say rather than implying they are all equally good.
        externalModel: model ? model.name : null,
        externalModelLabel: model ? model.label : null,
        externalModelExtrapolated: Boolean(model?.extrapolated),
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
      coefficients = null;
      model = null;
      tracedKey = null;
      retracing = null;
    },
  };
  return layer;
}

export { shueParameters };
