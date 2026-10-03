/**
 * Planets Layer — Mercury through Neptune rendered on the Cesium globe.
 *
 * Uses analytical Keplerian orbital mechanics (no external dependency beyond
 * Cesium). Each planet is rendered as a scaled ellipsoid + name label.
 *
 * Orbital elements reference: J2000 mean equatorial elements.
 */

import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';

// ─── Orbital Elements (J2000 mean elements) ───────────────────────────────────

/**
 * @typedef {object} OrbitalElements
 * @property {number} a  Semi-major axis (km)
 * @property {number} e  Eccentricity
 * @property {number} i  Inclination (radians)
 * @property {number} Omega  Longitude of ascending node (radians)
 * @property {number} omega  Argument of periapsis (radians)
 * @property {number} L  Mean longitude at J2000 (radians)
 * @property {number} n  Mean motion (radians/s)
 */

/** @type {Map<string, OrbitalElements>} */
const PLANET_ELEMENTS = new Map([
  ['mercury', { a: 57_909_100, e: 0.205630, i: (7.005) * Math.PI / 180, Omega: (48.331) * Math.PI / 180, omega: (29.124) * Math.PI / 180, L: (252.251) * Math.PI / 180, n: 0.0000260206 }],
  ['venus',   { a: 108_208_000, e: 0.006773, i: (3.395) * Math.PI / 180, Omega: (76.680) * Math.PI / 180, omega: (54.884) * Math.PI / 180, L: (181.980) * Math.PI / 180, n: 0.0000102178 }],
  ['mars',    { a: 227_939_200, e: 0.093405, i: (1.850) * Math.PI / 180, Omega: (49.558) * Math.PI / 180, omega: (286.502) * Math.PI / 180, L: (355.433) * Math.PI / 180, n: 0.0000053666 }],
  ['jupiter', { a: 778_412_010, e: 0.048775, i: (1.303) * Math.PI / 180, Omega: (100.464) * Math.PI / 180, omega: (273.867) * Math.PI / 180, L: (34.351) * Math.PI / 180, n: 0.0000008402 }],
  ['saturn',  { a: 1_432_127_000, e: 0.056017, i: (2.489) * Math.PI / 180, Omega: (113.666) * Math.PI / 180, omega: (339.392) * Math.PI / 180, L: (50.077) * Math.PI / 180, n: 0.0000003363 }],
  ['uranus',  { a: 2.871957e9, e: 0.046191, i: (0.773) * Math.PI / 180, Omega: (74.006) * Math.PI / 180, omega: (96.998) * Math.PI / 180, L: (314.055) * Math.PI / 180, n: 0.0000001183 }],
  ['neptune', { a: 4.494992e9, e: 0.009097, i: (1.770) * Math.PI / 180, Omega: (131.784) * Math.PI / 180, omega: (276.336) * Math.PI / 180, L: (304.880) * Math.PI / 180, n: 0.0000000603 }],
]);

// ─── Planet Display Metadata ───────────────────────────────────────────────────

/** Visual display radius in meters — intentionally slightly larger for visibility. */
const PLANET_DISPLAY_RADII_M = {
  mercury: 8_000_000,
  venus:   12_000_000,
  mars:    8_000_000,
  jupiter: 35_000_000,
  saturn:  30_000_000,
  uranus:  18_000_000,
  neptune: 18_000_000,
};

const PLANET_COLORS = {
  mercury: new Cesium.Color(0.71, 0.71, 0.71, 0.95),
  venus:   new Cesium.Color(0.91, 0.78, 0.47, 0.95),
  mars:    new Cesium.Color(0.76, 0.26, 0.06, 0.95),
  jupiter: new Cesium.Color(0.78, 0.55, 0.23, 0.95),
  saturn:  new Cesium.Color(0.92, 0.84, 0.72, 0.95),
  uranus:  new Cesium.Color(0.45, 0.66, 0.78, 0.95),
  neptune: new Cesium.Color(0.29, 0.44, 0.87, 0.95),
};

// ─── Module State ─────────────────────────────────────────────────────────────

let _viewer = null;
let _enabled = false;
const _params = { showLabels: true };
const _entities = new Map();   // planetId → Cesium.Entity
let _refreshTimer = null;

// ─── Orbital Mechanics ───────────────────────────────────────────────────────

const J2000_JD = 2451545.0; // Julian Date of J2000.0
const TWO_PI = 2 * Math.PI;

/**
 * Solve Kepler's equation M = E - e·sin(E) via Newton-Raphson iteration.
 * @param {number} M Mean anomaly (radians)
 * @param {number} e Eccentricity
 * @returns {number} Eccentric anomaly (radians)
 */
function solveKepler(M, e) {
  // First guess: use M directly for low eccentricity
  let E = M;
  for (let i = 0; i < 20; i++) {
    const dE = (M - E + e * Math.sin(E)) / (1.0 - e * Math.cos(E));
    E += dE;
    if (Math.abs(dE) < 1e-12) break;
  }
  return E;
}

/**
 * Compute Earth's true longitude of ascending node (Ω_E) and obliquity (ε)
 * at a given Julian Date.  Uses IAU 1976 precession model (simplified).
 * @param {number} jd Julian Date
 * @returns {{ OmegaEarth: number, obliquity: number }} Node longitude and
 *   obliquity, both radians.
 */
function earthOrientationAtJd(jd) {
  const T = (jd - J2000_JD) / 36525.0; // Julian centuries from J2000
  // Mean longitude of ascending node of Earth's orbit (deg)
  const OmegaEarth = (0.0 + 0.64062 * T) * Math.PI / 180;
  // Mean obliquity of the ecliptic (IAU 1976)
  const obliquity = (23.439291 - 0.0130042 * T) * Math.PI / 180;
  return { OmegaEarth, obliquity };
}

/**
 * Compute a planet's ECI (Earth-Centered Inertial) position at a given JD.
 * Uses simplified Keplerian mechanics in the Earth-equatorial frame.
 *
 * @param {OrbitalElements} el Orbital elements
 * @param {number} jd Julian Date
 * @returns {{ x: number, y: number, z: number }} ECI position in km
 */
function planetEciPosition(el, jd) {
  const T = (jd - J2000_JD) / 36525.0;

  // Advance mean longitude
  const L = ((el.L + el.n * T * 36525.0 * 86400.0) % TWO_PI + TWO_PI) % TWO_PI;

  // Mean anomaly
  const M = ((L - el.omega) % TWO_PI + TWO_PI) % TWO_PI;

  // Eccentric anomaly
  const E = solveKepler(M, el.e);

  // True anomaly
  const cosE = Math.cos(E);
  const sinE = Math.sin(E);
  const trueAnom = 2 * Math.atan2(Math.sqrt(1 + el.e) * sinE, Math.sqrt(1 - el.e) * cosE);

  // Distance from focus
  const r = el.a * (1 - el.e * cosE);

  // Argument of latitude
  const u = el.omega + trueAnom;

  // Components in orbital plane
  const cosU = Math.cos(u);
  const sinU = Math.sin(u);

  // Perifocal coordinates (orbital plane → ecliptic)
  const { OmegaEarth, obliquity } = earthOrientationAtJd(jd);
  const sinO = Math.sin(el.Omega - OmegaEarth);
  const cosO = Math.cos(el.Omega - OmegaEarth);
  const sinI = Math.sin(el.i);
  const cosI = Math.cos(el.i);
  const sinObl = Math.sin(obliquity);
  const cosObl = Math.cos(obliquity);

  // Rotate: perifocal → ecliptic (node-aligned)
  const x_orb = r * (cosO * cosU - sinO * sinU * cosI);
  const y_orb = r * (sinO * cosU + cosO * sinU * cosI);
  const z_orb = r * sinU * sinI;

  // Rotate: ecliptic → Earth-equatorial
  const x_eci = x_orb;
  const y_eci = y_orb * cosObl + z_orb * sinObl;
  const z_eci = -y_orb * sinObl + z_orb * cosObl;

  return { x: x_eci, y: y_eci, z: z_eci };
}

/**
 * Convert ECI (km) to ECEF Cartesian3 (meters) for Cesium.
 * @param {{ x: number, y: number, z: number }} eci ECI position in km
 * @param {number} jd Julian Date
 * @returns {Cesium.Cartesian3} ECEF position in meters
 */
function eciToEcefM(eci, jd) {
  // Get GMST
  const T = (jd - J2000_JD) / 36525.0;
  const gmstDeg = 280.46061837 + 360.98564736629 * (jd - J2000_JD)
    + 0.000387933 * T * T - T * T * T / 38710000.0;
  const gmst = (gmstDeg % 360) * Math.PI / 180;

  // Rotate ECI to ECEF
  const cg = Math.cos(gmst);
  const sg = Math.sin(gmst);
  const xEcef = (eci.x * cg - eci.y * sg) * 1000;
  const yEcef = (eci.x * sg + eci.y * cg) * 1000;
  const zEcef = eci.z * 1000;

  return new Cesium.Cartesian3(xEcef, yEcef, zEcef);
}

/**
 * Compute a planet's ECEF position for a Cesium.JulianDate.
 * @param {string} planetId Planet key from PLANET_ELEMENTS, or 'moon'.
 * @param {Cesium.JulianDate} time Instant to propagate to.
 * @returns {Cesium.Cartesian3} ECEF position in metres; ZERO for an unknown id.
 */
function planetEcefPosition(planetId, time) {
  if (planetId === 'moon') return moonEcefPosition(time);

  const el = PLANET_ELEMENTS.get(planetId);
  if (!el) return Cesium.Cartesian3.ZERO;

  const jd = Cesium.JulianDate.toDate(time).getTime() / 86400000.0 + 2440587.5;
  const eci = planetEciPosition(el, jd);
  return eciToEcefM(eci, jd);
}

/** Temporary scratch objects for moon position computation. */
const _moonInertial = new Cesium.Cartesian3();
const _moonFixed = new Cesium.Matrix3();

/**
 * Compute the Moon's ECEF position using Cesium's built-in ephemeris.
 * @param {Cesium.JulianDate} time Instant to evaluate the ephemeris at.
 * @returns {Cesium.Cartesian3} ECEF position in metres, or ZERO when the
 *   ICRF-to-fixed transform is unavailable.
 */
function moonEcefPosition(time) {
  Cesium.Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(time, _moonInertial);
  const matrix = Cesium.Transforms.computeIcrfToFixedMatrix(time, _moonFixed)
    || Cesium.Transforms.computeTemeToPseudoFixedMatrix(time, _moonFixed);
  if (!matrix) return Cesium.Cartesian3.ZERO;
  const fixed = new Cesium.Cartesian3();
  Cesium.Matrix3.multiplyByVector(matrix, _moonInertial, fixed);
  return Cesium.Cartesian3.multiplyByScalar(fixed, 1000, new Cesium.Cartesian3()); // m
}

// ─── Layer Interface ─────────────────────────────────────────────────────────

const REFRESH_MS = 60_000; // Update ephemeris and entity positions every 60s

let _lastEphemerisUpdate = 0;
const _cachedPositions = new Map(); // planetId → Cesium.Cartesian3

/**
 * Refresh the cached per-planet ECEF positions, at most once per REFRESH_MS.
 * @param {Cesium.JulianDate} julianDate Current scene time.
 * @returns {boolean} Whether the cache actually refreshed this call.
 */
function _updateEphemeris(julianDate) {
  const now = Cesium.JulianDate.toMilliseconds(julianDate);
  if (now - _lastEphemerisUpdate < REFRESH_MS && _cachedPositions.size > 0) return false;
  _lastEphemerisUpdate = now;

  for (const [planetId] of PLANET_ELEMENTS) {
    const ecef = planetEcefPosition(planetId, julianDate);
    _cachedPositions.set(planetId, ecef);
  }
  return true;
}

/**
 * Push the cached positions onto the entities: the seven planets from the
 * cache, the Moon recomputed at the same cadence. Assigning `entity.position`
 * wraps the value in a fresh ConstantProperty and dirties the static geometry
 * batch, so this must run at the REFRESH_MS cadence — NOT per frame (Phase
 * 15B census: the per-frame writes rebuilt eight ellipsoids' geometry sixty
 * times a second while moving them less than 0.002% of their display radius
 * per minute).
 * @param {Cesium.JulianDate} julianDate Current scene time.
 * @returns {void}
 */
function _writePositions(julianDate) {
  for (const [planetId, entity] of _entities) {
    if (planetId === 'moon') {
      entity.position = moonEcefPosition(julianDate);
    } else {
      const pos = _cachedPositions.get(planetId);
      if (pos) entity.position = pos;
    }
  }
}

/**
 * Interval-driven update (Phase 15B): refresh the ephemeris, write positions,
 * and request exactly one render. An interval, not a scene.preRender listener,
 * because with the render governor parked there ARE no frames — a preRender
 * listener would never fire to produce the frame that moves the planets.
 * Visual parity at 60 s cadence: the Moon — the fastest mover here — covers
 * ~61 km per minute against a 3,840 km display radius (<0.002%); planetary
 * motion is orders slower still.
 * @returns {void}
 */
function _update() {
  if (!_enabled || !_viewer) return;
  const time = _viewer.clock.currentTime;
  _updateEphemeris(time);
  _writePositions(time);
  governorRequestRender('planets-ephemeris');
}

/** Start the refresh interval (idempotent) and run one immediate update. */
function _startRefresh() {
  if (_refreshTimer) return; // already armed — never re-arm or reset the phase
  _refreshTimer = setInterval(_update, REFRESH_MS);
  _update();
}

/** Stop the refresh interval. Safe to call from any state. */
function _stopRefresh() {
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
  }
}

// ─── Layer Object ────────────────────────────────────────────────────────────

const planetsLayer = {
  id: 'planets',
  name: 'Planets',
  icon: '🪐',
  source: 'J2000 Orbital Elements',
  updateInterval: 0,
  refreshInterval: 0,

  async init(viewer) {
    _viewer = viewer;
    _enabled = false;
    _entities.clear();
    _cachedPositions.clear();
    _lastEphemerisUpdate = 0;
    _stopRefresh();

    // Create entity for each planet
    for (const planetId of PLANET_ELEMENTS.keys()) {
      const displayRadius = PLANET_DISPLAY_RADII_M[planetId];
      const color = PLANET_COLORS[planetId];
      const radii = new Cesium.Cartesian3(displayRadius, displayRadius, displayRadius);

      const entity = _viewer.entities.add({
        id: `planet-${planetId}`,
        position: Cesium.Cartesian3.ZERO,
        ellipsoid: {
          radii,
          material: color,
          outline: false,
          slicePartitions: 24,
          stackPartitions: 16,
        },
        label: {
          text: planetId.charAt(0).toUpperCase() + planetId.slice(1),
          font: 'bold 11px Inter, sans-serif',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -20),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          // Must be a NearFarScalar. A Cesium.Interval here used to be
          // accepted silently (its `far <= near` guard reads undefined <=
          // undefined → false) and cloned into {near: undefined, far:
          // undefined, ...} — NearFarScalar.interpolate then produced NaN
          // translucency and the documented beyond-1e9-m label fade never
          // happened. Verified against the installed Cesium Billboard
          // constructor and LabelVisualizer path.
          translucencyByDistance: new Cesium.NearFarScalar(1e9, 1.0, 5e9, 0.3),
        },
      });

      _entities.set(planetId, entity);
    }

    // Moon entity — uses Cesium's built-in ephemeris
    const moonDisplayRadius = 3_840_000 * 2; // 2× Moon radius for visibility
    const moonEntity = _viewer.entities.add({
      id: 'planet-moon',
      position: Cesium.Cartesian3.ZERO,
      ellipsoid: {
        radii: new Cesium.Cartesian3(moonDisplayRadius, moonDisplayRadius, moonDisplayRadius),
        material: new Cesium.Color(0.75, 0.75, 0.72, 0.95),
        outline: false,
        slicePartitions: 24,
        stackPartitions: 16,
      },
      label: {
        text: 'Moon',
        font: 'bold 11px Inter, sans-serif',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -16),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        // Same NearFarScalar requirement as the planet labels above.
        translucencyByDistance: new Cesium.NearFarScalar(1e9, 1.0, 5e9, 0.3),
      },
    });
    _entities.set('moon', moonEntity);

    // No preRender listener: updates are interval-driven (see _update). The
    // layer's previous preRender `_tick` + `holdContinuousRender` pair kept
    // the scene rendering continuously while enabled — repainting eight
    // nearly-static ellipsoids at frame rate — for a body whose fastest
    // visible motion is ~0.002%/minute.

    console.log('[Data:Planets] Initialized');
  },

  enable() {
    _enabled = true;

    // Show entities
    for (const entity of _entities.values()) {
      entity.show = true;
    }

    _startRefresh();
  },

  /**
   * Manager update contract: DataLayerManager calls `update(viewer, {signal})`
   * once during the enable transaction and rolls the enable back if the call
   * throws (manager.js enable path). Without this method the manager's
   * `entry.module.update(...)` was a TypeError — every Planets enable through
   * the manager (UI toggle included) failed and rolled back with the layer
   * stuck OFF. `updateInterval: 0` keeps the manager's own poll loop from
   * calling update again; the 60 s interval in _startRefresh drives motion.
   * @returns {Promise<boolean>} Always true — motion is interval-driven.
   */
  async update() {
    _update();
    return true;
  },

  disable() {
    _enabled = false;
    _stopRefresh();

    for (const entity of _entities.values()) {
      entity.show = false;
    }
  },

  destroy(viewer) {
    _stopRefresh();
    for (const entity of _entities.values()) {
      viewer.entities.remove(entity);
    }
    _entities.clear();
    _cachedPositions.clear();
    _viewer = null;
  },

  setParams(params = {}, { origin: _origin = 'programmatic' } = {}) {
    if ('showLabels' in params) {
      _params.showLabels = params.showLabels;
      for (const entity of _entities.values()) {
        entity.label.show = _params.showLabels && _enabled;
      }
    }
    return true;
  },

  getParams() {
    return { ..._params };
  },

  getDetectableObjects() {
    return [];
  },

  getRowControls() {
    return null;
  },
};

export default planetsLayer;
