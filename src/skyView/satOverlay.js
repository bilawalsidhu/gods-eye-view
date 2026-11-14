/**
 * Sky view satellite drawing: dots by state and class,
 * labels with greedy collision culling, terrain-profile dimming, the GEO belt
 * guide, an edge arrow pointing at the selected object when it is off
 * screen, and the arc of a selected pass. satelliteModel() is pure (tested); drawSatellites() only paints it.
 * All text is drawn here, never with Cesium labels (noCesiumLabels.test).
 */
import { ecfToLookAngles } from 'satellite.js';
import {
  SATELLITE_CLASSES,
  satelliteClassColor,
} from '../data/satelliteClass.js';
import { STATE } from './satCore.js';
import {
  cameraBasis,
  enuFromAzEl,
  normalizeAz,
  projectAzEl,
} from './skyMath.js';

const D2R = Math.PI / 180;
export const LABEL_FONT_PX = 11;
/**
 * Average glyph width reserved per character. Headless Chromium measured
 * all-caps names ("STARLINK-31234 42°") at up to 0.63 x the font size, so
 * 0.66 keeps the text inside its box; fillText's maxWidth guards the rest.
 */
export const LABEL_CHAR_PX = 0.66 * LABEL_FONT_PX;
export const LABEL_BUDGET = 12;
/** Bottom band kept free for the compass strip (overlay.js draws it there). */
export const COMPASS_BAND_PX = 36;
export const ARROW_INSET_PX = 34;
export const SHADOW_COLOR = '#7d8590';
export const STALE_COLOR = '#8a8f96';
const GEO_RADIUS_KM = 42_164;

/** Colour for a sky class ('other' = the active catch-all, satelliteClass fallback). */
export function skyClassColor(klass) {
  return SATELLITE_CLASSES[klass]?.color ?? satelliteClassColor('active');
}

/** Card/legend label for a sky class. */
export function skyClassLabel(klass) {
  if (klass === 'other') return 'ACTIVE';
  if (klass === 'comms') return 'STARLINK';
  // satelliteClass.js moved its labels into msg() keys (upstream i18n); the
  // Sky view keeps its own English tokens.
  return SKY_CLASS_LABELS[klass] ?? 'ACTIVE';
}

const SKY_CLASS_LABELS = Object.freeze({
  station: 'STATION',
  nav: 'NAV',
  geo: 'GEO',
  visual: 'VISUAL',
  comms: 'COMMS',
});

const DOT_RADIUS = {
  station: 4,
  nav: 2.8,
  geo: 2.6,
  visual: 3,
  comms: 2,
  other: 2,
};

/** Label rectangle for a text at an anchor, in canvas pixels. */
export function labelBox(text, x, y) {
  return {
    x,
    y,
    w: Math.ceil(String(text).length * LABEL_CHAR_PX) + 6,
    h: LABEL_FONT_PX + 5,
  };
}

export const boxesOverlap = (a, b) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Greedy label placement: candidates in priority order, each tries right,
 * left, above, below its dot; the first spot inside the canvas (above the
 * compass band) that overlaps no placed label wins, otherwise it is dropped.
 * `reserved` ({x, y, w, h}) are boxes already taken by the star/planet/
 * constellation labels and the horizon cardinals (one collision space for
 * the whole sky); only the SELECTED object's label may sit on them.
 */
export function placeLabels(candidates, width, height, reserved = []) {
  const placed = [];
  const maxY = height - COMPASS_BAND_PX;
  for (const c of candidates) {
    const probe = labelBox(c.text, 0, 0);
    const gap = c.r + 4;
    const spots = [
      [c.x + gap, c.y - probe.h / 2],
      [c.x - gap - probe.w, c.y - probe.h / 2],
      [c.x - probe.w / 2, c.y - gap - probe.h],
      [c.x - probe.w / 2, c.y + gap],
    ];
    for (const [x, y] of spots) {
      const box = { x, y, w: probe.w, h: probe.h };
      if (x < 0 || y < 0 || x + box.w > width || y + box.h > maxY) continue;
      if (placed.some((p) => boxesOverlap(p.box, box))) continue;
      if (!c.selected && reserved.some((r) => boxesOverlap(r, box))) continue;
      placed.push({ index: c.index, text: c.text, box, color: c.color });
      break;
    }
  }
  return placed;
}

/**
 * Where an off-screen direction meets the edge of the safe rectangle (the
 * canvas minus `insets`, e.g. the satellite panel and the toolbar), and the
 * arrow angle (canvas radians, y down).
 */
export function edgeArrow(azDeg, elDeg, view, width, height, insets = {}) {
  const { forward, right, up } = cameraBasis(view);
  const d = enuFromAzEl(azDeg, elDeg);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  let sx = dot(d, right);
  let sy = dot(d, up);
  if (Math.hypot(sx, sy) < 1e-9) {
    // Straight behind: point down (turn around).
    sx = 0;
    sy = dot(d, forward) > 0 ? 1 : -1;
  }
  const angle = Math.atan2(-sy, sx); // canvas y grows downwards
  let left = insets.left ?? ARROW_INSET_PX;
  let rightEdge = width - (insets.right ?? ARROW_INSET_PX);
  let top = insets.top ?? ARROW_INSET_PX;
  let bottom = height - (insets.bottom ?? ARROW_INSET_PX + COMPASS_BAND_PX);
  // A too-small safe area (phone, big panel) falls back to the plain insets.
  if (rightEdge - left < 80) {
    left = ARROW_INSET_PX;
    rightEdge = width - ARROW_INSET_PX;
  }
  if (bottom - top < 80) {
    top = ARROW_INSET_PX;
    bottom = height - ARROW_INSET_PX - COMPASS_BAND_PX;
  }
  const cx = (left + rightEdge) / 2;
  const cy = (top + bottom) / 2;
  const hx = Math.max(1, (rightEdge - left) / 2);
  const hy = Math.max(1, (bottom - top) / 2);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = Math.min(
    Math.abs(c) > 1e-9 ? hx / Math.abs(c) : Infinity,
    Math.abs(s) > 1e-9 ? hy / Math.abs(s) : Infinity,
  );
  return { x: cx + c * k, y: cy + s * k, angle };
}

/**
 * The geostationary belt as seen from the observer: az/el of points on the
 * equator at GEO radius, every 1 deg of longitude, kept where above -1 deg.
 */
export function geoBeltPoints(latDeg, lonDeg) {
  const observer = {
    latitude: latDeg * D2R,
    longitude: lonDeg * D2R,
    height: 0,
  };
  const points = [];
  for (let d = -90; d <= 90; d += 1) {
    const lon = (lonDeg + d) * D2R;
    const look = ecfToLookAngles(observer, {
      x: GEO_RADIUS_KM * Math.cos(lon),
      y: GEO_RADIUS_KM * Math.sin(lon),
      z: 0,
    });
    const el = look.elevation / D2R;
    if (el > -1) points.push([normalizeAz(look.azimuth / D2R), el]);
  }
  return points;
}

function projectRuns(points, view, width, height) {
  const runs = [];
  let run = [];
  for (const [az, el] of points) {
    const p = projectAzEl(az, el, view, width, height);
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
 * @param {object} args
 * @param {Array<{index:number,name:string,azDeg:number,elDeg:number,state:number,
 *   klass:string,set:string,stale:boolean}>} args.objects current sky objects
 * @param {(az:number, el:number) => 'clear'|'terrain'|'below'} [args.occlusion]
 * @param {Set<string>} [args.classesOn] classes drawn (selected always drawn)
 * @param {(o:object) => boolean} [args.include] extra filter (naked-eye),
 *   selected always drawn
 * @param {Array<[number, number, number, number]>} [args.passArc] selected
 *   pass arc rows [azDeg, elDeg, sunlit 0/1, timeMs]
 * @returns {{dots:Array, labels:Array, arrow:?object, belt:Array, arc:Array}}
 */
export function satelliteModel({
  objects = [],
  view,
  width,
  height,
  occlusion = (az, el) => (el < 0 ? 'below' : 'clear'),
  classesOn = null,
  selectedIndex = null,
  labelBudget = LABEL_BUDGET,
  geoBelt = null,
  insets = {},
  reserved = [],
  include = null,
  passArc = null,
}) {
  const dots = [];
  const core = [];
  const rest = [];
  let selected = null;
  let arrow = null;
  for (const o of objects) {
    const isSelected = o.index === selectedIndex;
    if (!isSelected && classesOn && !classesOn.has(o.klass)) continue;
    if (!isSelected && include && !include(o)) continue;
    if (!(o.elDeg > 0)) continue;
    const occ = occlusion(o.azDeg, o.elDeg);
    if (occ === 'below') continue;
    const p = projectAzEl(o.azDeg, o.elDeg, view, width, height);
    const onScreen =
      p && p.x >= -6 && p.x <= width + 6 && p.y >= -6 && p.y <= height + 6;
    if (!onScreen) {
      if (isSelected) {
        const a = edgeArrow(o.azDeg, o.elDeg, view, width, height, insets);
        arrow = {
          ...a,
          index: o.index,
          text: o.name,
          textX: Math.min(Math.max(a.x, 70), width - 70),
          textY: a.y + (a.y > height / 2 ? -18 : 18),
        };
      }
      continue;
    }
    const base = DOT_RADIUS[o.klass] ?? 2;
    let kind = 'filled';
    let color = skyClassColor(o.klass);
    let r = base;
    let alpha = 1;
    if (o.state === STATE.SUNLIT_BRIGHT_SKY) {
      kind = 'ring';
      r = base + 0.6;
      alpha = 0.85;
    } else if (o.state === STATE.SHADOW) {
      kind = 'hollow';
      color = SHADOW_COLOR;
      r = Math.max(1.6, base - 0.6);
      alpha = 0.7;
    }
    if (o.stale) {
      color = STALE_COLOR;
      alpha *= 0.6;
    }
    const dimmed = occ === 'terrain';
    if (dimmed) alpha *= 0.35;
    const dot = {
      index: o.index,
      x: p.x,
      y: p.y,
      r,
      kind,
      color,
      alpha,
      dimmed,
      selected: isSelected,
    };
    dots.push(dot);
    const text = `${o.name} ${Math.round(o.elDeg)}°`;
    const candidate = {
      index: o.index,
      x: p.x,
      y: p.y,
      r,
      text,
      color,
      elDeg: o.elDeg,
      klass: o.klass,
      selected: isSelected,
    };
    if (isSelected) selected = candidate;
    else if (o.state === STATE.VISIBLE && !dimmed) {
      if (o.set === 'core') core.push(candidate);
      else rest.push(candidate);
    }
  }
  const byPriority = (a, b) =>
    (b.klass === 'station') - (a.klass === 'station') || b.elDeg - a.elDeg;
  core.sort(byPriority);
  rest.sort(byPriority);
  const candidates = [
    ...(selected ? [selected] : []),
    ...core,
    ...rest.slice(0, Math.max(0, labelBudget)),
  ];
  return {
    dots,
    labels: placeLabels(candidates, width, height, reserved),
    arrow,
    belt: geoBelt ? projectRuns(geoBelt, view, width, height) : [],
    arc: passArc ? passArcRuns(passArc, view, width, height) : [],
  };
}

/**
 * Projected pass arc split into runs of one lighting state (sunlit drawn
 * solid, shadowed dashed). Pure.
 */
export function passArcRuns(rows, view, width, height) {
  const runs = [];
  let cur = null;
  let last = null;
  for (const [az, el, sunlit] of rows || []) {
    const lit = Boolean(sunlit);
    if (!cur || cur.sunlit !== lit) {
      // a new lighting state starts where the previous one ended
      cur = { sunlit: lit, src: last ? [last] : [] };
      runs.push(cur);
    }
    last = [az, el];
    cur.src.push(last);
  }
  const out = [];
  for (const run of runs)
    for (const points of projectRuns(run.src, view, width, height))
      out.push({ sunlit: run.sunlit, points });
  return out;
}

/** Index of the dot nearest (x, y) within `radius` px, or null. */
export function hitTest(model, x, y, radius = 12) {
  let best = null;
  let bestD = radius;
  for (const dot of model?.dots || []) {
    const d = Math.hypot(dot.x - x, dot.y - y);
    if (d <= bestD) {
      best = dot.index;
      bestD = d;
    }
  }
  return best;
}

/** Animated look-at: view part way (f in 0..1, eased) from `from` to `to`. */
export function lookAtView(from, to, f) {
  const k = f >= 1 ? 1 : f <= 0 ? 0 : 1 - (1 - f) ** 3;
  let dAz = normalizeAz(to.azDeg) - normalizeAz(from.azDeg);
  if (dAz > 180) dAz -= 360;
  if (dAz < -180) dAz += 360;
  return {
    ...from,
    azDeg: normalizeAz(from.azDeg + dAz * k),
    elDeg: from.elDeg + (to.elDeg - from.elDeg) * k,
  };
}

/** Paint a satellite model (CSS pixels). */
export function drawSatellites(ctx, model, { text = null, ratio = 1 } = {}) {
  if (!model) return;
  ctx.save();
  if (model.belt.length) {
    ctx.strokeStyle = 'rgba(200, 155, 255, 0.45)';
    ctx.lineWidth = 1;
    ctx.setLineDash?.([4, 6]);
    for (const run of model.belt) {
      ctx.beginPath();
      run.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    }
    ctx.setLineDash?.([]);
  }
  for (const run of model.arc || []) {
    ctx.strokeStyle = run.sunlit
      ? 'rgba(255, 214, 120, 0.85)'
      : 'rgba(150, 160, 175, 0.6)';
    ctx.lineWidth = run.sunlit ? 2 : 1.4;
    ctx.setLineDash?.(run.sunlit ? [] : [3, 5]);
    ctx.beginPath();
    run.points.forEach((p, i) =>
      i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y),
    );
    ctx.stroke();
  }
  ctx.setLineDash?.([]);
  for (const dot of model.dots) {
    ctx.globalAlpha = dot.alpha;
    ctx.beginPath();
    ctx.arc(dot.x, dot.y, dot.r, 0, Math.PI * 2);
    if (dot.kind === 'filled') {
      ctx.fillStyle = dot.color;
      ctx.fill();
    } else {
      ctx.strokeStyle = dot.color;
      ctx.lineWidth = dot.kind === 'ring' ? 1.2 : 1;
      ctx.stroke();
    }
    if (dot.selected) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(255, 210, 120, 0.95)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(dot.x, dot.y, dot.r + 7, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  // Setting ctx.font forces a style resolution (a synchronous style recalc
  // when the page changed since the last frame): only when there is text,
  // and labels go through the pre-rendered text sprites when given.
  const font = `500 ${LABEL_FONT_PX}px system-ui, sans-serif`;
  if (model.labels.length && !text) {
    ctx.font = font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
  }
  for (const label of model.labels) {
    const { box } = label;
    // maxWidth keeps the glyphs inside the reserved box whatever the font,
    // so non-overlapping boxes mean non-overlapping text.
    const maxWidth = box.w - 6;
    if (text) {
      text.draw(
        ctx,
        label.text,
        box.x + 3,
        box.y + box.h / 2,
        {
          font,
          fill: label.color,
          stroke: 'rgba(2, 6, 12, 0.8)',
          strokeWidth: 3,
          align: 'left',
          baseline: 'middle',
          maxWidth,
        },
        ratio,
      );
      continue;
    }
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(2, 6, 12, 0.8)';
    ctx.strokeText(label.text, box.x + 3, box.y + box.h / 2, maxWidth);
    ctx.fillStyle = label.color;
    ctx.fillText(label.text, box.x + 3, box.y + box.h / 2, maxWidth);
  }
  if (model.arrow) {
    const { x, y, angle, text: arrowText, textX, textY } = model.arrow;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = 'rgba(255, 210, 120, 0.95)';
    ctx.beginPath();
    ctx.moveTo(12, 0);
    ctx.lineTo(-6, -8);
    ctx.lineTo(-2, 0);
    ctx.lineTo(-6, 8);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    if (arrowText) {
      ctx.font = font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(255, 225, 160, 0.95)';
      ctx.fillText(arrowText, textX, textY);
    }
  }
  ctx.restore();
}
