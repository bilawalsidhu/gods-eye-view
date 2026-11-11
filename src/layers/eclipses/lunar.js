/**
 * Lunar eclipse geometry from the catalogue's own figures. Pure math.
 *
 * A lunar eclipse is the Moon crossing the Earth's shadow, so it looks the
 * same from everywhere: what differs from place to place is only whether the
 * Moon is up. The catalogue gives, for each eclipse, how close the Moon's
 * centre passes to the shadow's axis (gamma), how deep it goes into the
 * penumbra and the umbra (the magnitudes), how long each phase lasts, and the
 * place that has the Moon overhead at greatest eclipse. From those the
 * shadow's two radii and the Moon's speed across it follow, in Earth radii at
 * the Moon's distance.
 *
 * Catalogue: Five Millennium Canon of Lunar Eclipses (Espenak and Meeus,
 * NASA's GSFC).
 */

/** The Moon's radius in Earth equatorial radii. */
export const MOON_RADIUS = 0.2725076;
/** Earth radii from the Earth's centre to the Moon, near enough for a view. */
export const MOON_DISTANCE = 60.27;
/**
 * Degrees of longitude an hour the place under the Moon moves west: the
 * Earth's turn less the Moon's own motion along its orbit.
 */
const SUBLUNAR_DRIFT = 14.492;
/**
 * Degrees from the place under the Moon to where it sits on the horizon: a
 * right angle, less the Moon's parallax, plus refraction.
 */
export const MOON_HORIZON_DEG = 89.6;
const RAD = Math.PI / 180;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

const KINDS = Object.freeze({
  N: 'lunar-penumbral',
  P: 'lunar-partial',
  T: 'lunar-total',
});

/**
 * One lunar eclipse from a row of lunar.json (see its `columns`). `startMs`
 * and `endMs` are the first and last contact with the penumbra.
 */
export function createLunarEclipse(row) {
  const [
    year,
    month,
    day,
    greatestTdSeconds,
    deltaT,
    typeCode,
    saros,
    gamma,
    penumbralMagnitude,
    umbralMagnitude,
    penumbralMinutes,
    partialMinutes,
    totalMinutes,
    zenithLat,
    zenithLon,
  ] = row;
  const greatestMs =
    Date.UTC(year, month - 1, day) + greatestTdSeconds * 1000 - deltaT * 1000;
  const pad = (value) => String(value).padStart(2, '0');
  const miss = Math.abs(gamma);
  // A magnitude is how far the Moon's far limb reaches into a shadow, in
  // Moon diameters: that fixes each shadow's radius.
  const radius = (magnitude) =>
    2 * MOON_RADIUS * magnitude + miss - MOON_RADIUS;
  const penumbraRadius = radius(penumbralMagnitude);
  const umbraRadius = radius(umbralMagnitude);
  // The Moon crosses the penumbra's chord in the penumbral phase's time.
  const halfChord = Math.sqrt(
    Math.max(0, (penumbraRadius + MOON_RADIUS) ** 2 - miss * miss),
  );
  const half = (minutes) => (minutes * MINUTE_MS) / 2;
  return Object.freeze({
    id: `${year}-${pad(month)}-${pad(day)}`,
    body: 'lunar',
    year,
    month,
    day,
    typeCode,
    kind: KINDS[typeCode[0]] ?? 'lunar-penumbral',
    saros,
    gamma,
    penumbralMagnitude,
    umbralMagnitude,
    penumbralMinutes,
    partialMinutes,
    totalMinutes,
    greatest: Object.freeze({ lat: zenithLat, lon: zenithLon }),
    greatestMs,
    deltaT,
    startMs: greatestMs - half(penumbralMinutes),
    endMs: greatestMs + half(penumbralMinutes),
    penumbraRadius,
    umbraRadius,
    /** Earth radii an hour, across the shadow. */
    speed: halfChord / (penumbralMinutes / 120),
    /** When each phase begins and ends; null for a phase that never comes. */
    contacts: Object.freeze({
      penumbral: [
        greatestMs - half(penumbralMinutes),
        greatestMs + half(penumbralMinutes),
      ],
      partial: partialMinutes
        ? [greatestMs - half(partialMinutes), greatestMs + half(partialMinutes)]
        : null,
      total: totalMinutes
        ? [greatestMs - half(totalMinutes), greatestMs + half(totalMinutes)]
        : null,
    }),
  });
}

/** The place that has the Moon overhead at `ms`, in geodetic degrees. */
export function sublunarPoint(eclipse, ms) {
  const hours = (ms - eclipse.greatestMs) / HOUR_MS;
  const lon = eclipse.greatest.lon - SUBLUNAR_DRIFT * hours;
  return { lat: eclipse.greatest.lat, lon: ((lon + 540) % 360) - 180 };
}

/** The unit vector from the Earth's centre to the Moon at `ms`, Earth-fixed. */
export function moonDirection(eclipse, ms) {
  const { lat, lon } = sublunarPoint(eclipse, ms);
  const cos = Math.cos(lat * RAD);
  return [
    cos * Math.cos(lon * RAD),
    cos * Math.sin(lon * RAD),
    Math.sin(lat * RAD),
  ];
}

/**
 * Where the Moon's centre stands from the shadow's axis at `ms`, in Earth
 * radii: `x` toward celestial east (the way the Moon travels) and `y` north.
 */
export function moonInShadow(eclipse, ms) {
  return {
    x: (eclipse.speed * (ms - eclipse.greatestMs)) / HOUR_MS,
    y: eclipse.gamma,
  };
}

/**
 * How the eclipse stands at `ms`: `phase` is `none`, `penumbral`, `partial`
 * or `total`, and `umbral` the share of the Moon's diameter inside the umbra
 * (0 to 1; above 1 the whole Moon is inside).
 */
export function lunarStateAt(eclipse, ms) {
  const { x, y } = moonInShadow(eclipse, ms);
  const distance = Math.hypot(x, y);
  const depth = (radius) =>
    (radius + MOON_RADIUS - distance) / (2 * MOON_RADIUS);
  const umbral = depth(eclipse.umbraRadius);
  const penumbral = depth(eclipse.penumbraRadius);
  const phase =
    umbral >= 1
      ? 'total'
      : umbral > 0
        ? 'partial'
        : penumbral > 0
          ? 'penumbral'
          : 'none';
  return { phase, umbral, penumbral, distance, x, y };
}

/**
 * The line where the Moon sits on the horizon at `ms`: the edge of the half
 * of the Earth that can see it, as geodetic points round the place under the
 * Moon.
 */
export function moonHorizon(eclipse, ms, steps = 180) {
  const centre = sublunarPoint(eclipse, ms);
  const lat0 = centre.lat * RAD;
  const lon0 = centre.lon * RAD;
  const reach = MOON_HORIZON_DEG * RAD;
  const points = [];
  for (let step = 0; step <= steps; step += 1) {
    const bearing = (step / steps) * 2 * Math.PI;
    const lat = Math.asin(
      Math.sin(lat0) * Math.cos(reach) +
        Math.cos(lat0) * Math.sin(reach) * Math.cos(bearing),
    );
    const lon =
      lon0 +
      Math.atan2(
        Math.sin(bearing) * Math.sin(reach) * Math.cos(lat0),
        Math.cos(reach) - Math.sin(lat0) * Math.sin(lat),
      );
    points.push({ lat: lat / RAD, lon: ((lon / RAD + 540) % 360) - 180 });
  }
  return points;
}

/** How high the Moon stands at geodetic `lat`, `lon` at `ms`, in degrees. */
export function moonAltitude(eclipse, ms, lat, lon) {
  const moon = moonDirection(eclipse, ms);
  const cos = Math.cos(lat * RAD);
  const up = [
    cos * Math.cos(lon * RAD),
    cos * Math.sin(lon * RAD),
    Math.sin(lat * RAD),
  ];
  const separation =
    Math.acos(
      Math.max(
        -1,
        Math.min(1, up[0] * moon[0] + up[1] * moon[1] + up[2] * moon[2]),
      ),
    ) / RAD;
  return MOON_HORIZON_DEG - separation;
}
