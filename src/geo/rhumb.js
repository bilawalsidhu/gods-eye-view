/**
 * @module geo/rhumb
 * @description Rhumb lines on the WGS84 ellipsoid, by the default
 * renderer's own method (`EllipsoidRhumbLine`): the same series in the same
 * order, so points along one land where the renderer put them. Angles in
 * radians, distances in metres.
 */
import { WGS84 } from './ellipsoid.js';
import { negativePiToPi } from './vector.js';

const MAJOR = WGS84.radii.x;
const MINOR = WGS84.radii.z;
const E2 = (MAJOR * MAJOR - MINOR * MINOR) / (MAJOR * MAJOR);
const E = Math.sqrt(E2);
const HALF_PI = Math.PI / 2;
const EPSILON8 = 1e-8;
const EPSILON10 = 1e-10;

/** Meridian distance from the equator to `phi`. */
function meridian(phi) {
  const e2 = E2;
  const e4 = e2 * e2;
  const e6 = e4 * e2;
  const e8 = e6 * e2;
  const e10 = e8 * e2;
  const e12 = e10 * e2;
  return (
    MAJOR *
    ((1 -
      e2 / 4 -
      (3 * e4) / 64 -
      (5 * e6) / 256 -
      (175 * e8) / 16384 -
      (441 * e10) / 65536 -
      (4851 * e12) / 1048576) *
      phi -
      ((3 * e2) / 8 +
        (3 * e4) / 32 +
        (45 * e6) / 1024 +
        (105 * e8) / 4096 +
        (2205 * e10) / 131072 +
        (6237 * e12) / 524288) *
        Math.sin(2 * phi) +
      ((15 * e4) / 256 +
        (45 * e6) / 1024 +
        (525 * e8) / 16384 +
        (1575 * e10) / 65536 +
        (155925 * e12) / 8388608) *
        Math.sin(4 * phi) -
      ((35 * e6) / 3072 +
        (175 * e8) / 12288 +
        (3675 * e10) / 262144 +
        (13475 * e12) / 1048576) *
        Math.sin(6 * phi) +
      ((315 * e8) / 131072 + (2205 * e10) / 524288 + (43659 * e12) / 8388608) *
        Math.sin(8 * phi) -
      ((693 * e10) / 1310720 + (6237 * e12) / 5242880) * Math.sin(10 * phi) +
      ((1001 * e12) / 8388608) * Math.sin(12 * phi))
  );
}

/** The latitude a meridian distance `m` reaches. */
function inverseMeridian(m) {
  const d = m / MAJOR;
  const d2 = d * d;
  const d3 = d2 * d;
  const d4 = d3 * d;
  const e2 = E2;
  const e4 = e2 * e2;
  const e6 = e4 * e2;
  const e8 = e6 * e2;
  const e10 = e8 * e2;
  const e12 = e10 * e2;
  return (
    d +
    (d * e2) / 4 +
    (7 * d * e4) / 64 +
    (15 * d * e6) / 256 +
    (579 * d * e8) / 16384 +
    (1515 * d * e10) / 65536 +
    (16837 * d * e12) / 1048576 +
    ((3 * d * e4) / 16 +
      (45 * d * e6) / 256 -
      (d * (32 * d2 - 561) * e8) / 4096 -
      (d * (232 * d2 - 1677) * e10) / 16384 +
      (d * (399985 - 90560 * d2 + 512 * d4) * e12) / 5242880) *
      Math.cos(2 * d) +
    ((21 * d * e6) / 256 +
      (483 * d * e8) / 4096 -
      (d * (224 * d2 - 1969) * e10) / 16384 -
      (d * (33152 * d2 - 112599) * e12) / 1048576) *
      Math.cos(4 * d) +
    ((151 * d * e8) / 4096 +
      (4681 * d * e10) / 65536 +
      (1479 * d * e12) / 16384 -
      (453 * d3 * e12) / 32768) *
      Math.cos(6 * d) +
    ((1097 * d * e10) / 65536 + (42783 * d * e12) / 1048576) * Math.cos(8 * d) +
    ((8011 * d * e12) / 1048576) * Math.cos(10 * d) +
    ((3 * e2) / 8 +
      (3 * e4) / 16 +
      (213 * e6) / 2048 -
      (3 * d2 * e6) / 64 +
      (255 * e8) / 4096 -
      (33 * d2 * e8) / 512 +
      (20861 * e10) / 524288 -
      (33 * d2 * e10) / 512 +
      (d4 * e10) / 1024 +
      (28273 * e12) / 1048576 -
      (471 * d2 * e12) / 8192 +
      (9 * d4 * e12) / 4096) *
      Math.sin(2 * d) +
    ((21 * e4) / 256 +
      (21 * e6) / 256 +
      (533 * e8) / 8192 -
      (21 * d2 * e8) / 512 +
      (197 * e10) / 4096 -
      (315 * d2 * e10) / 4096 +
      (584039 * e12) / 16777216 -
      (12517 * d2 * e12) / 131072 +
      (7 * d4 * e12) / 2048) *
      Math.sin(4 * d) +
    ((151 * e6) / 6144 +
      (151 * e8) / 4096 +
      (5019 * e10) / 131072 -
      (453 * d2 * e10) / 16384 +
      (26965 * e12) / 786432 -
      (8607 * d2 * e12) / 131072) *
      Math.sin(6 * d) +
    ((1097 * e8) / 131072 +
      (1097 * e10) / 65536 +
      (225797 * e12) / 10485760 -
      (1097 * d2 * e12) / 65536) *
      Math.sin(8 * d) +
    ((8011 * e10) / 2621440 + (8011 * e12) / 1048576) * Math.sin(10 * d) +
    ((293393 * e12) / 251658240) * Math.sin(12 * d)
  );
}

/** Isometric latitude. */
function sigma(latitude) {
  const eSinL = E * Math.sin(latitude);
  return (
    Math.log(Math.tan(0.5 * (HALF_PI + latitude))) -
    (E / 2) * Math.log((1 + eSinL) / (1 - eSinL))
  );
}

/** Radius of the parallel at `latitude`. */
function parallelRadius(latitude) {
  const sinPhi = Math.sin(latitude);
  return (MAJOR * Math.cos(latitude)) / Math.sqrt(1 - E2 * sinPhi * sinPhi);
}

/**
 * The rhumb line from `start` to `end` (`{lon, lat}` radians): its heading
 * (radians from north), its length, and the point a distance along it.
 */
export function rhumbLine(start, end) {
  const heading = Math.atan2(
    negativePiToPi(end.lon - start.lon),
    sigma(end.lat) - sigma(start.lat),
  );
  // Near due east or west the series diverge: such a line follows its
  // parallel. Its length and its points decide that as the renderer does.
  const offEast = Math.abs(Math.abs(heading) - HALF_PI);
  const measuredAlongParallel =
    offEast <= Math.max(EPSILON8, EPSILON8 * HALF_PI);
  const alongParallel = !(offEast > EPSILON8);
  const distance = Math.abs(
    measuredAlongParallel
      ? parallelRadius(start.lat) * negativePiToPi(end.lon - start.lon)
      : (meridian(end.lat) - meridian(start.lat)) / Math.cos(heading),
  );
  return {
    heading,
    distance,
    /** The point `metres` along the line from its start. */
    at(metres) {
      if (metres === 0) return { lon: start.lon, lat: start.lat };
      if (alongParallel) {
        const delta = metres / parallelRadius(start.lat);
        return {
          lon: negativePiToPi(start.lon + (heading > 0 ? delta : -delta)),
          lat: start.lat,
        };
      }
      const lat = inverseMeridian(
        meridian(start.lat) + metres * Math.cos(heading),
      );
      const lon =
        Math.abs(heading) < EPSILON10
          ? negativePiToPi(start.lon)
          : negativePiToPi(
              start.lon + Math.tan(heading) * (sigma(lat) - sigma(start.lat)),
            );
      return { lon, lat };
    },
  };
}

/**
 * The points along a path's rhumb lines no more than `granularity` metres
 * apart, as a renderer drawing the path along rhumb lines places them: each
 * leg of `distance` split into `ceil(distance / granularity)` equal parts.
 * Takes and gives `{lon, lat}` in radians; the path's own points are kept.
 */
export function densifyRhumb(points, granularity = 9999) {
  if (points.length < 2) return points.slice();
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const line = rhumbLine(points[i - 1], points[i]);
    if (line.distance >= granularity) {
      const parts = Math.ceil(line.distance / granularity);
      const step = line.distance / parts;
      for (let k = 1; k < parts; k++) out.push(line.at(step * k));
    }
    out.push(points[i]);
  }
  return out;
}
