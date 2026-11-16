/**
 * Solar eclipse geometry from Besselian elements. Pure math, no Cesium.
 *
 * The elements describe the Moon's shadow on the fundamental plane: the plane
 * through the Earth's centre at right angles to the shadow axis. Here the
 * plane and the axis are turned into Earth-fixed vectors (x through 0°E on
 * the equator, z through the north pole) in units of the equatorial radius,
 * so every question is plain 3D geometry against the WGS84 ellipsoid: the
 * axis is a line, the umbra and penumbra are cones around it.
 *
 * Elements: Five Millennium Canon of Solar Eclipses (Espenak and Meeus,
 * NASA's GSFC). Method: Explanatory Supplement to the Astronomical Almanac,
 * chapter 8, and Meeus, Elements of Solar Eclipses.
 */

/** Equatorial radius the elements are scaled by, in metres. */
export const EARTH_RADIUS_M = 6378137;
const FLATTENING = 1 / 298.257223563;
const POLAR_RATIO = 1 - FLATTENING;
const ECCENTRICITY_SQ = FLATTENING * (2 - FLATTENING);
const RAD = Math.PI / 180;
const HOUR_MS = 3_600_000;
/**
 * Degrees the Earth turns in one second of Delta T: the elements count the
 * hour angle from the ephemeris meridian, east of Greenwich by this much.
 */
const DELTA_T_DEGREES = 0.00417807;

const KINDS = Object.freeze({
  T: 'total',
  A: 'annular',
  H: 'hybrid',
  P: 'partial',
});

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const along = (origin, direction, s) => [
  origin[0] + direction[0] * s,
  origin[1] + direction[1] * s,
  origin[2] + direction[2] * s,
];
const horner = (c, t) => c.reduceRight((sum, value) => sum * t + value, 0);

/**
 * One eclipse from a row of elements.json (see its `columns`).
 * `startMs` and `endMs` bound the hours the polynomials hold for.
 */
export function createEclipse(row) {
  const [
    year,
    month,
    day,
    greatestTdSeconds,
    deltaT,
    typeCode,
    saros,
    gamma,
    magnitude,
    greatestLat,
    greatestLon,
    pathWidthKm,
    centralDurationSeconds,
    t0,
    tmin,
    tmax,
    x,
    y,
    d,
    mu,
    l1,
    l2,
    tanF1,
    tanF2,
  ] = row;
  const dayMs = Date.UTC(year, month - 1, day);
  // Terrestrial Time runs Delta T ahead of the clock the world keeps.
  const t0Ms = dayMs + t0 * HOUR_MS - deltaT * 1000;
  const pad = (value) => String(value).padStart(2, '0');
  return Object.freeze({
    id: `${year}-${pad(month)}-${pad(day)}`,
    body: 'solar',
    year,
    month,
    day,
    typeCode,
    kind: KINDS[typeCode[0]] ?? 'partial',
    saros,
    gamma,
    magnitude,
    greatest: Object.freeze({ lat: greatestLat, lon: greatestLon }),
    greatestMs: dayMs + greatestTdSeconds * 1000 - deltaT * 1000,
    pathWidthKm,
    centralDurationSeconds,
    deltaT,
    t0Ms,
    startMs: t0Ms + tmin * HOUR_MS,
    endMs: t0Ms + tmax * HOUR_MS,
    x,
    y,
    d,
    mu,
    l1,
    l2,
    tanF1,
    tanF2,
  });
}

/**
 * The shadow at `ms`, Earth-fixed, in equatorial radii: `origin` is where
 * the axis crosses the fundamental plane, `k` points up the axis toward the
 * Moon and Sun, `i` (east) and `j` (north) span the plane. `l1` and `l2` are
 * the penumbra's and umbra's radii on the plane; each cone narrows by its
 * `tanF` per radius of height above the plane. `l2` is negative where the
 * umbra reaches the plane (a total eclipse).
 */
export function shadowFrame(eclipse, ms) {
  const t = (ms - eclipse.t0Ms) / HOUR_MS;
  const x = horner(eclipse.x, t);
  const y = horner(eclipse.y, t);
  const d = horner(eclipse.d, t) * RAD;
  const lon = -(horner(eclipse.mu, t) - DELTA_T_DEGREES * eclipse.deltaT) * RAD;
  const cosD = Math.cos(d);
  const sinD = Math.sin(d);
  const cosLon = Math.cos(lon);
  const sinLon = Math.sin(lon);
  const i = [-sinLon, cosLon, 0];
  const j = [-sinD * cosLon, -sinD * sinLon, cosD];
  return {
    origin: [x * i[0] + y * j[0], x * i[1] + y * j[1], y * j[2]],
    k: [cosD * cosLon, cosD * sinLon, sinD],
    i,
    j,
    x,
    y,
    l1: horner(eclipse.l1, t),
    l2: horner(eclipse.l2, t),
    tanF1: eclipse.tanF1,
    tanF2: eclipse.tanF2,
  };
}

/**
 * Where the line from `origin` along `direction` leaves the ellipsoid on the
 * far side (toward the Sun, for a line along the axis), or null if it misses.
 */
export function surfaceAlong(origin, direction) {
  const oz = origin[2] / POLAR_RATIO;
  const dz = direction[2] / POLAR_RATIO;
  const a = direction[0] ** 2 + direction[1] ** 2 + dz * dz;
  const b = origin[0] * direction[0] + origin[1] * direction[1] + oz * dz;
  const c = origin[0] ** 2 + origin[1] ** 2 + oz * oz - 1;
  const disc = b * b - a * c;
  if (disc < 0) return null;
  return along(origin, direction, (-b + Math.sqrt(disc)) / a);
}

/** An Earth-fixed point (radii) as geodetic degrees. */
export function toGeodetic(point) {
  const p = Math.hypot(point[0], point[1]);
  let lat = Math.atan2(point[2], p * (1 - ECCENTRICITY_SQ));
  for (let pass = 0; pass < 5; pass += 1) {
    const sin = Math.sin(lat);
    const n = 1 / Math.sqrt(1 - ECCENTRICITY_SQ * sin * sin);
    lat = Math.atan2(point[2] + ECCENTRICITY_SQ * n * sin, p);
  }
  return { lat: lat / RAD, lon: Math.atan2(point[1], point[0]) / RAD };
}

/** A point on the ellipsoid at geodetic degrees, Earth-fixed, in radii. */
export function fromGeodetic(lat, lon) {
  const sin = Math.sin(lat * RAD);
  const cos = Math.cos(lat * RAD);
  const n = 1 / Math.sqrt(1 - ECCENTRICITY_SQ * sin * sin);
  return [
    n * cos * Math.cos(lon * RAD),
    n * cos * Math.sin(lon * RAD),
    n * (1 - ECCENTRICITY_SQ) * sin,
  ];
}

/** Where the shadow axis meets the ground at `ms`, or null when it misses. */
export function centralPoint(eclipse, ms, frame = shadowFrame(eclipse, ms)) {
  return surfaceAlong(frame.origin, frame.k);
}

/**
 * The ground point on a shadow cone's edge, `angle` radians round the axis
 * from east through north; null where that edge misses the Earth.
 * @param {'umbra'|'penumbra'} cone
 */
export function shadowEdgePoint(frame, cone, angle) {
  const l = cone === 'umbra' ? frame.l2 : frame.l1;
  const tanF = cone === 'umbra' ? frame.tanF2 : frame.tanF1;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const u = [
    cos * frame.i[0] + sin * frame.j[0],
    cos * frame.i[1] + sin * frame.j[1],
    cos * frame.i[2] + sin * frame.j[2],
  ];
  // The cone's radius depends on the height it meets the ground at, and the
  // height on the radius: a few passes settle both.
  let radius = Math.abs(l);
  let point = null;
  for (let pass = 0; pass < 4; pass += 1) {
    point = surfaceAlong(along(frame.origin, u, radius), frame.k);
    if (!point) return null;
    radius = Math.abs(l - dot(point, frame.k) * tanF);
  }
  return point;
}

/**
 * What an observer at Earth-fixed `point` sees at `ms`: `magnitude` is the
 * share of the Sun's diameter covered (0 outside the penumbra), `central`
 * whether the point is inside the umbra or antumbra, `total` whether that
 * is a total eclipse, and `sunUp` whether the Sun is above the horizon.
 */
export function circumstancesAt(eclipse, ms, point) {
  const frame = shadowFrame(eclipse, ms);
  const zeta = dot(point, frame.k);
  const r = [
    point[0] - frame.origin[0],
    point[1] - frame.origin[1],
    point[2] - frame.origin[2],
  ];
  const m = Math.hypot(dot(r, frame.i), dot(r, frame.j));
  const penumbra = frame.l1 - zeta * frame.tanF1;
  const umbra = frame.l2 - zeta * frame.tanF2;
  const central = m < Math.abs(umbra);
  const magnitude = central
    ? (penumbra - umbra) / (penumbra + umbra)
    : Math.max(0, (penumbra - m) / (penumbra + umbra));
  return { magnitude, central, total: central && umbra < 0, sunUp: zeta > 0 };
}

/** The offset of a ground point from the axis, on the fundamental plane. */
function offsetOnPlane(eclipse, ms, point) {
  const frame = shadowFrame(eclipse, ms);
  const r = [
    point[0] - frame.origin[0],
    point[1] - frame.origin[1],
    point[2] - frame.origin[2],
  ];
  return [dot(r, frame.i), dot(r, frame.j)];
}

/**
 * How the shadow moves past the ground point under its axis at `ms`: the
 * direction on the fundamental plane (radians from east through north) and
 * the speed in radii per hour. The ground turns with the Earth meanwhile, so
 * this is the motion an observer there sees.
 */
export function shadowMotion(eclipse, ms, point) {
  const span = 2000;
  const before = offsetOnPlane(eclipse, ms - span / 2, point);
  const after = offsetOnPlane(eclipse, ms + span / 2, point);
  // The point's offset from the axis falls as the axis moves toward it.
  const dx = before[0] - after[0];
  const dy = before[1] - after[1];
  return {
    angle: Math.atan2(dy, dx),
    speed: (Math.hypot(dx, dy) / span) * HOUR_MS,
  };
}

/**
 * Seconds of totality or annularity on the central line at `ms`, or null
 * when the axis misses the Earth.
 */
export function centralDurationSeconds(eclipse, ms) {
  const frame = shadowFrame(eclipse, ms);
  const point = centralPoint(eclipse, ms, frame);
  if (!point) return null;
  const radius = Math.abs(frame.l2 - dot(point, frame.k) * frame.tanF2);
  const { speed } = shadowMotion(eclipse, ms, point);
  return speed > 0 ? ((2 * radius) / speed) * 3600 : null;
}

/** The time in [low, high] where `test` turns from false to true (or back). */
function crossing(test, low, high) {
  const first = test(low);
  for (let pass = 0; pass < 30 && high - low > 50; pass += 1) {
    const mid = (low + high) / 2;
    if (test(mid) === first) low = mid;
    else high = mid;
  }
  return first ? low : high;
}

/** The first and last time in the eclipse's hours that `test` holds. */
function spanWhere(eclipse, test, stepMs = 60_000) {
  let start = null;
  let end = null;
  let previous = eclipse.startMs;
  let was = test(previous);
  if (was) start = previous;
  for (let ms = previous + stepMs; ; ms += stepMs) {
    const at = Math.min(ms, eclipse.endMs);
    const is = test(at);
    if (is && !was && start === null) start = crossing(test, previous, at);
    if (!is && was) end = crossing(test, previous, at);
    if (is) end = at === eclipse.endMs ? at : end;
    previous = at;
    was = is;
    if (at === eclipse.endMs) break;
  }
  if (start === null) return null;
  return { startMs: start, endMs: end ?? eclipse.endMs };
}

/**
 * When the penumbra is on the Earth: from the first place to see a partial
 * eclipse begin to the last to see one end.
 */
export function penumbralSpan(eclipse) {
  return (
    spanWhere(eclipse, (ms) => {
      const frame = shadowFrame(eclipse, ms);
      // Polar flattening pulls the limb in by at most 1/298; the middle of
      // that range is right to a few seconds.
      return Math.hypot(frame.x, frame.y) < 0.9983 + frame.l1;
    }) ?? { startMs: eclipse.startMs, endMs: eclipse.endMs }
  );
}

/** When the shadow axis is on the Earth, or null for a non-central eclipse. */
export function centralSpan(eclipse) {
  if (eclipse.kind === 'partial') return null;
  return spanWhere(eclipse, (ms) => centralPoint(eclipse, ms) !== null);
}

/** Directions round the axis the umbra's rim is sampled at. */
const RIM_STEPS = 48;

/**
 * The umbra's rim on the ground at one moment, as Earth-fixed points. Where
 * part of the umbra hangs off the Earth (near the ends of the path) the rim
 * is cut by the Earth's limb: found by halving between the axis, which is on
 * the ground, and the rim, which is not.
 */
function umbraRim(frame, point) {
  const radius = Math.abs(frame.l2 - dot(point, frame.k) * frame.tanF2);
  const rim = [];
  for (let step = 0; step < RIM_STEPS; step += 1) {
    const angle = (step / RIM_STEPS) * 2 * Math.PI;
    const whole = shadowEdgePoint(frame, 'umbra', angle);
    if (whole) {
      rim.push(whole);
      continue;
    }
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    let found = point;
    let low = 0;
    let high = 1;
    for (let pass = 0; pass < 20; pass += 1) {
      const share = ((low + high) / 2) * radius;
      const hit = surfaceAlong(
        [
          frame.origin[0] + (cos * frame.i[0] + sin * frame.j[0]) * share,
          frame.origin[1] + (cos * frame.i[1] + sin * frame.j[1]) * share,
          frame.origin[2] + (cos * frame.i[2] + sin * frame.j[2]) * share,
        ],
        frame.k,
      );
      if (hit) {
        found = hit;
        low = (low + high) / 2;
      } else high = (low + high) / 2;
    }
    rim.push(found);
  }
  return rim;
}

const cross = (u, v) => [
  u[1] * v[2] - u[2] * v[1],
  u[2] * v[0] - u[0] * v[2],
  u[0] * v[1] - u[1] * v[0],
];

/**
 * The path of totality or annularity: the central line and the two edges of
 * the band the umbra sweeps, as geodetic points in time order. The edges are
 * the outline of everything the umbra covers: at each point of the central
 * line, how far to either side any of the umbra's rims reaches. So the band
 * narrows to a point at each end, where the umbra comes onto the Earth and
 * leaves it stretched thin along the track. Null for a partial eclipse, or
 * one whose axis misses the Earth.
 * @returns {{startMs: number, endMs: number,
 *   center: {lat: number, lon: number, ms: number}[],
 *   left: {lat: number, lon: number}[], right: {lat: number, lon: number}[],
 *   outline: {lat: number, lon: number}[]} | null} `outline` is the band's
 *   closed edge: both sides and the rounded ends.
 */
export function centralPath(eclipse, stepMs = 60_000) {
  const span = centralSpan(eclipse);
  if (!span) return null;
  const times = [span.startMs];
  // Finer near the ends, where the shadow races along the ground.
  const fine = Math.min(stepMs, 10_000);
  const edge = 5 * 60_000;
  for (let ms = span.startMs + fine; ms < span.endMs;) {
    times.push(ms);
    const nearEnd = ms - span.startMs < edge || span.endMs - ms < edge + stepMs;
    ms += nearEnd ? fine : stepMs;
  }
  times.push(span.endMs);
  const points = [];
  const center = [];
  const rims = [];
  for (const ms of times) {
    const frame = shadowFrame(eclipse, ms);
    const point = centralPoint(eclipse, ms, frame);
    if (!point) continue;
    points.push(point);
    center.push({ ...toGeodetic(point), ms });
    rims.push(umbraRim(frame, point));
  }
  if (center.length < 2) return null;
  // Across the track at each central point: the unit vector to its left.
  const count = points.length;
  const across = points.map((point, index) => {
    const ahead = points[Math.min(count - 1, index + 1)];
    const behind = points[Math.max(0, index - 1)];
    const along = [
      ahead[0] - behind[0],
      ahead[1] - behind[1],
      ahead[2] - behind[2],
    ];
    const normal = cross(point, along);
    const length = Math.hypot(normal[0], normal[1], normal[2]) || 1;
    return [normal[0] / length, normal[1] / length, normal[2] / length];
  });
  // Each rim point belongs to the central point it lies nearest; there it
  // may push the band's edge out on its side.
  const reachLeft = new Float64Array(count);
  const reachRight = new Float64Array(count);
  rims.forEach((rim, at) => {
    for (const rimPoint of rim) {
      // Rims stretch far along the track near the ends, so look well beyond
      // the moment the rim was cast at.
      let nearest = at;
      let best = Infinity;
      const from = Math.max(0, at - 60);
      const to = Math.min(count - 1, at + 60);
      for (let index = from; index <= to; index += 1) {
        const p = points[index];
        const gap =
          (rimPoint[0] - p[0]) ** 2 +
          (rimPoint[1] - p[1]) ** 2 +
          (rimPoint[2] - p[2]) ** 2;
        if (gap < best) {
          best = gap;
          nearest = index;
        }
      }
      const p = points[nearest];
      const side =
        (rimPoint[0] - p[0]) * across[nearest][0] +
        (rimPoint[1] - p[1]) * across[nearest][1] +
        (rimPoint[2] - p[2]) * across[nearest][2];
      if (side > reachLeft[nearest]) reachLeft[nearest] = side;
      if (-side > reachRight[nearest]) reachRight[nearest] = -side;
    }
  });
  const offset = (index, reach) => {
    const p = points[index];
    const n = across[index];
    return toGeodetic([
      p[0] + n[0] * reach,
      p[1] + n[1] * reach,
      p[2] + n[2] * reach,
    ]);
  };
  const left = points.map((_, index) => offset(index, reachLeft[index]));
  const right = points.map((_, index) => offset(index, -reachRight[index]));
  // Each end of the band is rounded off behind its last central point, from
  // one edge round to the other: the umbra comes onto the Earth, and leaves
  // it, as a whole disc and not edge first.
  const cap = (index, backward) => {
    const p = points[index];
    const n = across[index];
    // Along the track, pointing away from the band.
    const away = cross(n, p).map((value) => value * backward);
    const length = Math.hypot(away[0], away[1], away[2]) || 1;
    const round = [];
    const steps = 10;
    for (let step = 1; step < steps; step += 1) {
      const turn = (step / steps) * Math.PI;
      // From the left edge (turn 0) through the back to the right (turn π).
      const reach =
        reachLeft[index] +
        (reachRight[index] - reachLeft[index]) * (step / steps);
      const sideways = Math.cos(turn) * reach;
      const behind = (Math.sin(turn) * reach) / length;
      round.push(
        toGeodetic([
          p[0] + n[0] * sideways + away[0] * behind,
          p[1] + n[1] * sideways + away[1] * behind,
          p[2] + n[2] * sideways + away[2] * behind,
        ]),
      );
    }
    return round;
  };
  // Round the band clockwise from its start: up the left edge, round the far
  // end to the right edge, back down it, and round the near end.
  const outline = [
    ...left,
    ...cap(count - 1, 1),
    ...right.toReversed(),
    ...cap(0, -1).toReversed(),
    left[0],
  ];
  return { ...span, center, left, right, outline };
}

/**
 * The eclipse whose shadow is on the Earth at `ms`, if any. `eclipses` is in
 * time order; no two overlap.
 */
export function eclipseAt(eclipses, ms) {
  let low = 0;
  let high = eclipses.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const eclipse = eclipses[mid];
    if (ms < eclipse.startMs) high = mid - 1;
    else if (ms > eclipse.endMs) low = mid + 1;
    else return eclipse;
  }
  return null;
}

/** The index of the first eclipse still to end at `ms` (the last, past them all). */
export function nextEclipseIndex(eclipses, ms) {
  const index = eclipses.findIndex((eclipse) => eclipse.endMs >= ms);
  return index < 0 ? eclipses.length - 1 : index;
}
