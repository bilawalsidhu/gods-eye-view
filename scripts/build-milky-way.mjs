#!/usr/bin/env node
/**
 * Build the soft Milky Way cube map in src/data/local_data/sky/ from the ESO
 * all-sky Milky Way panorama.
 *
 * Source page: https://www.eso.org/public/images/eso0932a/
 * Fetched:     https://cdn.eso.org/images/original/eso0932a.tif
 *              (6000×3000 8-bit sRGB TIFF, 27.7 MB; sha256 in README.md)
 * Credit:      ESO/S. Brunier
 * License:     CC BY 4.0 (https://www.eso.org/public/outreach/copyright/).
 *              Modified: stars removed, blurred, reprojected to ICRF cube
 *              faces and tone-mapped, as below.
 * Frame:       plate carrée in galactic coordinates, centred on the Galactic
 *              Centre, galactic longitude increasing to the left.
 *
 * Transform (deterministic):
 *   1. Resample to WORK_WIDTH×WORK_WIDTH/2, sRGB to linear light.
 *   2. Remove stars with a morphological opening: the renderer draws
 *      catalogue stars itself, sharp and in the right place.
 *   3. Paint out the planets the 2008–2010 exposures caught (PLANETS).
 *   4. Blur, round on the sphere: σ = BLUR_DEG, widening to FAINT_BLUR_DEG
 *      in the faint glow so unresolved stars leave no clumps.
 *   5. Resample into six WebGL cube faces (uploaded without flipY) with the
 *      ICRF axes: +X to the March equinox, +Z to the north celestial pole.
 *   6. Median sky to black with a soft knee, brightest 0.01 % to ~97 %
 *      white, on luminance to keep the hue; gamma 1/2.2, dither, WebP.
 *
 * Usage:
 *   node scripts/build-milky-way.mjs <eso0932a.tif>
 * Needs the sharp dev dependency.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FACE_SIZE = 1024;
export const BLUR_DEG = 0.4;
// Faint glow is grain of unresolved stars and needs the wide blur; bright
// parts keep the fine one and their dust lanes. FAINT_RANGE (fraction of
// black-to-white) is where the two blend.
export const FAINT_BLUR_DEG = 2;
const FAINT_RANGE = [0.005, 0.08];
const WORK_WIDTH = 4096;
const OPEN_RADIUS = 3;
const WEBP_QUALITY = 96;
// The median sky is black: above it the glow away from the plane reads as
// grey blotches. SOFT_KNEE eases the cut in so it draws no edges.
const BLACK_PERCENTILE = 0.5;
const SOFT_KNEE = 0.03;
const WHITE_PERCENTILE = 0.9999;
const OUT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'data',
  'local_data',
  'sky',
);

/**
 * Bright planets in the panorama, galactic longitude/latitude in degrees and
 * the radius painted over with the surrounding sky. By position both are
 * Jupiter, in Sagittarius (2008) and Aquarius (2010); no catalogue star lies
 * under either.
 */
export const PLANETS = Object.freeze([
  { l: 13.4, b: -16.6, radiusDeg: 2.5 },
  { l: 69.0, b: -58.4, radiusDeg: 2.5 },
]);

/** Cube faces in WebGL upload order. */
export const CUBE_FACES = Object.freeze([
  'positiveX',
  'negativeX',
  'positiveY',
  'negativeY',
  'positiveZ',
  'negativeZ',
]);
export const FACE_FILE_SUFFIX = Object.freeze({
  positiveX: 'px',
  negativeX: 'nx',
  positiveY: 'py',
  negativeY: 'ny',
  positiveZ: 'pz',
  negativeZ: 'nz',
});

/**
 * ICRF (J2000 equatorial) → galactic rotation, rows = galactic axes
 * (Hipparcos catalogue, ESA SP-1200 vol. 1 §1.5.3).
 */
export const ICRF_TO_GALACTIC = Object.freeze([
  [-0.0548755604162154, -0.873437090234885, -0.4838350155487132],
  [0.4941094278755837, -0.4448296299600112, 0.7469822444972189],
  [-0.867666149019004, -0.1980763734312015, 0.4559837761750669],
]);

/**
 * Direction (not normalized) that the WebGL cube-map lookup sends to texel
 * coordinate (s, t) ∈ [0, 1]² of `face`, t = 0 being the first image row.
 * Inverse of the OpenGL ES 3.0 §3.8.10 major-axis table.
 */
export function cubeFaceDirection(face, s, t) {
  const sc = 2 * s - 1;
  const tc = 2 * t - 1;
  switch (face) {
    case 'positiveX':
      return [1, -tc, -sc];
    case 'negativeX':
      return [-1, -tc, sc];
    case 'positiveY':
      return [sc, 1, tc];
    case 'negativeY':
      return [sc, -1, -tc];
    case 'positiveZ':
      return [sc, -tc, 1];
    case 'negativeZ':
      return [-sc, -tc, -1];
    default:
      throw new RangeError(`Unknown cube face ${face}`);
  }
}

/** Rotate an ICRF direction into galactic coordinates. */
export function icrfToGalactic([x, y, z]) {
  return ICRF_TO_GALACTIC.map((row) => row[0] * x + row[1] * y + row[2] * z);
}

/**
 * Map a direction to (u, v) ∈ [0, 1)² of a plate carrée centred on
 * longitude 0 with longitude increasing to the left and v = 0 at +90°.
 */
export function directionToPlateCarree(x, y, z) {
  const longitude = Math.atan2(y, x);
  const latitude = Math.atan2(z, Math.hypot(x, y));
  let u = 0.5 - longitude / (2 * Math.PI);
  u -= Math.floor(u);
  return [u, 0.5 - latitude / Math.PI];
}

/** Box widths whose three passes approximate a Gaussian of `sigma` (Kovesi). */
function boxRadii(sigma) {
  const ideal = Math.sqrt((12 * sigma * sigma) / 3 + 1);
  let lower = Math.floor(ideal);
  if (lower % 2 === 0) lower -= 1;
  const upper = lower + 2;
  const m = Math.round(
    (12 * sigma * sigma - 3 * lower * lower - 12 * lower - 9) /
      (-4 * lower - 4),
  );
  return [0, 1, 2].map((i) => ((i < m ? lower : upper) - 1) / 2);
}

/** Index along a line, wrapped or clamped at the ends. */
function lineIndex(i, length, wrap) {
  if (wrap) return ((i % length) + length) % length;
  return i < 0 ? 0 : i >= length ? length - 1 : i;
}

/** Running-sum box blur of one strided line. */
function boxLine(src, dst, offset, stride, length, radius, wrap) {
  if (radius < 1) {
    for (let i = 0; i < length; i++)
      dst[offset + i * stride] = src[offset + i * stride];
    return;
  }
  const r = wrap ? Math.min(radius, Math.floor((length - 1) / 2)) : radius;
  const at = (i) => src[offset + lineIndex(i, length, wrap) * stride];
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += at(i);
  const scale = 1 / (2 * r + 1);
  for (let i = 0; i < length; i++) {
    dst[offset + i * stride] = sum * scale;
    sum += at(i + r + 1) - at(i - r);
  }
}

/** Minimum or maximum over a (2r+1) window of one strided line. */
function extremumLine(src, dst, offset, stride, length, radius, wrap, pick) {
  for (let i = 0; i < length; i++) {
    let value = src[offset + lineIndex(i - radius, length, wrap) * stride];
    for (let k = -radius + 1; k <= radius; k++)
      value = pick(
        value,
        src[offset + lineIndex(i + k, length, wrap) * stride],
      );
    dst[offset + i * stride] = value;
  }
}

/** Separable minimum or maximum filter over a plate-carrée plane, in place. */
function extremumPlane(plane, width, height, radius, pick) {
  const scratch = new Float32Array(plane.length);
  for (let y = 0; y < height; y++)
    extremumLine(plane, scratch, y * width, 1, width, radius, true, pick);
  for (let x = 0; x < width; x++)
    extremumLine(scratch, plane, x, width, height, radius, false, pick);
}

/** Blur one plate-carrée channel in place, round on the sphere. */
function blurPlane(plane, width, height, sigmaPx) {
  const scratch = new Float32Array(plane.length);
  for (let y = 0; y < height; y++) {
    const latitude = (0.5 - (y + 0.5) / height) * Math.PI;
    const sigmaX = Math.min(
      width / 4,
      sigmaPx / Math.max(Math.cos(latitude), 1e-3),
    );
    for (const radius of boxRadii(sigmaX)) {
      boxLine(plane, scratch, y * width, 1, width, Math.round(radius), true);
      plane.set(scratch.subarray(y * width, (y + 1) * width), y * width);
    }
  }
  for (const radius of boxRadii(sigmaPx)) {
    for (let x = 0; x < width; x++)
      boxLine(plane, scratch, x, width, height, Math.round(radius), false);
    plane.set(scratch);
  }
}

/** Unit vector for galactic longitude and latitude in degrees. */
function galacticVector(l, b) {
  const lr = (l * Math.PI) / 180;
  const br = (b * Math.PI) / 180;
  return [
    Math.cos(br) * Math.cos(lr),
    Math.cos(br) * Math.sin(lr),
    Math.sin(br),
  ];
}

/**
 * Replace a disc of the sky with the median of the ring just outside it, per
 * channel. A median, not a mean: the planet's diffraction spikes reach far
 * past the disc and would lift a mean well above the sky. The blur that
 * follows hides the seam.
 */
function paintOut(planes, width, height, { l, b, radiusDeg }) {
  const centre = galacticVector(l, b);
  const inner = Math.cos((radiusDeg * Math.PI) / 180);
  const outer = Math.cos(((radiusDeg + 1) * Math.PI) / 180);
  const disc = [];
  const ring = [];
  const span = Math.ceil(((radiusDeg + 1) / 180) * height);
  const row = Math.round((0.5 - b / 180) * height);
  for (let y = Math.max(0, row - span); y < Math.min(height, row + span); y++) {
    const latitude = 90 - ((y + 0.5) * 180) / height;
    for (let x = 0; x < width; x++) {
      const longitude = (0.5 - (x + 0.5) / width) * 360;
      const p = galacticVector(longitude, latitude);
      const cos = p[0] * centre[0] + p[1] * centre[1] + p[2] * centre[2];
      if (cos >= inner) disc.push(y * width + x);
      else if (cos >= outer) ring.push(y * width + x);
    }
  }
  for (const plane of planes) {
    const values = Float32Array.from(ring, (index) => plane[index]).sort();
    const median = values[values.length >> 1];
    for (const index of disc) plane[index] = median;
  }
}

/** Bilinear sample with longitude wrap and latitude clamp. */
function samplePlane(plane, width, height, u, v) {
  const fx = u * width - 0.5;
  const fy = Math.min(Math.max(v * height - 0.5, 0), height - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const ax = fx - x0;
  const ay = fy - y0;
  const xa = ((x0 % width) + width) % width;
  const xb = (xa + 1) % width;
  const yb = Math.min(y0 + 1, height - 1);
  const top = plane[y0 * width + xa] * (1 - ax) + plane[y0 * width + xb] * ax;
  const bottom =
    plane[yb * width + xa] * (1 - ax) + plane[yb * width + xb] * ax;
  return top * (1 - ay) + bottom * ay;
}

/** Deterministic hash noise in [-0.5, 0.5) for dithering. */
function dither(index, channel) {
  let h = (index * 374761393 + channel * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296 - 0.5;
}

/**
 * Black level with a soft knee: 0 at and below the level, then a quadratic
 * ease that joins the straight line, so faint sky fades out instead of
 * ending in a contour.
 */
export function softBlack(x, knee = SOFT_KNEE) {
  return x <= 0 ? 0 : (x * x) / (x + knee);
}

export function smoothstep(edge0, edge1, x) {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

/**
 * Per pixel, keep `fine` where `weight(luminance of coarse)` is 1 and take
 * `coarse` where it is 0, blending in between. The weight follows the coarse
 * copy, so it is smooth itself and draws no seams along dark lanes. Writes
 * into `fine`.
 */
function blendByBrightness(fine, coarse, weight) {
  const [r] = fine;
  for (let i = 0; i < r.length; i++) {
    const w = weight((coarse[0][i] + coarse[1][i] + coarse[2][i]) / 3);
    for (let c = 0; c < 3; c++)
      fine[c][i] = coarse[c][i] + (fine[c][i] - coarse[c][i]) * w;
  }
}

/** Value at `fraction` of the sorted luminance. */
function luminancePercentile(planes, fraction) {
  const [r, g, b] = planes;
  const lum = new Float32Array(r.length);
  for (let i = 0; i < lum.length; i++) lum[i] = (r[i] + g[i] + b[i]) / 3;
  lum.sort();
  return lum[Math.min(lum.length - 1, Math.floor(fraction * lum.length))];
}

const srgbToLinear = (value) =>
  value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;

async function decodePanorama(sharp, file) {
  const width = WORK_WIDTH;
  const height = WORK_WIDTH / 2;
  const raw = await sharp(file)
    .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
    .removeAlpha()
    .raw()
    .toBuffer();
  const lut = Float32Array.from({ length: 256 }, (_, i) =>
    srgbToLinear(i / 255),
  );
  const planes = [0, 1, 2].map(() => new Float32Array(width * height));
  for (let i = 0; i < width * height; i++)
    for (let c = 0; c < 3; c++) planes[c][i] = lut[raw[i * 3 + c]];
  return { width, height, planes };
}

async function main() {
  const [file] = process.argv.slice(2);
  if (!file) throw new Error('usage: build-milky-way.mjs <eso0932a.tif>');
  const { default: sharp } = await import('sharp');
  const { width, height, planes } = await decodePanorama(sharp, file);
  const sigmaPx = (BLUR_DEG / 180) * height;
  for (const plane of planes) {
    extremumPlane(plane, width, height, OPEN_RADIUS, Math.min);
    extremumPlane(plane, width, height, OPEN_RADIUS, Math.max);
  }
  // After the opening: it sinks the starry sky to the dark gaps between
  // stars, and a fill taken before it would stay brighter than the sky.
  for (const planet of PLANETS) paintOut(planes, width, height, planet);
  const wide = planes.map((plane) => Float32Array.from(plane));
  for (const plane of planes) blurPlane(plane, width, height, sigmaPx);
  for (const plane of wide)
    blurPlane(plane, width, height, (FAINT_BLUR_DEG / 180) * height);
  // Levels from the fine blur, so the blend weight and the output share
  // them; the blend moves the median only in the faint sky it smooths.
  const black = luminancePercentile(planes, BLACK_PERCENTILE);
  const white = luminancePercentile(planes, WHITE_PERCENTILE);
  blendByBrightness(planes, wide, (luminance) =>
    smoothstep(
      FAINT_RANGE[0],
      FAINT_RANGE[1],
      (luminance - black) / (white - black),
    ),
  );
  let total = 0;
  for (const face of CUBE_FACES) {
    const pixels = Buffer.alloc(FACE_SIZE * FACE_SIZE * 3);
    for (let j = 0; j < FACE_SIZE; j++) {
      for (let i = 0; i < FACE_SIZE; i++) {
        const direction = cubeFaceDirection(
          face,
          (i + 0.5) / FACE_SIZE,
          (j + 0.5) / FACE_SIZE,
        );
        const [u, v] = directionToPlateCarree(...icrfToGalactic(direction));
        const index = j * FACE_SIZE + i;
        const rgb = [0, 1, 2].map((c) =>
          samplePlane(planes[c], width, height, u, v),
        );
        const luminance = (rgb[0] + rgb[1] + rgb[2]) / 3;
        const level = softBlack((luminance - black) / (white - black));
        for (let c = 0; c < 3; c++) {
          // Scale every channel by the luminance curve to keep the hue.
          const linear = luminance > 0 ? (rgb[c] / luminance) * level : 0;
          const encoded = Math.min(linear, 1) ** (1 / 2.2) * 255;
          pixels[index * 3 + c] = Math.min(
            255,
            Math.max(0, Math.round(encoded + dither(index, c))),
          );
        }
      }
    }
    const out = path.join(OUT_DIR, `milkyway_${FACE_FILE_SUFFIX[face]}.webp`);
    const info = await sharp(pixels, {
      raw: { width: FACE_SIZE, height: FACE_SIZE, channels: 3 },
    })
      .webp({ quality: WEBP_QUALITY, smartSubsample: true, effort: 6 })
      .toFile(out);
    total += info.size;
    console.log(`${path.relative(process.cwd(), out)}: ${info.size} bytes`);
  }
  console.log(`total ${total} bytes`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
