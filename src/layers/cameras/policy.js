/**
 * Virtual camera policy: the camera descriptors a scenario (or a session) can
 * declare, their defaults, and the pure framing math behind them. No Cesium,
 * DOM or i18n imports, so the tests run without WebGL.
 *
 * Three camera types:
 * - `ground`: a tripod at a fixed place that turns to follow its target and
 *   zooms so the target keeps a chosen share of the frame.
 * - `chase`: rides behind the target at a distance, height and lateral offset.
 * - `orbit`: circles the target at a radius and height over a period.
 * @module layers/cameras/policy
 */

export const CAMERA_TYPES = Object.freeze(['ground', 'chase', 'orbit']);
export const ALTITUDE_REFERENCES = Object.freeze(['ground', 'ellipsoid']);
export const MAX_CAMERAS = 32;
export const FOV_LIMITS_DEG = Object.freeze([1.5, 75]);
export const FRAME_FRACTION_LIMITS = Object.freeze([0.05, 0.6]);
/** Target extent when a target carries no size: a mid-size airliner span. */
export const DEFAULT_TARGET_SIZE_M = 40;
/** Why a camera could not take the view (English; translated on show). */
export const COCKPIT_REFUSAL = 'Camera unavailable — exit cockpit first';
/** The pseudo camera that cuts between the real ones on its own. */
export const DIRECTOR_ID = 'director';
/** How often the Director re-scores its cameras, seconds. */
export const DIRECTOR_TICK_S = 0.5;
/** Shortest shot before the Director may cut again, seconds. */
export const DIRECTOR_MIN_DWELL_S = 4;
/** Seconds of flight the aim leads the target by, so it flies into frame. */
export const DEFAULT_LEAD_S = 0.4;
/** A tripod shot reads best inside this range, metres. */
export const TRIPOD_IDEAL_RANGE_M = Object.freeze([300, 4000]);
/** A tripod shot is dropped beyond this range, metres. */
export const TRIPOD_MAX_RANGE_M = 12_000;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DEG = Math.PI / 180;

export const CAMERA_DEFAULTS = Object.freeze({
  ground: Object.freeze({
    heightM: 2,
    altitudeReference: 'ground',
    frameFraction: 0.22,
    fovDeg: null,
    smoothingS: 0.25,
  }),
  chase: Object.freeze({
    distanceM: 250,
    heightOffsetM: 60,
    lateralM: 0,
    fovDeg: 50,
    smoothingS: 0.6,
  }),
  orbit: Object.freeze({
    radiusM: 400,
    heightOffsetM: 120,
    periodS: 40,
    phaseDeg: 0,
    fovDeg: 45,
    smoothingS: 0.4,
  }),
});

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, [min, max]) {
  return Math.min(max, Math.max(min, value));
}

function fail(message) {
  throw new TypeError(`Camera: ${message}`);
}

function numberField(entry, key, fallback, [min, max], where) {
  if (!Object.hasOwn(entry, key) || entry[key] === null) return fallback;
  const value = finite(entry[key]);
  if (value === null || value < min || value > max)
    fail(`${where}.${key} must be a number between ${min} and ${max}`);
  return value;
}

/**
 * Validate one camera descriptor and fill its defaults.
 * @param {object} entry Raw descriptor.
 * @param {number} [index] Position in the list, for messages.
 * @returns {object} Normalised camera.
 */
export function normalizeCamera(entry, index = 0) {
  const where = `cameras[${index}]`;
  if (!entry || typeof entry !== 'object') fail(`${where} must be an object`);
  const id = String(entry.id || '');
  if (!ID_PATTERN.test(id)) fail(`${where}.id is invalid`);
  const type = String(entry.type || 'ground');
  if (!CAMERA_TYPES.includes(type))
    fail(`${where}.type must be ground, chase or orbit`);
  const title = String(entry.title || id)
    .trim()
    .slice(0, 60);
  const target = entry.target == null ? null : String(entry.target);
  if (target !== null && !ID_PATTERN.test(target))
    fail(`${where}.target is invalid`);
  const defaults = CAMERA_DEFAULTS[type];
  const camera = {
    id,
    title,
    type,
    target,
    fovDeg:
      entry.fovDeg == null
        ? defaults.fovDeg
        : numberField(entry, 'fovDeg', defaults.fovDeg, FOV_LIMITS_DEG, where),
    smoothingS: numberField(
      entry,
      'smoothingS',
      defaults.smoothingS,
      [0, 5],
      where,
    ),
  };
  if (type === 'ground') {
    const lat = finite(entry.lat);
    const lon = finite(entry.lon);
    if (
      lat === null ||
      lon === null ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    )
      fail(`${where} needs lat/lon`);
    const altitudeReference = String(
      entry.altitudeReference || defaults.altitudeReference,
    );
    if (!ALTITUDE_REFERENCES.includes(altitudeReference))
      fail(`${where}.altitudeReference must be ground or ellipsoid`);
    Object.assign(camera, {
      lat,
      lon,
      altitudeReference,
      heightM: numberField(
        entry,
        'heightM',
        defaults.heightM,
        [-500, 30_000],
        where,
      ),
      frameFraction: numberField(
        entry,
        'frameFraction',
        defaults.frameFraction,
        FRAME_FRACTION_LIMITS,
        where,
      ),
    });
  } else if (type === 'chase') {
    Object.assign(camera, {
      distanceM: numberField(
        entry,
        'distanceM',
        defaults.distanceM,
        [5, 20_000],
        where,
      ),
      heightOffsetM: numberField(
        entry,
        'heightOffsetM',
        defaults.heightOffsetM,
        [-2000, 5000],
        where,
      ),
      lateralM: numberField(
        entry,
        'lateralM',
        defaults.lateralM,
        [-5000, 5000],
        where,
      ),
    });
  } else {
    Object.assign(camera, {
      radiusM: numberField(
        entry,
        'radiusM',
        defaults.radiusM,
        [5, 20_000],
        where,
      ),
      heightOffsetM: numberField(
        entry,
        'heightOffsetM',
        defaults.heightOffsetM,
        [-2000, 5000],
        where,
      ),
      periodS: numberField(
        entry,
        'periodS',
        defaults.periodS,
        [2, 3600],
        where,
      ),
      phaseDeg: numberField(
        entry,
        'phaseDeg',
        defaults.phaseDeg,
        [-360, 360],
        where,
      ),
    });
  }
  return camera;
}

/**
 * Validate a scenario's optional camera list. Targets must name aircraft in
 * `aircraftIds` when that list is given.
 * @param {object[]|undefined} list
 * @param {string[]} [aircraftIds]
 * @returns {object[]}
 */
export function normalizeCameraList(list, aircraftIds = null) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) fail('cameras must be an array');
  if (list.length > MAX_CAMERAS) fail(`at most ${MAX_CAMERAS} cameras`);
  const ids = new Set();
  return list.map((entry, index) => {
    const camera = normalizeCamera(entry, index);
    if (ids.has(camera.id)) fail(`cameras[${index}].id "${camera.id}" repeats`);
    ids.add(camera.id);
    if (
      camera.target !== null &&
      Array.isArray(aircraftIds) &&
      !aircraftIds.includes(camera.target)
    )
      fail(`cameras[${index}].target "${camera.target}" is not an aircraft`);
    return camera;
  });
}

/**
 * Vertical field of view that keeps a target of `targetSizeM` across
 * `frameFraction` of the frame height at `distanceM`, within the limits. A
 * fixed `fixedFovDeg` wins over the automatic value.
 * @returns {number} Radians.
 */
export function autoFovRad({
  distanceM,
  targetSizeM = DEFAULT_TARGET_SIZE_M,
  frameFraction = CAMERA_DEFAULTS.ground.frameFraction,
  fixedFovDeg = null,
}) {
  const [minDeg, maxDeg] = FOV_LIMITS_DEG;
  if (Number.isFinite(fixedFovDeg) && fixedFovDeg !== null)
    return clamp(fixedFovDeg, FOV_LIMITS_DEG) * DEG;
  const size =
    Number.isFinite(targetSizeM) && targetSizeM > 0
      ? targetSizeM
      : DEFAULT_TARGET_SIZE_M;
  const fraction = clamp(
    Number.isFinite(frameFraction)
      ? frameFraction
      : CAMERA_DEFAULTS.ground.frameFraction,
    FRAME_FRACTION_LIMITS,
  );
  if (!Number.isFinite(distanceM) || distanceM <= 0) return maxDeg * DEG;
  const fov = 2 * Math.atan(size / fraction / (2 * distanceM));
  return clamp(fov / DEG, [minDeg, maxDeg]) * DEG;
}

/**
 * Exponential smoothing weight for a frame of `dtS` seconds and a time
 * constant: 0 holds the previous value, 1 jumps to the new one.
 * @param {number} dtS
 * @param {number} timeConstantS
 * @returns {number}
 */
export function smoothingAlpha(dtS, timeConstantS) {
  if (!(dtS > 0)) return 0;
  if (!(timeConstantS > 0)) return 1;
  return 1 - Math.exp(-dtS / timeConstantS);
}

/**
 * Chase offset in the target's east-north-up frame: behind the track by
 * `distanceM`, above by `heightOffsetM`, to the right by `lateralM`.
 * @returns {{east:number, north:number, up:number}}
 */
export function chaseOffsetEnu({
  headingDeg,
  distanceM,
  heightOffsetM = 0,
  lateralM = 0,
}) {
  const h = (headingDeg || 0) * DEG;
  const sin = Math.sin(h);
  const cos = Math.cos(h);
  return {
    east: -sin * distanceM + cos * lateralM,
    north: -cos * distanceM - sin * lateralM,
    up: heightOffsetM,
  };
}

/**
 * Orbit offset in the target's east-north-up frame at a scenario time.
 * @returns {{east:number, north:number, up:number}}
 */
export function orbitOffsetEnu({
  timeS,
  periodS,
  radiusM,
  heightOffsetM = 0,
  phaseDeg = 0,
}) {
  const period = periodS > 0 ? periodS : 1;
  const angle = (phaseDeg + (360 * (timeS || 0)) / period) * DEG;
  return {
    east: Math.sin(angle) * radiusM,
    north: Math.cos(angle) * radiusM,
    up: heightOffsetM,
  };
}

/**
 * A session ground camera at the viewer's current position, aimed at a target.
 * @param {{lat:number, lon:number, heightM:number}} where Ellipsoidal position.
 * @param {string|null} target Aircraft id.
 * @param {number} ordinal 1-based number for the id.
 * @param {string} [title] Display title; the id when omitted.
 * @returns {object}
 */
export function placedGroundCamera(where, target, ordinal, title) {
  return normalizeCamera({
    id: `session-${ordinal}`,
    title: title || `session-${ordinal}`,
    type: 'ground',
    target,
    lat: where.lat,
    lon: where.lon,
    heightM: where.heightM,
    altitudeReference: 'ellipsoid',
  });
}

/**
 * Where the aim point sits ahead of a moving target, in its east-north-up
 * frame: the target's velocity for `leadS` seconds.
 * @returns {{east:number, north:number, up:number}}
 */
export function leadOffsetEnu({
  headingDeg,
  pitchDeg = 0,
  speedMps = 0,
  leadS = DEFAULT_LEAD_S,
}) {
  const along = Math.max(0, speedMps || 0) * Math.max(0, leadS || 0);
  if (!(along > 0)) return { east: 0, north: 0, up: 0 };
  const h = (headingDeg || 0) * DEG;
  const p = (pitchDeg || 0) * DEG;
  const ground = along * Math.cos(p);
  return {
    east: Math.sin(h) * ground,
    north: Math.cos(h) * ground,
    up: Math.sin(p) * along,
  };
}

/**
 * How good a shot a camera offers right now, higher is better; `-Infinity`
 * rules it out. Tripods are judged on range and elevation and fail when the
 * line of sight is blocked; chase and orbit are steady fallbacks. The current
 * camera gets a small bonus so the Director does not flicker between equals.
 * @param {{type:string, distanceM:number, elevationDeg?:number|null, occluded?:boolean, isCurrent?:boolean}} shot
 * @returns {number}
 */
export function scoreShot({
  type,
  distanceM,
  elevationDeg = null,
  occluded = false,
  isCurrent = false,
}) {
  if (occluded) return -Infinity;
  let score;
  if (type === 'ground') {
    if (!Number.isFinite(distanceM) || distanceM > TRIPOD_MAX_RANGE_M)
      return -Infinity;
    const [near, far] = TRIPOD_IDEAL_RANGE_M;
    if (distanceM < near) score = 0.55 + 0.45 * (distanceM / near);
    else if (distanceM <= far) score = 1;
    else
      score = Math.max(0.1, 1 - (distanceM - far) / (TRIPOD_MAX_RANGE_M - far));
    // Looking almost straight up or along the ground reads badly.
    if (elevationDeg !== null) {
      if (elevationDeg > 60) score *= 0.5;
      else if (elevationDeg < 1) score *= 0.7;
    }
  } else if (type === 'chase') {
    score = 0.45;
  } else {
    score = 0.4;
  }
  return score + (isCurrent ? 0.15 : 0);
}

/**
 * The Director's pick: keep the current shot through its minimum dwell while
 * it is still valid, otherwise the best-scoring candidate.
 * @param {{id:string, score:number}[]} candidates
 * @param {{currentId:string|null, lastCutAtS:number, nowS:number, minDwellS?:number}} state
 * @returns {string|null}
 */
export function chooseShot(
  candidates,
  {
    currentId = null,
    lastCutAtS = -Infinity,
    nowS = 0,
    minDwellS = DIRECTOR_MIN_DWELL_S,
  },
) {
  const valid = candidates.filter((c) => Number.isFinite(c.score));
  if (valid.length === 0) return null;
  const current = valid.find((c) => c.id === currentId) || null;
  if (current && nowS - lastCutAtS < minDwellS) return currentId;
  let best = valid[0];
  for (const candidate of valid)
    if (candidate.score > best.score) best = candidate;
  if (current && best.score <= current.score) return currentId;
  return best.id;
}
