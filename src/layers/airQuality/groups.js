/**
 * Stations that would overlap on screen, as groups. Pure: no renderer.
 *
 * Stations are put in ground cells about `CLUSTER_PX` wide at the view
 * centre: rows of `cell` degrees of latitude, and in each row columns of
 * `cell` degrees scaled by the cosine of the row centre's latitude, so a
 * cell covers about the same ground everywhere. Then, largest first, each
 * cell takes in the neighbouring cells whose centres are closer than three
 * quarters of a cell. Longitudes wrap, so a group can sit on the dateline.
 * Group colours use the rated members’ mean, or the neutral colour when every station is unrated.
 */
import { toLonLatH } from '../../geo/ellipsoid.js';

/** Stations closer on screen than about this many pixels draw as one. */
export const CLUSTER_PX = 46;
/** The cell, in degrees, when the view cannot be measured. */
const FALLBACK_CELL_DEG = 6;
/** Neighbouring cells join when their centres are closer than this. */
const JOIN_CELLS = 0.75;
/**
 * Where the cell is measured, as fractions of the view's height: the
 * centre, then lower down for a tilted view whose centre sees sky.
 */
const MEASURE_ROWS = [0.5, 0.75, 0.9];
/** Stations closer than this cannot be told apart by zooming in. */
const INSEPARABLE_M = 100;
/** A click hits a drawn item within its radius and this many pixels. */
const HIT_SLACK_PX = 6;
const METRES_PER_DEGREE = 111_320;

const RADIANS = Math.PI / 180;
/** A longitude in [-180, 180). */
const wrap = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;
/** `lon` moved by whole turns to within half a turn of `ref`. */
const near = (lon, ref) => ref + wrap(lon - ref);
const cosAt = (lat) => Math.max(0.05, Math.cos(lat * RADIANS));

/**
 * The ground span, in degrees, of `px` pixels across the view: two
 * ellipsoid picks, `px` apart, at the centre, or lower on screen when the
 * centre misses the globe.
 * @param {{width: number, height: number, pickEllipsoid: (x: number, y: number) => object|null}} camera
 *   The view's size in CSS pixels and its ellipsoid pick (the query port's).
 * @param {number} [px]
 * @returns {number} At least 1e-4; 6 when no pair of picks hits the globe.
 */
export function cellDegAt(camera, px = CLUSTER_PX) {
  const x = camera?.width / 2;
  const height = camera?.height;
  if (
    typeof camera?.pickEllipsoid !== 'function' ||
    !Number.isFinite(x) ||
    !Number.isFinite(height)
  )
    return FALLBACK_CELL_DEG;
  for (const row of MEASURE_ROWS) {
    const y = height * row;
    const here = camera.pickEllipsoid(x, y);
    const side = here ? camera.pickEllipsoid(x + px, y) : null;
    const a = here ? toLonLatH(here) : null;
    const b = side ? toLonLatH(side) : null;
    if (a && b)
      return Math.max(
        1e-4,
        Math.hypot(wrap(b.lon - a.lon) * cosAt(a.lat), b.lat - a.lat),
      );
  }
  return FALLBACK_CELL_DEG;
}

/**
 * Group stations by ground cells `cellDeg` wide.
 * @template {{id: string, lat: number, lon: number, value: number|null}} S
 * @param {S[]} stations `value` is the station's number on the view's
 *   scale, or null when it is not rated on it.
 * @param {number} cellDeg
 * @param {{selectedId?: string|null}} [options]
 * @returns {Array<{members: S[], lat: number, lon: number, mean: number|null}>}
 *   Groups largest first, with the selected station alone at the end.
 *   The mean uses the rated members, or is null for a group with none.
 */
export function groupStations(stations, cellDeg, { selectedId = null } = {}) {
  const list = Array.isArray(stations) ? stations : [];
  const alone = (station) => result(add(empty(), station, station.lon));
  // No usable cell: every station on its own.
  if (!(cellDeg > 0) || !Number.isFinite(cellDeg)) return list.map(alone);
  const cell = cellDeg;
  const rowOf = (lat) => Math.floor(lat / cell);
  const cosOfRow = (row) => cosAt((row + 0.5) * cell);
  const colOf = (row, lon) => Math.floor((wrap(lon) * cosOfRow(row)) / cell);
  /** Column `col` of `row`, wrapped across the dateline. */
  const keyOf = (row, col) => {
    const first = colOf(row, -180);
    const span = colOf(row, 180 - 1e-9) - first + 1;
    return `${row}:${((((col - first) % span) + span) % span) + first}`;
  };
  const cells = new Map();
  let selected = null;
  for (const station of list) {
    if (selectedId !== null && station.id === selectedId) {
      selected = station;
      continue;
    }
    const row = rowOf(station.lat);
    const col = colOf(row, station.lon);
    const key = `${row}:${col}`;
    let group = cells.get(key);
    if (!group) {
      // Longitudes are summed next to the cell's first station, so a cell
      // on the dateline does not average to the prime meridian.
      group = { ...empty(), row, col, ref: station.lon };
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
    group.gone = true; // Emitted once: no later cell takes it in.
    const count = group.members.length;
    const lat = group.lat / count;
    const lon = group.lon / count;
    const cos = cosAt(lat);
    // The cells around this one: the next columns in its own row, and in
    // the rows above and below, the columns around its centre's longitude.
    const around = new Set();
    for (let dr = -1; dr <= 1; dr++) {
      const row = group.row + dr;
      const col = dr === 0 ? group.col : colOf(row, lon);
      for (let dc = -1; dc <= 1; dc++) around.add(keyOf(row, col + dc));
    }
    for (const key of around) {
      const other = cells.get(key);
      if (!other || other === group || other.gone) continue;
      const m = other.members.length;
      // The other cell's centre, moved next to this group's.
      const otherLon = near(other.lon / m, lon);
      const apart = Math.hypot((otherLon - lon) * cos, other.lat / m - lat);
      if (apart > cell * JOIN_CELLS) continue;
      other.gone = true;
      for (const member of other.members) group.members.push(member);
      group.lat += other.lat;
      group.lon += otherLon * m;
      group.sum += other.sum;
      group.rated += other.rated;
    }
    out.push(result(group));
  }
  if (selected) out.push(alone(selected));
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

/** Members' bounds, longitudes next to the first member's. */
function bounds(members) {
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
  return { west, east, south, north };
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
  let { west, east, south, north } = bounds(members);
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

/** A rectangle's width; a west east of its east crosses the dateline. */
const widthOf = (rect) => {
  const width = rect.east - rect.west;
  return width > 0 ? width : width + 360;
};

/**
 * What a click on a group does. It never zooms out: it flies to the
 * members' rectangle (`groupRect`) only when that is smaller than the view
 * in both directions (or the view is unknown). When it is not, or the
 * members lie within about 100 m of each other and could never come apart,
 * it selects the member with the highest value instead.
 * @template {{lat: number, lon: number, value: number|null}} S
 * @param {S[]} members
 * @param {{west: number, south: number, east: number, north: number}|null} view
 * @returns {{rect: object}|{station: S}}
 */
export function groupTarget(members, view) {
  const box = bounds(members);
  const lat = (box.south + box.north) / 2;
  const spanM = Math.hypot(
    (box.east - box.west) * METRES_PER_DEGREE * Math.cos(lat * RADIANS),
    (box.north - box.south) * METRES_PER_DEGREE,
  );
  const rect = groupRect(members);
  const fits =
    !view ||
    (widthOf(rect) < widthOf(view) &&
      rect.north - rect.south < view.north - view.south);
  if (spanM > INSEPARABLE_M && fits) return { rect };
  const rated = members.filter((member) => Number.isFinite(member.value));
  const station = rated.reduce(
    (best, member) => (member.value > best.value ? member : best),
    rated[0] ?? members[0],
  );
  return { station };
}

/**
 * The drawn item a click is on: the nearest whose drawn radius plus 6 px
 * reaches it.
 * @template {{lon: number, lat: number, px: number}} T
 * @param {T[]} items Drawn items, `px` their size.
 * @param {{lon: number, lat: number}} at Where the click lands on the ground.
 * @param {{lon: number, lat: number}|null} side The ground 10 px to its right.
 * @returns {T|null}
 */
export function nearestItem(items, at, side) {
  if (!at || !side) return null;
  const cos = cosAt(at.lat);
  // Degrees in 10 px at the click.
  const reach = Math.max(
    1e-9,
    Math.hypot(wrap(side.lon - at.lon) * cos, side.lat - at.lat),
  );
  let best = null;
  let bestScore = 1;
  for (const item of items) {
    const apart = Math.hypot(wrap(item.lon - at.lon) * cos, item.lat - at.lat);
    const score = apart / ((reach * (item.px / 2 + HIT_SLACK_PX)) / 10);
    if (score < bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}
