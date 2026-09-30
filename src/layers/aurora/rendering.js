import { createShellSurface } from '../weather/shellRendering.js';
import { NO_IMAGERY_HOST } from '../weather/imageryHost.js';

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

/** Turn NOAA's south-to-north 1° scalar rows into one global raster. */
export function createAuroraRaster(snapshot) {
  const width = snapshot.grid.nx;
  const height = snapshot.grid.ny;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let latIndex = 0; latIndex < height; latIndex++) {
    const imageY = height - 1 - latIndex;
    for (let lonIndex = 0; lonIndex < width; lonIndex++) {
      const color = rgbaFor(
        snapshot.probabilities[latIndex * width + lonIndex],
      );
      rgba.set(color, (imageY * width + lonIndex) * 4);
    }
  }
  return { width, height, rgba };
}

export function createAuroraRendering({
  viewer,
  cesium,
  getHost,
  createCanvas = () => document.createElement('canvas'),
  // Injected for the same reason as createCanvas: the stack's altitudes and
  // weights are the whole feature, and a unit test can only see them here.
  createSurface = createShellSurface,
} = {}) {
  let snapshot = null;
  let shells = [];
  let kind = null;
  let alpha = 0.75;
  let error = null;

  function removeDisplay() {
    for (const { surface } of shells) surface.destroy();
    shells = [];
    kind = null;
    viewer.scene?.requestRender?.();
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
      const canvas = createCanvas();
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
      snapshot = next;
      install();
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
      removeDisplay();
      error = null;
    },
    destroy() {
      snapshot = null;
      removeDisplay();
      error = null;
    },
    getDiagnostics() {
      return { host: kind, imageryActive: shells.length > 0, error };
    },
  };
}
