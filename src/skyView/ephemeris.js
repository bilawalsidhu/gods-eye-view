/**
 * Sun, Moon and planet positions for the Sky view, on
 * astronomy-engine (MIT, pinned exact in package.json). Pure functions of
 * (time, observer); no DOM, no Cesium, no network.
 *
 * Positions are TOPOCENTRIC apparent (light time, aberration, precession and
 * nutation of date, observer parallax: the Moon moves up to ~1 deg), az/el
 * airless unless `refraction: true`. That matches JPL Horizons quantity 4 with
 * APPARENT=AIRLESS; astronomy-engine documents +/-1 arcminute against
 * NOVAS/Horizons.
 */
import {
  Body,
  Equator,
  Horizon,
  Illumination,
  MakeTime,
  MoonPhase,
  Observer,
} from 'astronomy-engine';
import { DEG, normalizeAz } from './skyMath.js';

export const PLANETS = Object.freeze([
  'Mercury',
  'Venus',
  'Mars',
  'Jupiter',
  'Saturn',
  'Uranus',
  'Neptune',
]);
/** Planets only shown behind the "telescopic" toggle. */
export const TELESCOPIC_PLANETS = Object.freeze(['Uranus', 'Neptune']);

const AU_KM = 149_597_870.7;
const MOON_RADIUS_KM = 1737.4;
const SUN_RADIUS_KM = 695_700;

/** astronomy-engine Observer for a GEV observer { latDeg, lonDeg, heightM }. */
export function makeObserver({ latDeg, lonDeg, heightM = 0 }) {
  if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg))
    throw new TypeError('observer needs finite latDeg/lonDeg');
  return new Observer(latDeg, lonDeg, Number.isFinite(heightM) ? heightM : 0);
}

const asObserver = (observer) =>
  observer instanceof Observer ? observer : makeObserver(observer);

const bodyOf = (name) => {
  const body = Body[name];
  if (!body) throw new RangeError(`unknown body ${name}`);
  return body;
};

/**
 * Topocentric apparent position of a body.
 * @returns {{name:string, azDeg:number, elDeg:number, raDeg:number,
 *   decDeg:number, distanceKm:number, vec:number[]}} RA/Dec are of date;
 *   vec is the topocentric equator-of-date vector in AU.
 */
export function bodyPosition(name, ms, observer, { refraction = false } = {}) {
  const time = MakeTime(new Date(ms));
  const obs = asObserver(observer);
  const eq = Equator(bodyOf(name), time, obs, true, true);
  const hor = Horizon(time, obs, eq.ra, eq.dec, refraction ? 'normal' : null);
  return {
    name,
    azDeg: normalizeAz(hor.azimuth),
    elDeg: hor.altitude,
    raDeg: normalizeAz(eq.ra * 15),
    decDeg: eq.dec,
    distanceKm: eq.dist * AU_KM,
    vec: [eq.vec.x, eq.vec.y, eq.vec.z],
  };
}

/** Visual magnitude (astronomy-engine Illumination, geocentric). */
export const magnitude = (name, ms) =>
  Illumination(bodyOf(name), MakeTime(new Date(ms))).mag;

const angleBetween = (a, b) => {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  return Math.atan2(Math.hypot(...cross), dot);
};

/**
 * Position angle (degrees east of celestial north, 0..360) of the midpoint of
 * the Moon's bright limb, Meeus "Astronomical Algorithms" eq. 48.5.
 */
export function brightLimbAngle(sunRaDeg, sunDecDeg, moonRaDeg, moonDecDeg) {
  const a0 = sunRaDeg * DEG;
  const d0 = sunDecDeg * DEG;
  const a = moonRaDeg * DEG;
  const d = moonDecDeg * DEG;
  const y = Math.cos(d0) * Math.sin(a0 - a);
  const x =
    Math.sin(d0) * Math.cos(d) - Math.cos(d0) * Math.sin(d) * Math.cos(a0 - a);
  return normalizeAz(Math.atan2(y, x) / DEG);
}

const angularDiameterDeg = (radiusKm, distanceKm) =>
  (2 * Math.asin(Math.min(1, radiusKm / distanceKm))) / DEG;

/** The Sun: position, magnitude, angular diameter. */
export function sunState(ms, observer, options) {
  const position = bodyPosition('Sun', ms, observer, options);
  return {
    ...position,
    magnitude: magnitude('Sun', ms),
    angularDiameterDeg: angularDiameterDeg(SUN_RADIUS_KM, position.distanceKm),
  };
}

/**
 * The Moon, topocentric: position, magnitude, angular diameter, phase seen
 * from the observer (illuminated fraction and phase angle from topocentric
 * vectors), elongation phase 0..360 (0 new, 90 first quarter, 180 full) and
 * the bright-limb position angle.
 */
export function moonState(ms, observer, options) {
  const obs = asObserver(observer);
  const moon = bodyPosition('Moon', ms, obs, options);
  const sun = bodyPosition('Sun', ms, obs);
  const toObserver = moon.vec.map((v) => -v);
  const toSun = sun.vec.map((v, i) => v - moon.vec[i]);
  const phaseAngle = angleBetween(toObserver, toSun);
  const phaseDeg = MoonPhase(MakeTime(new Date(ms)));
  return {
    ...moon,
    magnitude: magnitude('Moon', ms),
    angularDiameterDeg: angularDiameterDeg(MOON_RADIUS_KM, moon.distanceKm),
    phaseAngleDeg: phaseAngle / DEG,
    illuminatedFraction: (1 + Math.cos(phaseAngle)) / 2,
    phaseDeg,
    waxing: phaseDeg < 180,
    brightLimbAngleDeg: brightLimbAngle(
      sun.raDeg,
      sun.decDeg,
      moon.raDeg,
      moon.decDeg,
    ),
  };
}

/** A planet: position and magnitude. */
export function planetState(name, ms, observer, options) {
  if (!PLANETS.includes(name)) throw new RangeError(`not a planet: ${name}`);
  return {
    ...bodyPosition(name, ms, observer, options),
    magnitude: magnitude(name, ms),
    telescopic: TELESCOPIC_PLANETS.includes(name),
  };
}

/** Everything the overlay needs for one instant and observer. */
export function skyEphemeris(ms, observer, options) {
  const obs = asObserver(observer);
  return {
    ms,
    sun: sunState(ms, obs, options),
    moon: moonState(ms, obs, options),
    planets: PLANETS.map((name) => planetState(name, ms, obs, options)),
  };
}
