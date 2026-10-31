/**
 * Constellations for the Sky view overlay:
 * stick-figure lines between catalogue stars (the same apparent positions
 * the star pass draws), names at the unit-vector mean of each figure's line
 * stars, optional IAU boundaries (J2000 polylines precessed from B1875 at
 * build time) and proper star names. Models are pure; drawing is separate.
 */
import { DEG, cameraBasis, frustumTangents } from './skyMath.js';
import {
  TERRAIN_ALPHA,
  makeProjector,
  transformVectors,
  unitVectors,
} from './starLayer.js';

/**
 * Static geometry from the parsed catalogue: segment pairs and the J2000
 * unit-vector mean of each figure's distinct line stars.
 */
export function prepareConstellations(constellations, stars) {
  const pairs = [];
  const owner = [];
  const cx = new Float64Array(constellations.length);
  const cy = new Float64Array(constellations.length);
  const cz = new Float64Array(constellations.length);
  constellations.forEach((c, k) => {
    const members = new Set();
    for (const chain of c.lines) {
      for (let i = 0; i < chain.length; i++) {
        members.add(chain[i]);
        if (i) {
          pairs.push(chain[i - 1], chain[i]);
          owner.push(k);
        }
      }
    }
    let x = 0;
    let y = 0;
    let z = 0;
    for (const index of members) {
      const ra = stars.ra[index] * DEG;
      const dec = stars.dec[index] * DEG;
      x += Math.cos(dec) * Math.cos(ra);
      y += Math.cos(dec) * Math.sin(ra);
      z += Math.sin(dec);
    }
    const len = Math.hypot(x, y, z) || 1;
    cx[k] = x / len;
    cy[k] = y / len;
    cz[k] = z / len;
  });
  return {
    list: constellations,
    pairs: Int32Array.from(pairs),
    owner: Int32Array.from(owner),
    centroid: { x: cx, y: cy, z: cz },
  };
}

/** J2000 unit vectors of every boundary point, one flat set per edge. */
export function prepareBoundaries(edges) {
  return edges.map((edge) => {
    const vectors = unitVectors(edge.ra, edge.dec);
    return { a: edge.a, b: edge.b, vectors, cap: boundingCap(vectors) };
  });
}

/**
 * A cap (centre unit vector + angular radius, radians) holding every point
 * of a polyline: the model skips whole edges outside the view cone.
 */
export function boundingCap({ x, y, z }) {
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < x.length; i++) {
    cx += x[i];
    cy += y[i];
    cz += z[i];
  }
  const len = Math.hypot(cx, cy, cz);
  if (!(len > 1e-9)) return null;
  cx /= len;
  cy /= len;
  cz /= len;
  let minDot = 1;
  for (let i = 0; i < x.length; i++)
    minDot = Math.min(minDot, cx * x[i] + cy * y[i] + cz * z[i]);
  return {
    x: cx,
    y: cy,
    z: cz,
    radius: Math.acos(Math.max(-1, Math.min(1, minDot))),
  };
}

/**
 * Extra angle (radians) around an edge's cap before it is culled: covers
 * refraction (<= 0.6 deg lift) and the off-canvas pad.
 */
export const CAP_MARGIN = 2 * DEG;

/**
 * Move the label anchors and boundaries to the field's current matrix
 * (call after field.update()); returns apparent ENU sets.
 */
export function positionConstellations(prepared, boundaries, matrix) {
  const { x, y, z } = prepared.centroid;
  const [m0, m1, m2] = matrix;
  return {
    centroids: transformVectors(matrix, x, y, z),
    boundaries: (boundaries || []).map((edge) => {
      const out = transformVectors(
        matrix,
        edge.vectors.x,
        edge.vectors.y,
        edge.vectors.z,
      );
      const c = edge.cap;
      // the cap centre in ENU (unrefracted; CAP_MARGIN covers refraction)
      if (c)
        out.cap = {
          e: m0[0] * c.x + m0[1] * c.y + m0[2] * c.z,
          n: m1[0] * c.x + m1[1] * c.y + m1[2] * c.z,
          u: m2[0] * c.x + m2[1] * c.y + m2[2] * c.z,
          radius: c.radius,
        };
      return out;
    }),
  };
}

/** The constellation-name label text (Latin, as Stellarium shows it). */
export const constellationLabel = (c) => c.native || c.name || c.iau;

/**
 * What to draw. Pure.
 * @returns {{segments: number[], names: Array, boundaries: number[][]}}
 *   segments is flat [x1, y1, x2, y2, ...]; each boundary run is a flat
 *   [x, y, x, y, ...] polyline (few objects per frame: no GC spikes).
 */
export function constellationModel(
  prepared,
  positioned,
  field,
  {
    view,
    width,
    height,
    lines = true,
    names = true,
    boundaries = false,
    occlusion = null,
  },
) {
  const project = makeProjector(view, width, height);
  const { pos } = field;
  const segments = [];
  // segments with an end behind the terrain profile: drawn dimmed
  const dimSegments = [];
  const behind = (e, n, el) => {
    if (!occlusion) return false;
    const az = Math.atan2(e, n) / DEG;
    return occlusion(az < 0 ? az + 360 : az, el) === 'terrain';
  };
  if (lines) {
    const { pairs } = prepared;
    for (let k = 0; k < pairs.length; k += 2) {
      const a = pairs[k];
      const b = pairs[k + 1];
      if (!(pos.el[a] > 0 && pos.el[b] > 0)) continue;
      const pa = project(pos.e[a], pos.n[a], pos.u[a]);
      if (!pa) continue;
      const ax = pa.x;
      const ay = pa.y;
      const pb = project(pos.e[b], pos.n[b], pos.u[b]);
      if (!pb) continue;
      // skip segments entirely off one side of the canvas
      if (
        (ax < 0 && pb.x < 0) ||
        (ay < 0 && pb.y < 0) ||
        (ax > width && pb.x > width) ||
        (ay > height && pb.y > height)
      )
        continue;
      const out =
        behind(pos.e[a], pos.n[a], pos.el[a]) ||
        behind(pos.e[b], pos.n[b], pos.el[b])
          ? dimSegments
          : segments;
      out.push(ax, ay, pb.x, pb.y);
    }
  }
  const nameList = [];
  if (names && positioned) {
    const c = positioned.centroids;
    prepared.list.forEach((entry, k) => {
      if (!(c.el[k] > 0)) return;
      let alpha = 1;
      if (occlusion) {
        const az = Math.atan2(c.e[k], c.n[k]) / DEG;
        const state = occlusion(az < 0 ? az + 360 : az, c.el[k]);
        if (state === 'below') return;
        if (state === 'terrain') alpha = TERRAIN_ALPHA;
      }
      const p = project(c.e[k], c.n[k], c.u[k]);
      if (!p || p.x < 0 || p.y < 0 || p.x > width || p.y > height) return;
      nameList.push({
        iau: entry.iau,
        text: constellationLabel(entry),
        x: p.x,
        y: p.y,
        alpha,
      });
    });
  }
  const runs = [];
  if (boundaries && positioned?.boundaries?.length) {
    const far = Math.max(width, height) * 20;
    // only the segments that can touch the canvas (a box test, so nothing
    // visible is dropped): most of the 781 edges' points are off screen
    const pad = BOUNDARY_CULL_PAD;
    // whole edges outside the view cone (or below the horizon) are skipped
    // before any point is projected
    const { forward: f } = cameraBasis(view);
    const { tx, ty } = frustumTangents(view.fovDeg, width, height);
    const halfDiag = Math.atan(Math.hypot(tx, ty));
    for (const edge of positioned.boundaries) {
      const cap = edge.cap;
      if (cap) {
        const reach = halfDiag + cap.radius + CAP_MARGIN;
        const dot = cap.e * f[0] + cap.n * f[1] + cap.u * f[2];
        if (reach < Math.PI && dot < Math.cos(reach)) continue;
        if (
          Math.asin(Math.max(-1, Math.min(1, cap.u))) +
            cap.radius +
            CAP_MARGIN <
          0
        )
          continue;
      }
      let run = [];
      let havePrev = false;
      let px = 0;
      let py = 0;
      for (let i = 0; i < edge.el.length; i++) {
        const p =
          edge.el[i] > 0 ? project(edge.e[i], edge.n[i], edge.u[i]) : null;
        const ok = p && Math.abs(p.x) < far && Math.abs(p.y) < far;
        const x = ok ? p.x : 0;
        const y = ok ? p.y : 0;
        if (
          ok &&
          havePrev &&
          !(
            (px < -pad && x < -pad) ||
            (py < -pad && y < -pad) ||
            (px > width + pad && x > width + pad) ||
            (py > height + pad && y > height + pad)
          )
        ) {
          if (!run.length) run.push(px, py);
          run.push(x, y);
        } else if (run.length) {
          if (run.length > 2) runs.push(run);
          run = [];
        }
        havePrev = Boolean(ok);
        px = x;
        py = y;
      }
      if (run.length > 2) runs.push(run);
    }
  }
  return { segments, dimSegments, names: nameList, boundaries: runs };
}

/**
 * Faintest star that gets its proper name: fewer names in a wide view.
 * (UX rule: <= 1.5 above 60 deg fov, <= 2.5 above 30, <= 4.0 closer in.)
 */
export const starNameLimit = (fovDeg, lim) =>
  Math.min(lim, fovDeg > 60 ? 1.5 : fovDeg > 30 ? 2.5 : 4.0);

/** Proper-name label candidates among the stars the star pass drew. */
export function starNameCandidates(field, model, { fovDeg }) {
  const out = [];
  const limit = starNameLimit(fovDeg, model.lim);
  const { names } = field.stars;
  for (let k = 0; k < model.count; k++) {
    const index = model.index[k];
    const mag = field.stars.mag[index];
    if (mag > limit) break;
    const text = names.get(index);
    if (!text) continue;
    out.push({
      index,
      text,
      mag,
      x: model.x[k] + model.r[k] + 3,
      y: model.y[k],
      alpha: model.alpha ? model.alpha[k] : 1,
    });
  }
  return out;
}

/** Pixels a boundary may run outside the canvas before it is cut. */
export const BOUNDARY_CULL_PAD = 8;

export const LINE_STYLE = 'rgba(120, 170, 235, 0.55)';
export const BOUNDARY_STYLE = 'rgba(200, 160, 90, 0.35)';

/** Paint lines and boundaries (labels are drawn by the label pass). */
export function drawConstellations(ctx, model) {
  let calls = 0;
  ctx.save();
  if (model.boundaries.length) {
    // solid, not dashed: dash path effects are slow on phone canvases
    ctx.strokeStyle = BOUNDARY_STYLE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const run of model.boundaries) {
      ctx.moveTo(run[0], run[1]);
      for (let i = 2; i < run.length; i += 2) ctx.lineTo(run[i], run[i + 1]);
      calls++;
    }
    ctx.stroke();
  }
  const strokeSegments = (s, alpha) => {
    if (!s?.length) return;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = LINE_STYLE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = 0; k < s.length; k += 4) {
      ctx.moveTo(s[k], s[k + 1]);
      ctx.lineTo(s[k + 2], s[k + 3]);
      calls++;
    }
    ctx.stroke();
  };
  strokeSegments(model.segments, 1);
  strokeSegments(model.dimSegments, TERRAIN_ALPHA);
  ctx.globalAlpha = 1;
  ctx.restore();
  return calls;
}
