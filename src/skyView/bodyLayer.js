/**
 * Sun, Moon and planets in the Sky view overlay.
 * Positions come from ephemeris.js (astronomy-engine, topocentric, refracted).
 * Rules:
 *   - Sun and Moon at their true angular size, at least MIN_DISC_PX across;
 *     the Moon shows its phase (illuminated fraction, bright limb towards the
 *     Sun); the Sun is a dimmed disc with no glare artwork.
 *   - Daylight (Sun above the horizon): only the Sun, the Moon, Venus and
 *     Jupiter. Otherwise a planet shows when it is brighter than the current
 *     limiting magnitude (Venus and Jupiter always).
 *   - Uranus and Neptune only with the "telescopic" switch, and never in
 *     daylight.
 * Pure model + a separate draw step.
 */
import { clamp, enuFromAzEl } from './skyMath.js';
import { TERRAIN_ALPHA, makeProjector } from './starLayer.js';

export const MIN_DISC_PX = 14;
export const DAYLIGHT_PLANETS = Object.freeze(['Venus', 'Jupiter']);
export const PLANET_COLORS = Object.freeze({
  Mercury: '#d8cbb8',
  Venus: '#fff6dc',
  Mars: '#ff9a6a',
  Jupiter: '#ffe7c4',
  Saturn: '#f2dca0',
  Uranus: '#b8f0f0',
  Neptune: '#9fb8ff',
});

/** Is a planet drawn under these conditions? */
export function planetVisible(
  { name, magnitude, telescopic: isTelescopic },
  { sunAltDeg, lim, telescopic = false },
) {
  const daylight = Number.isFinite(sunAltDeg) && sunAltDeg > 0;
  if (isTelescopic) return telescopic && !daylight;
  if (DAYLIGHT_PLANETS.includes(name)) return true;
  if (daylight) return false;
  return Number.isFinite(magnitude) && magnitude <= lim;
}

/** Dot radius (px) of a planet from its magnitude. */
export const planetRadius = (mag) => clamp(0.8 + 0.54 * (6.5 - mag), 2.5, 6);

/**
 * Outline of a lit Moon of illuminated fraction k and radius r, bright limb
 * towards +x (unrotated). Its area is k * pi * r^2.
 */
export function moonPhasePolygon(k, r, steps = 32) {
  const f = clamp(Number(k) || 0, 0, 1);
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const phi = -Math.PI / 2 + (Math.PI * i) / steps;
    points.push({ x: r * Math.cos(phi), y: r * Math.sin(phi) });
  }
  for (let i = steps; i >= 0; i--) {
    const phi = -Math.PI / 2 + (Math.PI * i) / steps;
    points.push({ x: r * (1 - 2 * f) * Math.cos(phi), y: r * Math.sin(phi) });
  }
  return points;
}

/**
 * Screen direction (radians, canvas axes: +x right, +y down) from a body
 * towards another along the great circle through both: the Moon's bright
 * limb points at the Sun.
 */
export function screenDirectionTowards(fromEnu, toEnu, project) {
  const d =
    fromEnu[0] * toEnu[0] + fromEnu[1] * toEnu[1] + fromEnu[2] * toEnu[2];
  const t = toEnu.map((v, i) => v - d * fromEnu[i]);
  const len = Math.hypot(...t);
  if (len < 1e-9) return 0;
  const a = project(...fromEnu);
  if (!a) return 0;
  const [ax, ay] = [a.x, a.y];
  const eps = 1e-3;
  const step = fromEnu.map((v, i) => v + (eps * t[i]) / len);
  const b = project(...step);
  if (!b) return 0;
  return Math.atan2(b.y - ay, b.x - ax);
}

/**
 * What to draw for one ephemeris (ephemeris.skyEphemeris with refraction).
 * alpha is TERRAIN_ALPHA when the body is behind the terrain profile
 * (drawn dimmed, like stars and satellites: ), else 1.
 * @returns {Array<{name, kind, x, y, r, magnitude, alpha, colour?, phase?}>}
 */
export function bodiesModel(
  eph,
  { view, width, height, sunAltDeg, lim, telescopic = false, occlusion = null },
) {
  if (!eph) return [];
  const project = makeProjector(view, width, height);
  const out = [];
  const place = (body) => {
    const radiusDeg = (body.angularDiameterDeg || 0) / 2;
    if (!(body.elDeg > -radiusDeg)) return null;
    // the top of the disc decides: a half-set Sun behind a ridge is dimmed
    // only once all of it is behind the terrain profile
    const state = occlusion
      ? occlusion(body.azDeg, body.elDeg + radiusDeg)
      : 'clear';
    if (state === 'below') return null;
    const enu = enuFromAzEl(body.azDeg, body.elDeg);
    const p = project(...enu);
    if (!p) return null;
    return {
      x: p.x,
      y: p.y,
      enu,
      alpha: state === 'terrain' ? TERRAIN_ALPHA : 1,
    };
  };
  const onCanvas = (p, r) =>
    p.x > -r && p.y > -r && p.x < width + r && p.y < height + r;
  const discRadius = (body) =>
    Math.max(MIN_DISC_PX, body.angularDiameterDeg * project.pxPerDeg) / 2;

  const sun = place(eph.sun);
  if (sun) {
    const r = discRadius(eph.sun);
    if (onCanvas(sun, r))
      out.push({
        name: 'Sun',
        kind: 'sun',
        x: sun.x,
        y: sun.y,
        r,
        magnitude: eph.sun.magnitude,
        alpha: sun.alpha,
      });
  }
  const moon = place(eph.moon);
  if (moon) {
    const r = discRadius(eph.moon);
    if (onCanvas(moon, r)) {
      const sunEnu = enuFromAzEl(eph.sun.azDeg, eph.sun.elDeg);
      out.push({
        name: 'Moon',
        kind: 'moon',
        x: moon.x,
        y: moon.y,
        r,
        magnitude: eph.moon.magnitude,
        alpha: moon.alpha,
        phase: {
          fraction: eph.moon.illuminatedFraction,
          angle: screenDirectionTowards(moon.enu, sunEnu, project),
        },
      });
    }
  }
  for (const planet of eph.planets) {
    if (!planetVisible(planet, { sunAltDeg, lim, telescopic })) continue;
    const p = place(planet);
    if (!p) continue;
    const r = planetRadius(planet.magnitude);
    if (!onCanvas(p, r)) continue;
    out.push({
      name: planet.name,
      kind: 'planet',
      x: p.x,
      y: p.y,
      r,
      magnitude: planet.magnitude,
      alpha: p.alpha,
      colour: PLANET_COLORS[planet.name] || '#ffffff',
    });
  }
  return out;
}

/** Paint the bodies (labels are drawn by the label pass). */
export function drawBodies(ctx, bodies) {
  ctx.save();
  for (const body of bodies) {
    const alpha = Number.isFinite(body.alpha) ? body.alpha : 1;
    ctx.globalAlpha = alpha;
    if (body.kind === 'sun') {
      // Dimmed on purpose: no glare, never an invitation to look at it.
      ctx.globalAlpha = 0.7 * alpha;
      ctx.fillStyle = 'rgb(255, 228, 150)';
      ctx.beginPath();
      ctx.arc(body.x, body.y, body.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = 'rgba(120, 70, 20, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else if (body.kind === 'moon') {
      ctx.fillStyle = 'rgba(48, 52, 64, 0.85)';
      ctx.beginPath();
      ctx.arc(body.x, body.y, body.r, 0, Math.PI * 2);
      ctx.fill();
      const poly = moonPhasePolygon(body.phase.fraction, body.r);
      const c = Math.cos(body.phase.angle);
      const s = Math.sin(body.phase.angle);
      ctx.fillStyle = 'rgb(236, 236, 226)';
      ctx.beginPath();
      poly.forEach((p, i) => {
        const x = body.x + p.x * c - p.y * s;
        const y = body.y + p.x * s + p.y * c;
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.fillStyle = body.colour;
      ctx.beginPath();
      ctx.arc(body.x, body.y, body.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(body.x, body.y, body.r + 2.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
  return bodies.length;
}
