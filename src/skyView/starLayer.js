/**
 * Star pass of the Sky view overlay.
 *
 * Positions: the whole catalogue is moved to the date in ONE pass per update
 * (every 2 s of sky time or on a time jump/observer change): proper motion
 * (refreshed when the epoch moves by more than PM_REFRESH_YEARS), then a
 * single 3x3 matrix = (equator of date -> local ENU at the sidereal angle) x
 * (IAU 2006 precession), then refraction. The result is an ENU unit vector
 * per star, so each redraw is three dot products per star (the same
 * rectilinear projection as skyMath.projectAzEl, pinned by test).
 *
 * Drawing: pre-rendered sprites per (B-V colour bucket x size step) in one
 * atlas canvas, blitted with drawImage for the brighter stars; faint stars
 * (radius < SPRITE_MIN_R) are batched discs, one fill per colour bucket. Disc radius from magnitude:
 * r = clamp(0.8 + 0.9 * (limMag - mag), 1, 7) px. Faintest drawn magnitude:
 * min(user limit 3..6.5, limMag(Sun altitude)); a wide view (> 70 deg) caps
 * the automatic limit at 5.0 unless the user picked a limit.
 */
import {
  DEG,
  applyProperMotion,
  clamp,
  frustumTangents,
  gmstRad,
  julianCenturies,
  julianYears,
  limMag,
  precessionMatrix,
  radecToVector,
  refractionDeg,
  cameraBasis,
} from './skyMath.js';

export const STAR_UPDATE_MS = 2000;
export const PM_REFRESH_YEARS = 0.1;
export const USER_LIMIT_MIN = 3;
export const USER_LIMIT_MAX = 6.5;
export const WIDE_FOV_DEG = 70;
export const WIDE_FOV_LIMIT = 5.0;
export const STAR_R_MIN = 1;
export const STAR_R_MAX = 7;
/** Sprite size steps (radius in px). */
export const SIZE_STEP = 0.5;
export const SIZE_STEPS = Math.round((STAR_R_MAX - STAR_R_MIN) / SIZE_STEP) + 1;
/** Alpha of a star behind the terrain profile (drawn dimmed). */
export const TERRAIN_ALPHA = 0.35;

/**
 * B-V colour buckets (upper bound, CSS colour). Approximate blackbody star
 * colours: blue-white O/B through white A/F, yellow G, orange K, red M.
 * Unknown B-V (NaN) uses the white bucket.
 */
export const COLOR_BUCKETS = Object.freeze([
  [-0.15, '#a9bfff'],
  [0.15, '#c9d7ff'],
  [0.45, '#f1f2ff'],
  [0.75, '#fff3e4'],
  [1.05, '#ffe2c0'],
  [1.4, '#ffcf9d'],
  [Infinity, '#ffb87a'],
]);
const WHITE_BUCKET = 2;

/** Colour bucket index for a B-V colour index. */
export function colorBucket(bv) {
  if (!Number.isFinite(bv)) return WHITE_BUCKET;
  for (let i = 0; i < COLOR_BUCKETS.length; i++)
    if (bv <= COLOR_BUCKETS[i][0]) return i;
  return COLOR_BUCKETS.length - 1;
}

/** Disc radius in px for a magnitude under a limit. */
export const starRadius = (mag, lim) =>
  clamp(0.8 + 0.9 * (lim - mag), STAR_R_MIN, STAR_R_MAX);

/** Sprite size step for a radius. */
export const sizeStep = (r) =>
  clamp(Math.round((r - STAR_R_MIN) / SIZE_STEP), 0, SIZE_STEPS - 1);

/**
 * Faintest magnitude to draw. userLimit null = automatic (6.5, or 5.0 in a
 * wide view); a user value is clamped to 3..6.5 and never raised past the sky
 * brightness limit, so daylight always hides every star.
 */
export function starLimit({ sunAltDeg, fovDeg, userLimit = null }) {
  const user =
    userLimit == null || !Number.isFinite(Number(userLimit))
      ? fovDeg > WIDE_FOV_DEG
        ? WIDE_FOV_LIMIT
        : USER_LIMIT_MAX
      : clamp(Number(userLimit), USER_LIMIT_MIN, USER_LIMIT_MAX);
  return Math.min(user, limMag(sunAltDeg));
}

/**
 * Row-major 3x3 matrix: J2000 vector -> local East-North-Up of date at a UTC
 * instant and observer (IAU 2006 precession, then the hour-angle rotation of
 * skyMath.equatorialToHorizontal written as a matrix).
 */
export function enuMatrix(ms, latDeg, lonDeg) {
  const p = precessionMatrix(julianCenturies(ms));
  const theta = gmstRad(ms) + lonDeg * DEG;
  const phi = latDeg * DEG;
  const [st, ct, sp, cp] = [
    Math.sin(theta),
    Math.cos(theta),
    Math.sin(phi),
    Math.cos(phi),
  ];
  const a = [
    [-st, ct, 0],
    [-sp * ct, -sp * st, cp],
    [cp * ct, cp * st, sp],
  ];
  return a.map((row) =>
    [0, 1, 2].map(
      (j) => row[0] * p[0][j] + row[1] * p[1][j] + row[2] * p[2][j],
    ),
  );
}

/**
 * Turn a geometric ENU unit vector (in place, at offset i of three arrays)
 * into the apparent (refracted) one; returns the apparent elevation (deg).
 */
function refractInPlace(e, n, u, i) {
  const el = Math.asin(clamp(u[i], -1, 1)) / DEG;
  const app = el + refractionDeg(el);
  const h = Math.hypot(e[i], n[i]);
  const ch = Math.cos(app * DEG);
  if (h > 1e-12) {
    e[i] = (e[i] / h) * ch;
    n[i] = (n[i] / h) * ch;
  }
  u[i] = Math.sin(app * DEG);
  return app;
}

/**
 * Apply a J2000 -> ENU matrix to a set of J2000 unit vectors.
 * @returns {{e: Float32Array, n: Float32Array, u: Float32Array, el: Float32Array}}
 */
export function transformVectors(m, x, y, z, { refraction = true, out } = {}) {
  const count = x.length;
  const e = out?.e ?? new Float32Array(count);
  const n = out?.n ?? new Float32Array(count);
  const u = out?.u ?? new Float32Array(count);
  const el = out?.el ?? new Float32Array(count);
  const [m0, m1, m2] = m;
  for (let i = 0; i < count; i++) {
    const vx = x[i];
    const vy = y[i];
    const vz = z[i];
    e[i] = m0[0] * vx + m0[1] * vy + m0[2] * vz;
    n[i] = m1[0] * vx + m1[1] * vy + m1[2] * vz;
    u[i] = m2[0] * vx + m2[1] * vy + m2[2] * vz;
    el[i] = refraction
      ? refractInPlace(e, n, u, i)
      : Math.asin(clamp(u[i], -1, 1)) / DEG;
  }
  return { e, n, u, el };
}

/** J2000 unit vectors of RA/Dec arrays (degrees). */
export function unitVectors(ra, dec) {
  const count = ra.length;
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  const z = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const v = radecToVector(ra[i], dec[i]);
    x[i] = v[0];
    y[i] = v[1];
    z[i] = v[2];
  }
  return { x, y, z };
}

/**
 * Star position engine for one catalogue. update(ms, observer) recomputes
 * all apparent ENU vectors when STAR_UPDATE_MS of sky time passed (either
 * way), the observer moved, or `force`; returns true when it did.
 */
export function createStarField(stars, { refraction = true } = {}) {
  const count = stars.count;
  const bucket = new Uint8Array(count);
  for (let i = 0; i < count; i++) bucket[i] = colorBucket(stars.bv[i]);
  let pmYears = null;
  let base = null;
  const pos = {
    e: new Float32Array(count),
    n: new Float32Array(count),
    u: new Float32Array(count),
    el: new Float32Array(count),
  };
  let lastMs = null;
  let lastKey = '';
  let matrix = null;
  const field = {
    stars,
    count,
    bucket,
    pos,
    get matrix() {
      return matrix;
    },
    get updatedAt() {
      return lastMs;
    },
    update(ms, observer, { force = false } = {}) {
      const key = `${observer.latDeg},${observer.lonDeg}`;
      if (
        !force &&
        lastMs != null &&
        key === lastKey &&
        Math.abs(ms - lastMs) < STAR_UPDATE_MS
      )
        return false;
      const years = julianYears(ms);
      if (pmYears == null || Math.abs(years - pmYears) > PM_REFRESH_YEARS) {
        const ra = new Float64Array(count);
        const dec = new Float64Array(count);
        for (let i = 0; i < count; i++) {
          const moved = applyProperMotion(
            stars.ra[i],
            stars.dec[i],
            stars.pmRa[i],
            stars.pmDec[i],
            years,
          );
          ra[i] = moved.raDeg;
          dec[i] = moved.decDeg;
        }
        base = unitVectors(ra, dec);
        pmYears = years;
      }
      matrix = enuMatrix(ms, observer.latDeg, observer.lonDeg);
      transformVectors(matrix, base.x, base.y, base.z, {
        refraction,
        out: pos,
      });
      lastMs = ms;
      lastKey = key;
      return true;
    },
  };
  return field;
}

/**
 * A projector for one view and canvas: the same rectilinear projection as
 * skyMath.projectAzEl, on ENU unit vectors. Returns false when behind.
 */
export function makeProjector(view, width, height) {
  const { forward: f, right: r, up: u } = cameraBasis(view);
  const { tx, ty } = frustumTangents(view.fovDeg, width, height);
  const kx = width / 2 / tx;
  const ky = height / 2 / ty;
  const cx = width / 2;
  const cy = height / 2;
  const out = { x: 0, y: 0, z: 0 };
  const project = (e, n, up) => {
    const z = e * f[0] + n * f[1] + up * f[2];
    if (z <= 1e-6) return null;
    out.x = cx + ((e * r[0] + n * r[1] + up * r[2]) / z) * kx;
    out.y = cy - ((e * u[0] + n * u[1] + up * u[2]) / z) * ky;
    out.z = z;
    return out;
  };
  /** Pixels per degree at the centre of the view. */
  project.pxPerDeg = (kx * DEG + ky * DEG) / 2;
  project.width = width;
  project.height = height;
  return project;
}

/** Reusable output arrays for starModel (one set per overlay, no GC churn). */
export function starBuffers(max) {
  return {
    lim: 0,
    count: 0,
    index: new Int32Array(max),
    x: new Float32Array(max),
    y: new Float32Array(max),
    r: new Float32Array(max),
    step: new Uint8Array(max),
    bucket: new Uint8Array(max),
    alpha: new Float32Array(max),
  };
}

/**
 * What the star pass draws: typed arrays of the visible stars, brightest
 * first. Pure. `occlusion(azDeg, elDeg)` -> 'clear' | 'terrain' | 'below'.
 * Pass `buffers` (starBuffers) to reuse the arrays between redraws.
 */
export function starModel(
  field,
  { view, width, height, lim, occlusion, buffers },
) {
  const { stars, pos, bucket } = field;
  const project = makeProjector(view, width, height);
  const max = field.count;
  const out = buffers ?? starBuffers(max);
  out.lim = lim;
  out.count = 0;
  if (!(lim > -30)) return out;
  const margin = STAR_R_MAX + 2;
  // The catalogue is sorted by magnitude: stop at the first star too faint.
  for (let i = 0; i < max; i++) {
    const mag = stars.mag[i];
    if (mag > lim) break;
    if (!(pos.el[i] > 0)) continue;
    const p = project(pos.e[i], pos.n[i], pos.u[i]);
    if (
      !p ||
      p.x < -margin ||
      p.y < -margin ||
      p.x > width + margin ||
      p.y > height + margin
    )
      continue;
    let alpha = 1;
    if (occlusion) {
      const az = Math.atan2(pos.e[i], pos.n[i]) / DEG;
      const state = occlusion(az < 0 ? az + 360 : az, pos.el[i]);
      if (state === 'below') continue;
      if (state === 'terrain') alpha = TERRAIN_ALPHA;
    }
    const r = starRadius(mag, lim);
    const k = out.count++;
    out.index[k] = i;
    out.x[k] = p.x;
    out.y[k] = p.y;
    out.r[k] = r;
    out.step[k] = sizeStep(r);
    out.bucket[k] = bucket[i];
    out.alpha[k] = alpha;
  }
  return out;
}

/** Sprite cell size (CSS px) for a size step: the disc plus a soft edge. */
export const spriteCell = (step) =>
  Math.ceil(2 * (STAR_R_MIN + step * SIZE_STEP) + 4);

/**
 * Pre-render every (colour bucket x size step) sprite into one atlas canvas.
 * createCanvas(w, h) returns a canvas (DOM or OffscreenCanvas).
 * @returns {?{canvas, ratio, cells: Array<Array<{sx, sy, size}>>}}
 */
export function createSpriteAtlas(createCanvas, ratio = 1) {
  const cellMax = spriteCell(SIZE_STEPS - 1);
  const px = Math.ceil(cellMax * ratio);
  const canvas = createCanvas?.(px * SIZE_STEPS, px * COLOR_BUCKETS.length);
  const ctx = canvas?.getContext?.('2d');
  if (!ctx) return null;
  const cells = [];
  COLOR_BUCKETS.forEach(([, colour], b) => {
    const row = [];
    for (let s = 0; s < SIZE_STEPS; s++) {
      const r = (STAR_R_MIN + s * SIZE_STEP) * ratio;
      const size = Math.ceil(spriteCell(s) * ratio);
      const sx = s * px;
      const sy = b * px;
      const c = size / 2;
      const g = ctx.createRadialGradient(
        sx + c,
        sy + c,
        0,
        sx + c,
        sy + c,
        r + ratio,
      );
      g.addColorStop(0, '#ffffff');
      g.addColorStop(Math.min(0.9, 0.35 + 0.08 * s), colour);
      g.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(sx + c, sy + c, r + ratio, 0, Math.PI * 2);
      ctx.fill();
      row.push({ sx, sy, size });
    }
    cells.push(row);
  });
  return { canvas, ratio, cells };
}

/**
 * Stars at least this big (radius, px) are blitted from the sprite atlas
 * (soft glow); smaller ones are filled as discs, batched into one path per
 * (colour bucket x alpha) so a few hundred faint stars cost a handful of fill
 * calls instead of one drawImage each (the mid-phone budget, item 6).
 */
export const SPRITE_MIN_R = 3;

/**
 * Paint the star model. Returns how many stars were drawn.
 * Without an atlas every star is a batched disc.
 */
export function drawStars(ctx, model, atlas) {
  if (!model.count) return 0;
  ctx.save();
  const minSprite = atlas ? SPRITE_MIN_R : Infinity;
  // small stars: one path per (bucket, alpha)
  for (let b = 0; b < COLOR_BUCKETS.length; b++) {
    for (const alpha of [1, TERRAIN_ALPHA]) {
      let open = false;
      for (let k = 0; k < model.count; k++) {
        if (model.bucket[k] !== b || model.r[k] >= minSprite) continue;
        if (Math.abs(model.alpha[k] - alpha) > 1e-3) continue;
        if (!open) {
          ctx.beginPath();
          open = true;
        }
        const r = model.r[k];
        ctx.moveTo(model.x[k] + r, model.y[k]);
        ctx.arc(model.x[k], model.y[k], r, 0, Math.PI * 2);
      }
      if (open) {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = COLOR_BUCKETS[b][1];
        ctx.fill();
      }
    }
  }
  // bright stars: sprites
  if (atlas) {
    for (let k = 0; k < model.count; k++) {
      if (model.r[k] < minSprite) continue;
      ctx.globalAlpha = model.alpha[k];
      const cell = atlas.cells[model.bucket[k]][model.step[k]];
      const size = cell.size / atlas.ratio;
      ctx.drawImage(
        atlas.canvas,
        cell.sx,
        cell.sy,
        cell.size,
        cell.size,
        model.x[k] - size / 2,
        model.y[k] - size / 2,
        size,
        size,
      );
    }
  }
  ctx.restore();
  return model.count;
}
