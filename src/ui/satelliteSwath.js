// The swath a satellite's card lists items inside: the ground it sees right
// now. An Earth-observation satellite whose imaging sensor is in the bundled
// pack uses that sensor's widest standard swath; any other uses the ground it
// sees above 45° elevation, the cone straight down that stays well clear of
// the horizon.

import { EARTH_RADIUS_KM } from '../geoDistance.js';
import { tilePosition } from '../stories/thumbs.js';

const RAD = Math.PI / 180;
/** The lowest elevation, seen from the ground, counted as "under" it. */
const MIN_ELEVATION_DEG = 45;

/**
 * Width of the ground under a satellite seen above `minElevationDeg`, in km.
 * @param {number} altitudeM
 * @param {number} [minElevationDeg]
 * @returns {?number}
 */
export function visibleSwathKm(altitudeM, minElevationDeg = MIN_ELEVATION_DEG) {
  const h = altitudeM / 1000;
  if (!Number.isFinite(h) || h <= 0) return null;
  const e = (minElevationDeg * Math.PI) / 180;
  const centralAngle =
    Math.acos((EARTH_RADIUS_KM * Math.cos(e)) / (EARTH_RADIUS_KM + h)) - e;
  return Math.max(0, 2 * centralAngle * EARTH_RADIUS_KM);
}

/**
 * A satellite's swath width, and what it comes from.
 * @param {{sensor?: ?{label?: ?string, swathKm?: ?number}}|null} described
 * @param {number} altitudeM
 * @returns {?{km: number, sensor: ?string}}
 */
export function satelliteSwath(described, altitudeM) {
  const sensorKm = described?.sensor?.swathKm;
  if (Number.isFinite(sensorKm) && sensorKm > 0)
    return { km: sensorKm, sensor: described.sensor.label || null };
  const km = visibleSwathKm(altitudeM);
  return km ? { km, sensor: null } : null;
}

/** Ground metres per tile pixel at zoom 0 on the equator (Web Mercator). */
const METRES_PER_PIXEL_Z0 = 156_543.03;
const TILE_PX = 256;
/** Target share of the ground view's width for framing the swath. */
export const SWATH_SHARE = 0.45;
/** The ground view's width before it has been laid out. */
export const GROUND_VIEW_WIDTH_PX = 340;
/** The tile zooms the ground view draws from. */
export const GROUND_ZOOM = Object.freeze({ min: 2, max: 13 });

/**
 * Approximate projected width for framing the map, in pixels.
 * @param {number} lat
 * @param {number} swathKm
 * @param {number} zoom
 * @param {number} [scale]
 * @returns {number}
 */
export function swathPixels(lat, swathKm, zoom, scale = 1) {
  if (!Number.isFinite(lat) || !Number.isFinite(swathKm) || swathKm <= 0)
    return 0;
  const cosLat = Math.cos((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return (
    ((swathKm * 1000 * 2 ** zoom) / (METRES_PER_PIXEL_Z0 * cosLat)) * scale
  );
}

/**
 * How the ground view frames a swath: the tile zoom it reads, the scale it
 * draws those tiles at, and the approximate swath width in screen pixels.
 * The zoom is the closest whose 3 by 3 tile block,
 * once scaled, still covers the whole width; a swath too wide for that
 * even at the widest zoom takes more of the view.
 * @param {number} lat
 * @param {number} swathKm
 * @param {number} [widthPx] The view's width.
 * @param {number} [share]
 * @returns {?{zoom: number, scale: number, swathPx: number}}
 */
export function groundFrame(
  lat,
  swathKm,
  widthPx = GROUND_VIEW_WIDTH_PX,
  share = SWATH_SHARE,
) {
  if (!Number.isFinite(lat) || !Number.isFinite(swathKm) || swathKm <= 0)
    return null;
  const width =
    Number.isFinite(widthPx) && widthPx > 0 ? widthPx : GROUND_VIEW_WIDTH_PX;
  const swathPxAt = (zoom) => swathPixels(lat, swathKm, zoom);
  const target = share * width;
  let zoom = Math.ceil(Math.log2(target / swathPxAt(0)));
  zoom = Math.max(GROUND_ZOOM.min, Math.min(GROUND_ZOOM.max, zoom));
  let scale = target / swathPxAt(zoom);
  // The block reaches at least one scaled tile past the spot on every side.
  const reach = width / 2 + 1;
  while (TILE_PX * scale < reach && zoom > GROUND_ZOOM.min) {
    zoom -= 1;
    scale *= 2;
  }
  scale = Math.max(scale, reach / TILE_PX);
  return { zoom, scale, swathPx: swathPxAt(zoom) * scale };
}

/** Project the edge of a geographic disc into the map's own unscaled tile pixels. */
export function swathPaths(lat, lon, swathKm, zoom) {
  const radius = swathKm / (2 * EARTH_RADIUS_KM);
  const latitude = lat * RAD;
  const sinLat = Math.sin(latitude);
  const cosLat = Math.cos(latitude);
  const sinRadius = Math.sin(radius);
  const cosRadius = Math.cos(radius);
  const origin = tilePosition(lon, lat, zoom);
  const world = 2 ** zoom;
  const edges = [];
  let previousX = 0;
  // Start on the meridian away from the nearest pole, so a polar ring can
  // close along the map limit and repeat either side of that meridian.
  for (let i = 0; i <= 96; i++) {
    const bearing = (lat >= 0 ? Math.PI : 0) + (2 * Math.PI * i) / 96;
    const y = Math.asin(
      Math.max(
        -1,
        Math.min(
          1,
          sinLat * cosRadius + cosLat * sinRadius * Math.cos(bearing),
        ),
      ),
    );
    const delta = Math.atan2(
      Math.sin(bearing) * sinRadius * cosLat,
      cosRadius - sinLat * Math.sin(y),
    );
    const projected = tilePosition(lon + delta / RAD, y / RAD, zoom);
    const x = projected.x - origin.x;
    previousX = x + world * Math.round((previousX - x) / world);
    edges.push([previousX, projected.y - origin.y]);
  }
  const pixels = (n) => Number((n * TILE_PX).toFixed(3));
  const path = (offset = 0) =>
    edges
      .map(([x, y], i) => `${i ? 'L' : 'M'}${pixels(x + offset)} ${pixels(y)}`)
      .join('');
  const wrap = world * Math.round((edges.at(-1)[0] - edges[0][0]) / world);
  if (!wrap) {
    const outline = path() + 'Z';
    return { outline, fill: outline };
  }
  const limit = pixels((lat > 0 ? 0 : world) - origin.y);
  const fill = (offset) =>
    path(offset) +
    `L${pixels(edges.at(-1)[0] + offset)} ${limit}L${pixels(edges[0][0] + offset)} ${limit}Z`;
  return { outline: path() + path(-wrap), fill: fill(0) + fill(-wrap) };
}
