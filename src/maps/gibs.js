/**
 * @module maps/gibs
 * @description NASA GIBS tile URLs for the EPSG:3857 "best" WMTS REST
 * endpoint, shared by every layer that draws GIBS imagery.
 *
 * EPSG:3857, not EPSG:4326: GIBS' geographic matrix sets are not power-of-two
 * pyramids (the 1 km set goes 2x1, 3x2, 5x3, 10x5), while the
 * GoogleMapsCompatible sets are standard 256 px power-of-two pyramids that map
 * straight onto a Web Mercator tiling scheme. The time dimension is a path
 * segment, and `y` precedes `x` in the path.
 *
 * Pure: no imports, so portable sources can build probe URLs with it.
 */

const SINGLE_HOST = 'https://gibs.earthdata.nasa.gov';
/** GIBS also serves `gibs-a`, `gibs-b` and `gibs-c`, for parallel tile loads. */
const SHARDED_HOST = 'https://gibs-{s}.earthdata.nasa.gov';

/**
 * A GIBS tile URL template with `{z}`, `{y}` and `{x}` (and `{s}` when sharded).
 * @param {{layer:string, date:string, maxLevel:number, format?:string, sharded?:boolean}} options
 *   GIBS layer id, `YYYY-MM-DD` time, the layer's GoogleMapsCompatible level,
 *   tile format, and whether to spread requests over the `gibs-{s}` hosts.
 * @returns {string}
 */
export function gibsTileTemplate({
  layer,
  date,
  maxLevel,
  format = 'png',
  sharded = false,
}) {
  if (!layer || !date || !Number.isInteger(maxLevel))
    throw new TypeError('GIBS tiles need a layer, a date and a level');
  const host = sharded ? SHARDED_HOST : SINGLE_HOST;
  return `${host}/wmts/epsg3857/best/${layer}/default/${date}/GoogleMapsCompatible_Level${maxLevel}/{z}/{y}/{x}.${format}`;
}

/**
 * One concrete GIBS tile URL, on the single host.
 * @param {{layer:string, date:string, maxLevel:number, format?:string}} options
 * @param {{z:number, y:number, x:number}} tile Matrix level, row and column.
 * @returns {string}
 */
export function gibsTileUrl(options, { z, y, x }) {
  return gibsTileTemplate({ ...options, sharded: false })
    .replace('{z}', String(z))
    .replace('{y}', String(y))
    .replace('{x}', String(x));
}
