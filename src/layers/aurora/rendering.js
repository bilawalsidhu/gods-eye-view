import { createShellSurface } from '../weather/shellRendering.js';
import { NO_IMAGERY_HOST } from '../weather/imageryHost.js';
import { dipoleAxis, mltRotationRadians } from './magneticLocalTime.js';

/**
 * How long a new forecast takes to replace the one on screen.
 *
 * Long enough to read as the oval moving, short enough that it has settled
 * well before the next five-minute fetch. The blended raster costs about 23 ms
 * to build, so a dozen frames across this window is a few hundred milliseconds
 * of work every five minutes.
 */
export const AURORA_TRANSITION_MS = 1600;

/** Frames per second while a transition runs. */
export const AURORA_TRANSITION_FPS = 12;

export const AURORA_COLORS = Object.freeze([
  [0, [0, 0, 0, 0]],
  [5, [25, 105, 82, 18]],
  [10, [49, 190, 104, 70]],
  [25, [98, 239, 156, 145]],
  [50, [255, 228, 92, 205]],
  [75, [255, 113, 86, 225]],
  [100, [239, 77, 255, 240]],
]);

// Auroral emission is not a surface and it is not thin. The green 557.7 nm
// line most people photograph peaks near 100-120 km; the red 630 nm line
// reaches 200-400 km and is much fainter. One sheet made the oval a decal
// hovering at altitude — right height, no body. A short stack of the same
// field, each shell fainter than the one below it, gives the curtain real
// vertical extent, which is what you actually see edge-on at the limb.
//
// Weights are per-shell alpha relative to the layer's own opacity. They are
// deliberately small: alpha compositing is `1 - product(1 - a)`, so these nine
// sum to roughly the opacity a single shell had, and the oval seen from above
// is as bright as before. Spend them the other way — a few strong shells — and
// the limb reads as venetian blinds rather than a curtain.
//
// The mesh coarsens with height, because a facet 300 km up subtends less
// against the limb than the same facet on the ground. The whole stack totals
// about 208k cells, which is fewer than the single 0.5-degree shell this
// replaced, so the curtain costs less geometry than the sheet did.
export const AURORA_SHELL_STACK = Object.freeze([
  { height: 95_000, weight: 0.42, granularityDegrees: 1 },
  { height: 110_000, weight: 0.34, granularityDegrees: 1.25 },
  { height: 127_000, weight: 0.27, granularityDegrees: 1.5 },
  { height: 147_000, weight: 0.21, granularityDegrees: 1.75 },
  { height: 170_000, weight: 0.16, granularityDegrees: 2 },
  { height: 198_000, weight: 0.12, granularityDegrees: 2.25 },
  { height: 232_000, weight: 0.085, granularityDegrees: 2.5 },
  { height: 272_000, weight: 0.055, granularityDegrees: 3 },
  { height: 320_000, weight: 0.03, granularityDegrees: 3.5 },
]);

function rgbaFor(value) {
  let upper = AURORA_COLORS.findIndex(([stop]) => value <= stop);
  if (upper <= 0) return AURORA_COLORS[Math.max(0, upper)][1];
  if (upper < 0) upper = AURORA_COLORS.length - 1;
  const [aStop, a] = AURORA_COLORS[upper - 1];
  const [bStop, b] = AURORA_COLORS[upper];
  const t = (value - aStop) / (bStop - aStop);
  return a.map((channel, index) =>
    Math.round(channel + (b[index] - channel) * t),
  );
}

/**
 * Probability at an arbitrary position, bilinear between grid cells.
 *
 * Needed because the magnetic-local-time rotation below is a fraction of a
 * degree between updates, and the grid is one degree per cell: sampled
 * nearest-neighbour the oval would sit still and then jump a whole cell.
 *
 * Longitude wraps; latitude clamps, since there is no cell beyond the poles.
 *
 * @param {object} snapshot Validated OVATION snapshot.
 * @param {number} latitudeDeg Latitude to sample.
 * @param {number} longitudeDeg Longitude to sample.
 * @returns {number} Probability in 0-100.
 */
export function sampleProbability(snapshot, latitudeDeg, longitudeDeg) {
  const { nx, ny } = snapshot.grid;
  const values = snapshot.probabilities;

  const y = Math.min(ny - 1, Math.max(0, latitudeDeg + 90));
  const y0 = Math.floor(y);
  const y1 = Math.min(ny - 1, y0 + 1);
  const fy = y - y0;

  const x = ((longitudeDeg % 360) + 360) % 360;
  const x0 = Math.floor(x) % nx;
  const x1 = (x0 + 1) % nx;
  const fx = x - Math.floor(x);

  const v00 = values[y0 * nx + x0];
  const v01 = values[y0 * nx + x1];
  const v10 = values[y1 * nx + x0];
  const v11 = values[y1 * nx + x1];
  return (
    (v00 * (1 - fx) + v01 * fx) * (1 - fy) + (v10 * (1 - fx) + v11 * fx) * fy
  );
}

/**
 * Output direction vectors, one per raster cell.
 *
 * They depend only on the grid, so they are built once and reused for every
 * frame of every transition rather than recomputed 65,160 times a tick.
 *
 * @param {object} grid The snapshot's grid descriptor.
 * @returns {Float64Array} x, y, z triples in row-major grid order.
 */
function directionsFor(grid) {
  const { nx, ny } = grid;
  const out = new Float64Array(nx * ny * 3);
  for (let latIndex = 0; latIndex < ny; latIndex++) {
    const lat = ((latIndex - 90) * Math.PI) / 180;
    const cosLat = Math.cos(lat);
    const sinLat = Math.sin(lat);
    for (let lonIndex = 0; lonIndex < nx; lonIndex++) {
      const lon = (lonIndex * Math.PI) / 180;
      const i = (latIndex * nx + lonIndex) * 3;
      out[i] = cosLat * Math.cos(lon);
      out[i + 1] = cosLat * Math.sin(lon);
      out[i + 2] = sinLat;
    }
  }
  return out;
}

let cachedDirections = null;
let cachedKey = '';
function directions(grid) {
  const key = `${grid.nx}x${grid.ny}`;
  if (cachedKey !== key) {
    cachedDirections = directionsFor(grid);
    cachedKey = key;
  }
  return cachedDirections;
}

/**
 * Turn NOAA's south-to-north 1° scalar rows into one global raster.
 *
 * With no options this is a straight copy, which is the common case and the
 * one the first frame after a fetch takes. Pass a transition and it instead
 * resamples: each field is rotated about the geomagnetic dipole axis to a
 * shared magnetic local time and the two are mixed, so the oval slides into its
 * new position rather than one dissolving while another appears beside it.
 *
 * @param {object} snapshot The newer snapshot.
 * @param {object} [transition] Blend state.
 * @param {object} [transition.previous] The older snapshot.
 * @param {number} [transition.mix] 0 shows previous, 1 shows snapshot.
 * @param {object} [transition.axis] Dipole axis unit vector.
 * @param {number} [transition.rotationRadians] Oval rotation from previous to
 *   snapshot, as mltRotationRadians reports it.
 * @returns {{width: number, height: number, rgba: Uint8ClampedArray}} Raster.
 */
export function createAuroraRaster(snapshot, transition = null) {
  const width = snapshot.grid.nx;
  const height = snapshot.grid.ny;
  const rgba = new Uint8ClampedArray(width * height * 4);

  const blending =
    transition?.previous && transition.axis && Number.isFinite(transition.mix);

  // The endpoints are whole fields, so they skip the resampling entirely. mix 0
  // is the OLDER field, not the newer one: a transition that began at its own
  // destination would never appear to move at all.
  const endpoint = !blending
    ? snapshot
    : (transition.mix <= 0 && transition.previous) ||
      (transition.mix >= 1 && snapshot) ||
      null;

  if (endpoint) {
    for (let latIndex = 0; latIndex < height; latIndex++) {
      const imageY = height - 1 - latIndex;
      for (let lonIndex = 0; lonIndex < width; lonIndex++) {
        const color = rgbaFor(
          endpoint.probabilities[latIndex * width + lonIndex],
        );
        rgba.set(color, (imageY * width + lonIndex) * 4);
      }
    }
    return { width, height, rgba };
  }

  const { previous, mix, axis } = transition;
  const rotation = transition.rotationRadians || 0;
  const vectors = directions(snapshot.grid);

  // Carry the older field forward by mix of the way and the newer one back by
  // the rest, so at every step both ovals sit at the same magnetic local time.
  // Sampling is an inverse map, hence the negated angles.
  const back = (angle) => {
    const cos = Math.cos(-angle);
    const sin = Math.sin(-angle);
    return { cos, sin, oneMinusCos: 1 - cos };
  };
  const forPrevious = back(rotation * mix);
  const forCurrent = back(-rotation * (1 - mix));

  const sampleRotated = (field, r, i) => {
    const x = vectors[i];
    const y = vectors[i + 1];
    const z = vectors[i + 2];
    const along = (axis.x * x + axis.y * y + axis.z * z) * r.oneMinusCos;
    const kx = axis.y * z - axis.z * y;
    const ky = axis.z * x - axis.x * z;
    const kz = axis.x * y - axis.y * x;
    const rx = x * r.cos + kx * r.sin + axis.x * along;
    const ry = y * r.cos + ky * r.sin + axis.y * along;
    const rz = z * r.cos + kz * r.sin + axis.z * along;
    return sampleProbability(
      field,
      (Math.asin(Math.max(-1, Math.min(1, rz))) * 180) / Math.PI,
      (Math.atan2(ry, rx) * 180) / Math.PI,
    );
  };

  for (let latIndex = 0; latIndex < height; latIndex++) {
    const imageY = height - 1 - latIndex;
    for (let lonIndex = 0; lonIndex < width; lonIndex++) {
      const cell = latIndex * width + lonIndex;
      const i = cell * 3;
      const a = sampleRotated(previous, forPrevious, i);
      const b = sampleRotated(snapshot, forCurrent, i);
      rgba.set(
        rgbaFor(a * (1 - mix) + b * mix),
        (imageY * width + lonIndex) * 4,
      );
    }
  }
  return { width, height, rgba };
}

export function createAuroraRendering({
  viewer,
  cesium,
  getHost,
  now = () => Date.now(),
  createCanvas = () => document.createElement('canvas'),
  // Injected for the same reason as createCanvas: the stack's altitudes and
  // weights are the whole feature, and a unit test can only see them here.
  createSurface = createShellSurface,
} = {}) {
  let snapshot = null;
  let previous = null;
  let transition = null;
  let shells = [];
  let kind = null;
  let alpha = 0.75;
  let error = null;
  // Two canvases, used alternately. setImage ignores a value identical to the
  // one it already holds, so repainting a single canvas in place would never
  // re-upload the texture.
  const canvases = [];
  let canvasIndex = 0;

  function removeDisplay() {
    for (const { surface } of shells) surface.destroy();
    shells = [];
    kind = null;
    viewer.scene?.requestRender?.();
  }
  /**
   * Draw the field at a point in the transition and hand it to every shell.
   *
   * @param {?number} mix 0 shows the previous forecast, 1 the current one;
   *   null when there is no transition in flight.
   * @returns {HTMLCanvasElement} The canvas the shells were given.
   */
  function paint(mix) {
    const raster = createAuroraRaster(
      snapshot,
      transition && mix !== null
        ? {
            previous,
            mix,
            axis: transition.axis,
            rotationRadians: transition.rotationRadians,
          }
        : null,
    );
    if (canvases.length < 2) canvases.push(createCanvas());
    const canvas = canvases[canvasIndex % canvases.length];
    canvasIndex += 1;
    canvas.width = raster.width;
    canvas.height = raster.height;
    const context = canvas.getContext('2d');
    const image = context.createImageData(raster.width, raster.height);
    image.data.set(raster.rgba);
    context.putImageData(image, 0, 0);
    for (const { surface } of shells) surface.setImage(canvas);
    viewer.scene?.requestRender?.();
    return canvas;
  }

  function install() {
    removeDisplay();
    if (!snapshot) return;
    const host = getHost();
    if (host.kind === 'none') {
      error = NO_IMAGERY_HOST;
      return;
    }
    try {
      const raster = createAuroraRaster(snapshot);
      if (canvases.length < 2) {
        while (canvases.length < 2) canvases.push(createCanvas());
      }
      const canvas = canvases[canvasIndex % canvases.length];
      canvasIndex += 1;
      canvas.width = raster.width;
      canvas.height = raster.height;
      const context = canvas.getContext('2d');
      const image = context.createImageData(raster.width, raster.height);
      image.data.set(raster.rgba);
      context.putImageData(image, 0, 0);
      kind = host.kind;
      // One raised shell for every host. Imagery is draped on the surface by
      // definition and cannot carry an altitude, which put the aurora on the
      // ground — wrong for the one product here that is genuinely not weather:
      // it is emission near 100 km, and the standoff is most of why an oval
      // reads correctly on a sphere at all.
      shells = AURORA_SHELL_STACK.map(
        ({ height, weight, granularityDegrees }) => {
          const surface = createSurface({
            viewer,
            cesium,
            rectangle: cesium.Rectangle.MAX_VALUE,
            height,
            granularityDegrees,
          });
          surface.setImage(canvas);
          surface.setAlpha(alpha * weight);
          return { surface, weight };
        },
      );
      viewer.scene?.requestRender?.();
      error = null;
    } catch (cause) {
      // Keep the cause. A bare catch here made a hard constructor assertion
      // present as a generic "unavailable" badge with nothing in the console,
      // which is how a broken field survived a full green gate run.
      console.warn('[Aurora] field image install failed:', cause);
      for (const { surface } of shells) surface.destroy();
      shells = [];
      kind = null;
      viewer.scene?.requestRender?.();
      error = 'Aurora field image unavailable';
      return;
    }
  }
  return {
    setField(next) {
      const prior = snapshot;
      // SWPC republishes the same forecast between our five-minute polls more
      // often than not. Rebuilding nine shells to draw identical pixels is pure
      // cost, and it would restart a transition that is already running.
      if (
        prior &&
        shells.length > 0 &&
        prior.forecastTime &&
        prior.forecastTime === next.forecastTime
      ) {
        snapshot = next;
        return;
      }
      snapshot = next;
      // A forecast replacing one already on screen slides into place. Anything
      // else - first field, a changed imagery host, a gap long enough that the
      // two are not consecutive - just installs.
      const consecutive =
        prior &&
        shells.length > 0 &&
        Number.isFinite(Date.parse(prior.forecastTime)) &&
        Number.isFinite(Date.parse(next.forecastTime)) &&
        Date.parse(next.forecastTime) > Date.parse(prior.forecastTime);
      if (!consecutive) {
        previous = null;
        transition = null;
        install();
        return;
      }
      previous = prior;
      const from = new Date(prior.forecastTime);
      const to = new Date(next.forecastTime);
      transition = {
        startedAt: now(),
        axis: dipoleAxis(to),
        rotationRadians: mltRotationRadians(from, to),
      };
      paint(0);
    },

    /**
     * Step an in-flight transition.
     *
     * @param {number} [at] Current time in ms, for tests.
     * @returns {boolean} Whether a transition is still running.
     */
    advance(at = now()) {
      if (!transition || shells.length === 0) return false;
      const mix = Math.min(
        1,
        (at - transition.startedAt) / AURORA_TRANSITION_MS,
      );
      if (mix >= 1) {
        transition = null;
        previous = null;
        paint(null);
        return false;
      }
      paint(mix);
      return true;
    },

    isTransitioning() {
      return Boolean(transition);
    },
    setAlpha(next) {
      alpha = next;
      for (const { surface, weight } of shells)
        surface.setAlpha(alpha * weight);
      viewer.scene?.requestRender?.();
    },
    rehome() {
      const host = getHost();
      if (snapshot && host.kind !== kind) install();
    },
    clear() {
      snapshot = null;
      previous = null;
      transition = null;
      removeDisplay();
      error = null;
    },
    destroy() {
      snapshot = null;
      previous = null;
      transition = null;
      removeDisplay();
      error = null;
    },
    getDiagnostics() {
      return {
        host: kind,
        imageryActive: shells.length > 0,
        error,
        transitioning: Boolean(transition),
      };
    },
  };
}
