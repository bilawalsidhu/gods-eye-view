/**
 * @module render/conformance/visual
 * @description The visual checks: draw a reference scene from one of its
 * views, capture it, and compare the capture with the reference image under
 * a perceptual tolerance.
 *
 * Pixels are compared as pixelmatch compares them (its algorithm, ported;
 * pixelmatch is ISC-licensed, copyright Mapbox): by YIQ difference, which
 * weighs brightness over hue as the eye does, and excusing a differing pixel
 * that is antialiasing in either image, one on an edge between two flat
 * colours. A dropped or moved item differs inside its body and along hard
 * edges, which are not excused. A differing pixel whose four neighbours
 * differ too is solid: antialiasing differs along one-pixel fringes and has
 * none. Two images match when at most `maxSolidPixels` pixels are solid and
 * at most `maxMismatchedPixels` are unexcused.
 *
 * The two measures cover each other. Measured on the default renderer at
 * 640×360, against references drawn with 4× MSAA:
 *
 * | Change                         | Solid | Unexcused |
 * | ------------------------------ | ----: | --------: |
 * | Drawn with 1×, 2× or 8× MSAA   |     0 |  ≤ 192    |
 * | The smallest point (4 px) gone |     7 |      8    |
 * | An arrow line reversed         |    24 |     88    |
 * | An arrow icon turned           |    64 |     91    |
 * | A 2 px line gone               | ≥ 267 |  ≥ 536    |
 * | The whole view moved 1 px      |  ≥ 36 |  ≥ 480    |
 * | An icon gone                   | ~ 300 |  ~ 300    |
 *
 * The limit: a solid pixel needs a change at least 3 px thick, so a change
 * that is nowhere that thick (a thin line gone, an item moved a pixel or two)
 * passes when it covers at most 250 px: a missing 2 px line up to 125 px
 * long, say, or a 20 px box moved 1 or 2 px. A blob up to about 3×4 px is
 * under both limits too (2 solid pixels). Larger thin changes, and any
 * change whose 3 px core is more than two pixels, are caught; the smallest
 * item in the scenes, the 4 px point, leaves 7.
 */

/** Tolerances the default renderer meets against its own references with any antialiasing. */
export const VISUAL_TOLERANCE = Object.freeze({
  threshold: 0.1,
  maxSolidPixels: 2,
  maxMismatchedPixels: 250,
});

/** The largest YIQ difference two RGB colours can have. */
const MAX_YIQ_DELTA = 35215;

/** Composites a channel over black, so transparent and black read the same. */
const over = (c, a) => (c * a) / 255;

const rgb = (d, p) => [
  over(d[p], d[p + 3]),
  over(d[p + 1], d[p + 3]),
  over(d[p + 2], d[p + 3]),
];
const brightness = ([r, g, b]) =>
  r * 0.29889531 + g * 0.58662247 + b * 0.11448223;

function yiqDelta([r1, g1, b1], [r2, g2, b2]) {
  const i = (r, g, b) => r * 0.59597799 - g * 0.2741761 - b * 0.32180189;
  const q = (r, g, b) => r * 0.21147017 - g * 0.52261711 + b * 0.31114694;
  const dy = brightness([r1, g1, b1]) - brightness([r2, g2, b2]);
  const di = i(r1, g1, b1) - i(r2, g2, b2);
  const dq = q(r1, g1, b1) - q(r2, g2, b2);
  return 0.5053 * dy * dy + 0.299 * di * di + 0.1957 * dq * dq;
}

/** Whether (x, y) has more than two neighbours of exactly its own colour. */
function hasManySiblings(px, x1, y1, w, h) {
  const val = px[y1 * w + x1];
  let zeroes = x1 === 0 || y1 === 0 || x1 === w - 1 || y1 === h - 1 ? 1 : 0;
  for (let x = Math.max(x1 - 1, 0); x <= Math.min(x1 + 1, w - 1); x++)
    for (let y = Math.max(y1 - 1, 0); y <= Math.min(y1 + 1, h - 1); y++) {
      if (x === x1 && y === y1) continue;
      if (px[y * w + x] === val && ++zeroes > 2) return true;
    }
  return false;
}

/**
 * Whether (x1, y1) of `img` is antialiasing: a pixel between its darkest and
 * brightest neighbours, one of which is flat (has siblings) in both images.
 */
function antialiased(img, px, otherPx, x1, y1, w, h) {
  const here = brightness(rgb(img, (y1 * w + x1) * 4));
  let zeroes = x1 === 0 || y1 === 0 || x1 === w - 1 || y1 === h - 1 ? 1 : 0;
  let min = 0;
  let max = 0;
  let minX;
  let minY;
  let maxX;
  let maxY;
  for (let x = Math.max(x1 - 1, 0); x <= Math.min(x1 + 1, w - 1); x++)
    for (let y = Math.max(y1 - 1, 0); y <= Math.min(y1 + 1, h - 1); y++) {
      if (x === x1 && y === y1) continue;
      const delta = here - brightness(rgb(img, (y * w + x) * 4));
      if (delta === 0) {
        if (++zeroes > 2) return false;
      } else if (delta < min) {
        min = delta;
        minX = x;
        minY = y;
      } else if (delta > max) {
        max = delta;
        maxX = x;
        maxY = y;
      }
    }
  if (min === 0 || max === 0) return false;
  return (
    (hasManySiblings(px, minX, minY, w, h) &&
      hasManySiblings(otherPx, minX, minY, w, h)) ||
    (hasManySiblings(px, maxX, maxY, w, h) &&
      hasManySiblings(otherPx, maxX, maxY, w, h))
  );
}

/**
 * @param {{width: number, height: number, data: Uint8ClampedArray}} actual
 * @param {{width: number, height: number, data: Uint8ClampedArray}} expected
 * @param {{threshold?: number, maxSolidPixels?: number, maxMismatchedPixels?: number, diff?: Uint8ClampedArray}} [options]
 *   `diff`, when given, is filled with an RGBA image of the differences:
 *   mismatches red, excused antialiasing yellow.
 * @returns {{match: boolean, diffPixels: number, diffFraction: number, solidPixels: number, mismatchedPixels: number, reason?: string}}
 */
export function compareImages(actual, expected, options = {}) {
  const { threshold, maxSolidPixels, maxMismatchedPixels } = {
    ...VISUAL_TOLERANCE,
    ...options,
  };
  if (actual.width !== expected.width || actual.height !== expected.height)
    return {
      match: false,
      diffPixels: NaN,
      diffFraction: 1,
      solidPixels: NaN,
      mismatchedPixels: NaN,
      reason: `size ${actual.width}×${actual.height}, reference ${expected.width}×${expected.height}`,
    };
  const { width: w, height: h } = actual;
  // Whole pixels compare as 32-bit words; data that does not start on a
  // word (a sliced Node buffer) is copied first.
  const aligned = (d) =>
    d.byteOffset % 4 === 0 ? d : new Uint8ClampedArray(d);
  const a = aligned(actual.data);
  const b = aligned(expected.data);
  const aPx = new Uint32Array(a.buffer, a.byteOffset, w * h);
  const bPx = new Uint32Array(b.buffer, b.byteOffset, w * h);
  const limit = MAX_YIQ_DELTA * threshold * threshold;
  const diff = options.diff;
  const differing = new Uint8Array(w * h);
  let diffPixels = 0;
  let mismatchedPixels = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      const p = k * 4;
      const differs =
        aPx[k] !== bPx[k] && yiqDelta(rgb(a, p), rgb(b, p)) > limit;
      let mismatch = false;
      if (differs) {
        differing[k] = 1;
        diffPixels += 1;
        mismatch =
          !antialiased(a, aPx, bPx, x, y, w, h) &&
          !antialiased(b, bPx, aPx, x, y, w, h);
        if (mismatch) mismatchedPixels += 1;
      }
      if (diff) {
        // Differences over a faded copy of the reference.
        const faded = 40 + over(b[p + 1], b[p + 3]) * 0.25;
        diff[p] = differs ? 255 : faded;
        diff[p + 1] = differs ? (mismatch ? 0 : 220) : faded;
        diff[p + 2] = differs ? 0 : faded;
        diff[p + 3] = 255;
      }
    }
  // Solid: a differing pixel whose four neighbours differ too.
  let solidPixels = 0;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const k = y * w + x;
      if (
        differing[k] &&
        differing[k - 1] &&
        differing[k + 1] &&
        differing[k - w] &&
        differing[k + w]
      )
        solidPixels += 1;
    }
  return {
    match:
      solidPixels <= maxSolidPixels && mismatchedPixels <= maxMismatchedPixels,
    diffPixels,
    diffFraction: diffPixels / (w * h),
    solidPixels,
    mismatchedPixels,
  };
}

/** The file a view's reference image is stored under. */
export const referenceName = (sceneId, viewName) =>
  `${sceneId}-${viewName}.png`;

/**
 * Draws a scene, then each of its views once the renderer has settled.
 * @param {object} renderer
 * @param {object} scene One of `REFERENCE_SCENES`.
 * @param {{toEcef: Function, assets?: object}} ctx
 * @param {(view: {name: string}, capture: Blob, settle: {state: string, blockers: string[]}) => void|Promise<void>} onView
 *   `settle` is what `whenSettled` answered; a capture that did not settle
 *   is no reference and no pass.
 */
export async function drawScene(renderer, scene, ctx, onView) {
  const dispose = await scene.build(renderer, ctx);
  try {
    for (const view of scene.views) {
      renderer.camera.setView(view.view);
      const settle = await renderer.whenSettled({ timeoutMs: 20000 });
      await onView(view, await renderer.capture({ type: 'png' }), settle);
    }
  } finally {
    dispose();
  }
}
