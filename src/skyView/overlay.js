/**
 * Sky view Canvas overlay: cardinal labels and 8-point ticks on the
 * horizon, an optional alt/az grid, a compass strip at the bottom, and the
 * flat-horizon ground. All text is drawn here, never with Cesium labels
 * (noCesiumLabels.test). overlayModel() is pure (tested); drawOverlay() only
 * paints the model.
 */
import {
  cameraBasis,
  enuFromAzEl,
  fovAngles,
  frustumTangents,
  normalizeAz,
  skyGradient,
  twilightWash,
} from './skyMath.js';

export const CARDINALS = Object.freeze([
  ['N', 0],
  ['NE', 45],
  ['E', 90],
  ['SE', 135],
  ['S', 180],
  ['SW', 225],
  ['W', 270],
  ['NW', 315],
]);
export const GRID_EL_STEP = 15;
export const GRID_AZ_STEP = 30;

const onCanvas = (p, width, height, margin = 40) =>
  p &&
  p.x >= -margin &&
  p.x <= width + margin &&
  p.y >= -margin &&
  p.y <= height + margin;

/** Signed smallest difference a - b in degrees, in (-180, 180]. */
export function azDelta(a, b) {
  let d = normalizeAz(a) - normalizeAz(b);
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/**
 * skyMath.projectAzEl for many directions of one view: the camera basis and
 * frustum are computed once per redraw instead of once per point (the grid is
 * ~1,600 points; per-point bases were the grid's main cost on the throttled
 * mid-phone profile). Same arithmetic, so results are bit-identical.
 * Takes an ENU unit vector, returns canvas pixels or null when behind.
 */
export function viewProjector(view, width, height) {
  const { forward: f, right: r, up: u } = cameraBasis(view);
  const { tx, ty } = frustumTangents(view.fovDeg, width, height);
  return (d) => {
    const z = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
    if (z <= 1e-6) return null;
    const x = (d[0] * r[0] + d[1] * r[1] + d[2] * r[2]) / z / tx;
    const y = (d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) / z / ty;
    return { x: ((x + 1) / 2) * width, y: ((1 - y) / 2) * height };
  };
}

// The alt/az grid never changes in ENU: build its unit vectors once.
let gridEnu = null;
function gridLinesEnu() {
  if (gridEnu) return gridEnu;
  const lines = [];
  for (let el = GRID_EL_STEP; el < 90; el += GRID_EL_STEP) {
    const points = [];
    for (let az = 0; az <= 360; az += 2) points.push(enuFromAzEl(az, el));
    lines.push({ kind: 'alt', value: el, points });
  }
  for (let az = 0; az < 360; az += GRID_AZ_STEP) {
    const points = [];
    for (let el = 0; el <= 88; el += 2) points.push(enuFromAzEl(az, el));
    lines.push({ kind: 'az', value: az, points });
  }
  gridEnu = lines;
  return gridEnu;
}

/**
 * Does the segment (a, b) possibly touch the canvas grown by `pad`? A box
 * test: conservative (never drops a segment that crosses the canvas).
 */
export const segmentNearCanvas = (ax, ay, bx, by, width, height, pad) =>
  !(
    (ax < -pad && bx < -pad) ||
    (ay < -pad && by < -pad) ||
    (ax > width + pad && bx > width + pad) ||
    (ay > height + pad && by > height + pad)
  );

/** Pixels a polyline may run outside the canvas before it is cut (> line width). */
export const CULL_PAD = 8;

/**
 * Like curve(), but only the segments that can touch the canvas: the grid's
 * off-screen parts (most of every alt circle) cost stroke work for nothing.
 * The drawn pixels are the same as stroking the whole curve.
 */
export function visibleRuns(points, project, width, height, pad = CULL_PAD) {
  const runs = [];
  let run = [];
  let prev = null;
  for (const d of points) {
    const p = project(d);
    const ok = p && Math.abs(p.x) < width * 20 && Math.abs(p.y) < height * 20;
    if (
      ok &&
      prev &&
      segmentNearCanvas(prev.x, prev.y, p.x, p.y, width, height, pad)
    ) {
      if (!run.length) run.push(prev);
      run.push(p);
    } else if (run.length) {
      if (run.length > 1) runs.push(run);
      run = [];
    }
    prev = ok ? p : null;
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

/** Polyline of projected points along a curve, split where it leaves the view. */
function curve(points, project, width, height) {
  const runs = [];
  let run = [];
  for (const d of points) {
    const p = project(d);
    if (p && Math.abs(p.x) < width * 20 && Math.abs(p.y) < height * 20)
      run.push(p);
    else {
      if (run.length > 1) runs.push(run);
      run = [];
    }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

/**
 * What to draw, in canvas pixels. Pure.
 * @returns {{horizon: Array, ground: ?Array, cardinals: Array, grid: Array,
 *   compass: Array, gradient: ?object}}
 */
export function overlayModel({
  view,
  width,
  height,
  grid = false,
  flatHorizon = false,
  sunAltDeg = null,
}) {
  const project = viewProjector(view, width, height);
  const span = [];
  for (let d = -89; d <= 89; d += 1) span.push(enuFromAzEl(view.azDeg + d, 0));
  const horizonRuns = curve(span, project, width, height);
  const horizon = horizonRuns[0] || [];

  let ground = null;
  if (flatHorizon && horizon.length > 1) {
    // Close the horizon line down to the bottom of the canvas (it is a straight
    // line in a rectilinear view, so extend it past both sides first).
    const a = horizon[0];
    const b = horizon.at(-1);
    const far = Math.max(width, height) * 30;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const left = { x: a.x - (dx / len) * far, y: a.y - (dy / len) * far };
    const right = { x: b.x + (dx / len) * far, y: b.y + (dy / len) * far };
    ground = [
      left,
      ...horizon,
      right,
      { x: right.x, y: height + far },
      { x: left.x, y: height + far },
    ];
  }

  const cardinals = [];
  for (const [label, az] of CARDINALS) {
    const p = project(enuFromAzEl(az, 0));
    if (onCanvas(p, width, height, 0))
      cardinals.push({
        label,
        azDeg: az,
        x: p.x,
        y: p.y,
        major: label.length === 1,
      });
  }

  const lines = [];
  if (grid) {
    for (const line of gridLinesEnu())
      for (const run of visibleRuns(line.points, project, width, height))
        lines.push({ kind: line.kind, value: line.value, points: run });
  }

  // Compass strip: linear in azimuth across the horizontal fov.
  const { horizontalDeg } = fovAngles(view.fovDeg, width, height);
  const step = horizontalDeg > 60 ? 15 : horizontalDeg > 20 ? 5 : 1;
  const compass = [];
  const half = horizontalDeg / 2;
  const first = Math.ceil((view.azDeg - half) / step) * step;
  for (let az = first; az <= view.azDeg + half + 1e-9; az += step) {
    const x = width / 2 + (azDelta(az, view.azDeg) / horizontalDeg) * width;
    const a = normalizeAz(az);
    const cardinal = CARDINALS.find(([, value]) => Math.abs(value - a) < 1e-9);
    compass.push({
      azDeg: a,
      x,
      label: cardinal
        ? cardinal[0]
        : a % (step * 2) === 0
          ? String(Math.round(a))
          : '',
    });
  }

  return {
    horizon,
    ground,
    cardinals,
    grid: lines,
    compass,
    // Flat mode: our own sky until nautical twilight ends (then the skybox).
    // Real mode: Cesium's atmosphere plus a twilight wash.
    gradient:
      flatHorizon && Number.isFinite(sunAltDeg) && sunAltDeg > -12
        ? { alpha: 0.92, ...skyGradient(sunAltDeg) }
        : null,
    wash: flatHorizon ? null : twilightWash(sunAltDeg),
  };
}

/** Paint a model onto a 2-D context sized width x height (CSS pixels). */
export function drawOverlay(
  ctx,
  model,
  { width, height, text = null, ratio = 1 },
) {
  // `text`: a textSprites cache (pre-rendered labels, no font switch per
  // frame); without one the labels are drawn with fillText.
  const label = (str, x, y, style) => {
    if (text) text.draw(ctx, str, x, y, style, ratio);
    else {
      ctx.font = style.font;
      ctx.fillStyle = style.fill;
      ctx.textAlign = style.align;
      ctx.textBaseline = style.baseline;
      ctx.fillText(str, x, y);
    }
  };
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  const sky = model.gradient || model.wash;
  if (sky && sky.alpha > 0) {
    // From the horizon (or the bottom edge when it is below the view) up.
    const yH = model.horizon.length
      ? Math.min(height, Math.max(...model.horizon.map((p) => p.y)))
      : height;
    const top = Math.min(0, yH - height * 2);
    const g = ctx.createLinearGradient(0, yH, 0, top);
    g.addColorStop(0, sky.horizon);
    g.addColorStop(1, sky.zenith);
    ctx.globalAlpha = sky.alpha;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, Math.max(0, yH));
    ctx.globalAlpha = 1;
  }
  if (model.ground) {
    ctx.beginPath();
    model.ground.forEach((p, i) =>
      i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y),
    );
    ctx.closePath();
    ctx.fillStyle = 'rgba(8, 12, 10, 0.96)';
    ctx.fill();
  }
  if (model.horizon.length > 1) {
    ctx.beginPath();
    model.horizon.forEach((p, i) =>
      i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y),
    );
    ctx.strokeStyle = model.gradient
      ? model.gradient.horizon
      : 'rgba(170, 220, 255, 0.45)';
    ctx.lineWidth = model.ground ? 2 : 1;
    ctx.stroke();
  }
  if (model.grid.length) {
    // one batched stroke (a stroke per line is slow on phone canvases)
    ctx.strokeStyle = 'rgba(120, 190, 255, 0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const line of model.grid)
      line.points.forEach((p, i) =>
        i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y),
      );
    ctx.stroke();
  }
  // ticks first as one batched stroke, then the labels (a stroke per tick
  // costs a raster flush each on phone canvases)
  if (model.cardinals.length) {
    ctx.strokeStyle = 'rgba(230, 240, 255, 0.8)';
    ctx.beginPath();
    for (const c of model.cardinals) {
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(c.x, c.y - (c.major ? 12 : 7));
    }
    ctx.stroke();
  }
  for (const c of model.cardinals)
    label(c.label, c.x, c.y - (c.major ? 14 : 9), {
      font: c.major
        ? '600 16px system-ui, sans-serif'
        : '500 12px system-ui, sans-serif',
      fill:
        c.label === 'N'
          ? 'rgba(255, 120, 110, 0.95)'
          : 'rgba(230, 240, 255, 0.92)',
      align: 'center',
      baseline: 'bottom',
    });
  // compass strip
  const y = height - 18;
  ctx.fillStyle = 'rgba(4, 10, 18, 0.55)';
  ctx.fillRect(0, y - 16, width, 30);
  if (model.compass.length) {
    ctx.strokeStyle = 'rgba(200, 225, 255, 0.7)';
    ctx.beginPath();
    for (const tick of model.compass) {
      ctx.moveTo(tick.x, y - 16);
      ctx.lineTo(tick.x, y - (tick.label ? 10 : 12));
    }
    ctx.stroke();
  }
  for (const tick of model.compass) {
    if (!tick.label) continue;
    label(tick.label, tick.x, y + 2, {
      font: '500 11px system-ui, sans-serif',
      fill:
        tick.label === 'N'
          ? 'rgba(255, 120, 110, 0.95)'
          : 'rgba(220, 235, 255, 0.9)',
      align: 'center',
      baseline: 'middle',
    });
  }
  ctx.strokeStyle = 'rgba(255, 210, 120, 0.9)';
  ctx.beginPath();
  ctx.moveTo(width / 2, y - 16);
  ctx.lineTo(width / 2, y + 12);
  ctx.stroke();
  ctx.restore();
}
