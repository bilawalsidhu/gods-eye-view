/**
 * Stations that would overlap on screen, as groups. Pure: no renderer.
 *
 * Stations are put in ground cells about `CLUSTER_PX` wide at the view
 * centre: rows of `cell` degrees of latitude, and in each row columns of
 * `cell` degrees scaled by the cosine of the row centre's latitude, so a
 * cell covers about the same ground everywhere. Then, largest first, each
 * cell takes in the neighbouring cells whose centres are closer than three
 * quarters of a cell. Longitudes wrap, so a group can sit on the dateline.
 */
import { toLonLatH } from '../../geo/ellipsoid.js';

/** Stations closer on screen than about this many pixels draw as one. */
export const CLUSTER_PX = 46;
/** The cell, in degrees, when the view centre cannot be measured. */
const FALLBACK_CELL_DEG = 6;
/** Neighbouring cells join when their centres are closer than this. */
const JOIN_CELLS = 0.75;

const RADIANS = Math.PI / 180;
/** A longitude in [-180, 180). */
const wrap = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;
/** `lon` moved by whole turns to within half a turn of `ref`. */
const near = (lon, ref) => ref + wrap(lon - ref);
const cosAt = (lat) => Math.max(0.05, Math.cos(lat * RADIANS));

/**
 * The ground span, in degrees, of `px` pixels at the view centre: two
 * ellipsoid picks, at the centre and `px` to its right.
 * @param {{width: number, height: number, pickEllipsoid: (x: number, y: number) => object|null}} camera
 *   The view's size in CSS pixels and its ellipsoid pick (the query port's).
 * @param {number} [px]
 * @returns {number} At least 1e-4; 6 when either pick misses the globe.
 */
export function cellDegAt(camera, px = CLUSTER_PX) {
  const x = camera?.width / 2;
  const y = camera?.height / 2;
  if (
    typeof camera?.pickEllipsoid !== 'function' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  )
    return FALLBACK_CELL_DEG;
  const here = camera.pickEllipsoid(x, y);
  const side = camera.pickEllipsoid(x + px, y);
  const a = here ? toLonLatH(here) : null;
  const b = side ? toLonLatH(side) : null;
  if (!a || !b) return FALLBACK_CELL_DEG;
  return Math.max(
    1e-4,
    Math.hypot(wrap(b.lon - a.lon) * cosAt(a.lat), b.lat - a.lat),
  );
}

/**
 * Group stations by ground cells `cellDeg` wide.
 * @template {{id: string, lat: number, lon: number, value: number|null}} S
 * @param {S[]} stations `value` is the station's number on the view's
 *   scale, or null when it is not rated on it.
 * @param {number} cellDeg
 * @param {{selectedId?: string|null}} [options] The selected station is
 *   never grouped: it comes back as a group of its own, last.
 * @returns {Array<{members: S[], lat: number, lon: number, mean: number|null}>}
 *   Largest first. `mean` is that of the rated members (finite `value`),
 *   null when none is rated.
 */
export function groupStations(stations, cellDeg, { selectedId = null } = {}) {
  const list = Array.isArray(stations) ? stations : [];
  // No usable cell: every station on its own.
  if (!(cellDeg > 0) || !Number.isFinite(cellDeg))
    return list.map((station) => result(add(empty(), station, station.lon)));
  const cell = cellDeg;
  const keyAt = (lat, lon) => {
    const row = Math.floor(lat / cell);
    const cos = cosAt((row + 0.5) * cell);
    return `${row}:${Math.floor((wrap(lon) * cos) / cell)}`;
  };
  const cells = new Map();
  let selected = null;
  for (const station of list) {
    if (selectedId !== null && station.id === selectedId) {
      selected = station;
      continue;
    }
    const key = keyAt(station.lat, station.lon);
    let group = cells.get(key);
    if (!group) {
      // Longitudes are summed next to the cell's first station, so a cell
      // on the dateline does not average to the prime meridian.
      group = { ...empty(), ref: station.lon };
      cells.set(key, group);
    }
    add(group, station, near(station.lon, group.ref));
  }
  const out = [];
  const ordered = [...cells.values()].sort(
    (a, b) => b.members.length - a.members.length,
  );
  for (const group of ordered) {
    if (group.gone) continue;
    const count = group.members.length;
    const lat = group.lat / count;
    const lon = group.lon / count;
    const cos = cosAt(lat);
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        const other = cells.get(
          keyAt(lat + dr * cell, lon + (dc * cell) / cos),
        );
        if (!other || other === group || other.gone) continue;
        const m = other.members.length;
        // The other cell's centre, moved next to this group's.
        const otherLon = near(other.lon / m, lon);
        const apart = Math.hypot((otherLon - lon) * cos, other.lat / m - lat);
        if (apart > cell * JOIN_CELLS) continue;
        other.gone = true;
        group.members.push(...other.members);
        group.lat += other.lat;
        group.lon += otherLon * m;
        group.sum += other.sum;
        group.rated += other.rated;
      }
    out.push(result(group));
  }
  if (selected) out.push(result(add(empty(), selected, selected.lon)));
  return out;
}

const empty = () => ({ members: [], lat: 0, lon: 0, sum: 0, rated: 0 });

function add(group, station, lon) {
  group.members.push(station);
  group.lat += station.lat;
  group.lon += lon;
  if (Number.isFinite(station.value)) {
    group.sum += station.value;
    group.rated += 1;
  }
  return group;
}

function result(group) {
  const count = group.members.length;
  return {
    members: group.members,
    lat: group.lat / count,
    lon: wrap(group.lon / count),
    mean: group.rated ? group.sum / group.rated : null,
  };
}

/**
 * The members' rectangle padded by 20 % on each side (at least 0.15°), for
 * a camera flight to where they come apart. A group across the dateline
 * gets a rectangle whose west is east of its east, as the camera port reads
 * one.
 * @param {Array<{lat: number, lon: number}>} members
 * @returns {{west: number, south: number, east: number, north: number}}
 */
export function groupRect(members) {
  const ref = members[0]?.lon ?? 0;
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const member of members) {
    const lon = near(member.lon, ref);
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, member.lat);
    north = Math.max(north, member.lat);
  }
  const padLon = Math.max(0.15, (east - west) * 0.2);
  const padLat = Math.max(0.15, (north - south) * 0.2);
  if (east - west + 2 * padLon >= 360) {
    west = -180;
    east = 180;
  } else {
    west = edge(west - padLon);
    east = edge(east + padLon);
  }
  return {
    west,
    south: Math.max(-89, south - padLat),
    east,
    north: Math.min(89, north + padLat),
  };
}

/** A rectangle edge in [-180, 180]: 180 itself stays 180. */
const edge = (lon) => (lon > 180 || lon < -180 ? wrap(lon) : lon);
