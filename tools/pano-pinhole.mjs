#!/usr/bin/env node
/**
 * pano-pinhole.mjs
 *
 * Reprojects an equirectangular panorama image into a pinhole camera view.
 * Uses inverse mapping (iterates output pixels) so every output pixel gets
 * a bilinear-interpolated sample from the panorama — no holes possible.
 *
 * Usage:
 *   node tools/pano-pinhole.mjs --input output/panorama_30.266476_-97.73719.jpg --heading 270 --pitch -10 --hfov 90
 *   node tools/pano-pinhole.mjs --input output/panorama_30.266476_-97.73719.jpg --heading 180 --pitch 0 --hfov 60 --width 2560 --height 1440
 *   node tools/pano-pinhole.mjs --input output/panorama_30.266476_-97.73719.jpg --heading 90 --focal 800 --width 1920 --height 1080
 *   node tools/pano-pinhole.mjs --input output/panorama_30.266476_-97.73719.jpg --all --hfov 90
 *
 * Options:
 *   --input    Path to equirectangular panorama JPEG (required)
 *   --heading  Compass heading in degrees, 0=N 90=E 180=S 270=W (default: 0)
 *   --pitch    Camera pitch in degrees, 0=horizon, positive=up (default: 0)
 *   --roll     Camera roll in degrees, positive=CW (default: 0)
 *   --hfov     Horizontal field of view in degrees (default: 90)
 *   --focal    Focal length in pixels (overrides --hfov if both given)
 *   --width    Output width in pixels (default: 1920)
 *   --height   Output height in pixels (default: 1080)
 *   --step     Heading step in degrees for --all mode (default: 45)
 *   --all      Render all compass headings (8 images at 45° steps by default)
 *   --outdir   Output directory (default: output/)
 *
 * Coordinate convention:
 *   The equirectangular panorama has longitude 0 (center column) = North,
 *   +90 = East, ±180 = South, -90 = West. Latitude +90 = up (zenith),
 *   -90 = down (nadir). This matches Google Street View convention where
 *   heading 0 = North.
 *
 * Dependencies: sharp (devDependency)
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectRoot } from '../scripts/project-root.mjs';
import sharp from 'sharp';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = projectRoot(import.meta.url);

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    heading: 0, pitch: 0, roll: 0, hfov: 90,
    width: 1920, height: 1080, step: 45, all: false, outdir: 'output',
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--input':   opts.input = args[++i]; break;
      case '--heading':  opts.heading = parseFloat(args[++i]); break;
      case '--pitch':    opts.pitch = parseFloat(args[++i]); break;
      case '--roll':     opts.roll = parseFloat(args[++i]); break;
      case '--hfov':     opts.hfov = parseFloat(args[++i]); break;
      case '--focal':    opts.focal = parseFloat(args[++i]); break;
      case '--width':    opts.width = parseInt(args[++i], 10); break;
      case '--height':   opts.height = parseInt(args[++i], 10); break;
      case '--step':     opts.step = parseInt(args[++i], 10); break;
      case '--all':      opts.all = true; break;
      case '--outdir':   opts.outdir = args[++i]; break;
      case '--help':
        console.log([
          'Usage: node tools/pano-pinhole.mjs --input <panorama.jpg> [options]',
          '',
          'Required:',
          '  --input    Equirectangular panorama image path',
          '',
          'Camera:',
          '  --heading  Compass heading degrees, 0=N 90=E (default: 0)',
          '  --pitch    Pitch degrees, 0=horizon +up (default: 0)',
          '  --roll     Roll degrees, +CW (default: 0)',
          '  --hfov     Horizontal FOV degrees (default: 90)',
          '  --focal    Focal length in pixels (overrides --hfov)',
          '',
          'Output:',
          '  --width    Output width pixels (default: 1920)',
          '  --height   Output height pixels (default: 1080)',
          '  --all      Render all compass headings (ignores --heading)',
          '  --step     Heading step degrees for --all mode (default: 45)',
          '  --outdir   Output directory (default: output/)',
        ].join('\n'));
        process.exit(0);
    }
  }

  if (!opts.input) {
    console.error('Error: --input is required.');
    process.exit(1);
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Bilinear sample from raw pixel buffer
// ---------------------------------------------------------------------------

/**
 * Sample the equirectangular panorama at fractional pixel coords (u, v)
 * using bilinear interpolation. Wraps horizontally for panorama continuity.
 *
 * @param {Buffer} buf  Raw RGB pixel buffer (3 bytes per pixel)
 * @param {number} pW   Panorama width
 * @param {number} pH   Panorama height
 * @param {number} u    Fractional x coord [0, pW)
 * @param {number} v    Fractional y coord [0, pH)
 * @returns {[number, number, number]} RGB values [0-255]
 */
function sampleBilinear(buf, pW, pH, u, v) {
  // Wrap u horizontally (panorama is cyclical in x)
  u = ((u % pW) + pW) % pW;

  // Clamp v vertically (poles don't wrap)
  v = Math.max(0, Math.min(v, pH - 1.001));

  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const x1 = (x0 + 1) % pW;  // wrap horizontally
  const y1 = Math.min(y0 + 1, pH - 1);

  const fx = u - x0;
  const fy = v - y0;

  // Four corner pixel offsets (RGB, 3 bytes per pixel)
  const i00 = (y0 * pW + x0) * 3;
  const i10 = (y0 * pW + x1) * 3;
  const i01 = (y1 * pW + x0) * 3;
  const i11 = (y1 * pW + x1) * 3;

  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;

  const r = buf[i00] * w00 + buf[i10] * w10 + buf[i01] * w01 + buf[i11] * w11;
  const g = buf[i00 + 1] * w00 + buf[i10 + 1] * w10 + buf[i01 + 1] * w01 + buf[i11 + 1] * w11;
  const b = buf[i00 + 2] * w00 + buf[i10 + 2] * w10 + buf[i01 + 2] * w01 + buf[i11 + 2] * w11;

  return [Math.round(r), Math.round(g), Math.round(b)];
}

// ---------------------------------------------------------------------------
// Rotation matrix construction
// ---------------------------------------------------------------------------

/**
 * Build a 3x3 rotation matrix from heading, pitch, and roll (in radians).
 *
 * Convention (right-hand rule, Y-up world):
 *   - Heading (yaw): rotation about Y axis. 0=North(+Z), 90=East(+X)
 *   - Pitch: rotation about X axis. Positive = look up.
 *   - Roll: rotation about Z axis. Positive = clockwise from camera's POV.
 *
 * Camera forward in camera space is (0, 0, 1) = +Z.
 * World axes: X=East, Y=Up, Z=North.
 *
 * Combined: R = Ry(heading) * Rx(-pitch) * Rz(roll)
 *
 * Returns a function that transforms a camera-space vector to world-space.
 */
function buildRotationMatrix(headingRad, pitchRad, rollRad) {
  const ch = Math.cos(headingRad);
  const sh = Math.sin(headingRad);
  const cp = Math.cos(-pitchRad);
  const sp = Math.sin(-pitchRad);
  const cr = Math.cos(rollRad);
  const sr = Math.sin(rollRad);

  // Ry(heading)
  // [ ch  0  sh]
  // [  0  1   0]
  // [-sh  0  ch]

  // Rx(-pitch)
  // [1   0    0 ]
  // [0  cp  -sp ]
  // [0  sp   cp ]

  // Rz(roll)
  // [cr  -sr  0]
  // [sr   cr  0]
  // [ 0    0  1]

  // Combined R = Ry * Rx * Rz (multiply out)
  const m00 = ch * cr + sh * sp * sr;
  const m01 = -ch * sr + sh * sp * cr;
  const m02 = sh * cp;
  const m10 = cp * sr;
  const m11 = cp * cr;
  const m12 = -sp;
  const m20 = -sh * cr + ch * sp * sr;
  const m21 = sh * sr + ch * sp * cr;
  const m22 = ch * cp;

  return (x, y, z) => [
    m00 * x + m01 * y + m02 * z,
    m10 * x + m11 * y + m12 * z,
    m20 * x + m21 * y + m22 * z,
  ];
}

// ---------------------------------------------------------------------------
// Compass direction labels
// ---------------------------------------------------------------------------

const COMPASS_NAMES = {
  0: 'N', 15: 'NNE', 30: 'NNE2', 45: 'NE', 60: 'ENE', 75: 'ENE2',
  90: 'E', 105: 'ESE', 120: 'ESE2', 135: 'SE', 150: 'SSE', 165: 'SSE2',
  180: 'S', 195: 'SSW', 210: 'SSW2', 225: 'SW', 240: 'WSW', 255: 'WSW2',
  270: 'W', 285: 'WNW', 300: 'WNW2', 315: 'NW', 330: 'NNW', 345: 'NNW2',
};

// ---------------------------------------------------------------------------
// Render a single pinhole view from the panorama
// ---------------------------------------------------------------------------

/**
 * @param {Buffer} panoBuf  Raw RGB panorama pixels
 * @param {number} pW       Panorama width
 * @param {number} pH       Panorama height
 * @param {number} heading  Heading in degrees
 * @param {number} pitch    Pitch in degrees
 * @param {number} roll     Roll in degrees
 * @param {number} focalPx  Focal length in pixels
 * @param {number} outW     Output width
 * @param {number} outH     Output height
 * @returns {Buffer}        Raw RGB output buffer
 */
function renderView(panoBuf, pW, pH, heading, pitch, roll, focalPx, outW, outH) {
  const headingRad = heading * Math.PI / 180;
  const pitchRad = pitch * Math.PI / 180;
  const rollRad = roll * Math.PI / 180;
  const rotate = buildRotationMatrix(headingRad, pitchRad, rollRad);

  const outBuf = Buffer.alloc(outW * outH * 3);
  const halfW = outW / 2;
  const halfH = outH / 2;

  for (let py = 0; py < outH; py++) {
    for (let px = 0; px < outW; px++) {
      const camX = (px - halfW + 0.5);
      const camY = -(py - halfH + 0.5);
      const camZ = focalPx;

      const len = Math.sqrt(camX * camX + camY * camY + camZ * camZ);
      const nx = camX / len;
      const ny = camY / len;
      const nz = camZ / len;

      const [wx, wy, wz] = rotate(nx, ny, nz);

      const lon = Math.atan2(wx, wz);
      const lat = Math.asin(Math.max(-1, Math.min(1, wy)));

      const u = ((lon / Math.PI + 1) / 2) * pW;
      const v = (0.5 - lat / Math.PI) * pH;

      const [r, g, b] = sampleBilinear(panoBuf, pW, pH, u, v);

      const outIdx = (py * outW + px) * 3;
      outBuf[outIdx] = r;
      outBuf[outIdx + 1] = g;
      outBuf[outIdx + 2] = b;
    }
  }

  return outBuf;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();

  // Compute focal length from hfov, or use provided focal
  let focalPx;
  if (opts.focal !== undefined) {
    focalPx = opts.focal;
  } else {
    const hfovRad = opts.hfov * Math.PI / 180;
    focalPx = (opts.width / 2) / Math.tan(hfovRad / 2);
  }

  // Build list of headings to render
  const headings = [];
  if (opts.all) {
    for (let h = 0; h < 360; h += opts.step) {
      headings.push(h);
    }
  } else {
    headings.push(opts.heading);
  }

  const fovLabel = opts.focal !== undefined
    ? `f${Math.round(opts.focal)}`
    : `fov${Math.round(opts.hfov)}`;
  const hfovDeg = 2 * Math.atan((opts.width / 2) / focalPx) * 180 / Math.PI;

  console.log('\nPano → Pinhole Renderer');
  console.log(`  Input    : ${opts.input}`);
  console.log(`  Mode     : ${opts.all ? `all headings (${headings.length} views, step ${opts.step}°)` : `heading ${opts.heading}°`}`);
  console.log(`  Pitch    : ${opts.pitch}°`);
  if (opts.roll !== 0) console.log(`  Roll     : ${opts.roll}°`);
  console.log(`  HFOV     : ${hfovDeg.toFixed(1)}° (focal ≈ ${focalPx.toFixed(1)} px)`);
  console.log(`  Output   : ${opts.width}x${opts.height}`);

  // Load panorama once
  console.log('\nLoading panorama...');
  const inputPath = resolve(opts.input);
  const panoImage = sharp(inputPath);
  const meta = await panoImage.metadata();
  const pW = meta.width;
  const pH = meta.height;
  console.log(`  Panorama : ${pW}x${pH}`);

  const panoBuf = await panoImage
    .removeAlpha()
    .raw()
    .toBuffer();

  const outdir = resolve(PROJECT_ROOT, opts.outdir);
  mkdirSync(outdir, { recursive: true });

  const inputBase = basename(opts.input, extname(opts.input));
  const outW = opts.width;
  const outH = opts.height;

  console.log(`\nRendering ${headings.length} view(s)...`);
  const t0 = performance.now();

  for (const heading of headings) {
    const t1 = performance.now();
    const outBuf = renderView(panoBuf, pW, pH, heading, opts.pitch, opts.roll, focalPx, outW, outH);
    const renderMs = (performance.now() - t1).toFixed(0);

    const compassLabel = COMPASS_NAMES[heading] || `H${heading}`;
    const outName = `pinhole_${inputBase}_h${heading}_p${opts.pitch}_${fovLabel}_${outW}x${outH}_${compassLabel}.jpg`;
    const outPath = join(outdir, outName);

    await sharp(outBuf, { raw: { width: outW, height: outH, channels: 3 } })
      .jpeg({ quality: 92 })
      .toFile(outPath);

    console.log(`  ${compassLabel.padEnd(4)} (${String(heading).padStart(3)}°): ${outName}  (${renderMs}ms)`);
  }

  const totalElapsed = ((performance.now() - t0) / 1000).toFixed(2);
  console.log(`\n  Total: ${headings.length} images in ${totalElapsed}s`);

  // Report camera parameters
  const vfov = 2 * Math.atan((outH / 2) / focalPx) * 180 / Math.PI;
  const diagPx = Math.sqrt(outW * outW + outH * outH);
  const dfov = 2 * Math.atan((diagPx / 2) / focalPx) * 180 / Math.PI;
  console.log(`  Horizontal FOV : ${hfovDeg.toFixed(1)}°`);
  console.log(`  Vertical FOV   : ${vfov.toFixed(1)}°`);
  console.log(`  Diagonal FOV   : ${dfov.toFixed(1)}°`);
  console.log(`  Focal length   : ${focalPx.toFixed(1)} px`);
}

main().catch((err) => {
  console.error('\nError:', err.message);
  process.exit(1);
});
