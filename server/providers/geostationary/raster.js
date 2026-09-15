import {
  GOES_GRID_HALF_EXTENT_RAD,
  geodeticToScanAngles,
} from './projection.js';

/** Normalize a longitude difference into [-180, 180]. */
function normalizeDegrees(value) {
  let result = value;
  while (result > 180) result -= 360;
  while (result <= -180) result += 360;
  return result;
}

/**
 * Reproject an RGBA fixed-grid image into one or more equirectangular parts.
 *
 * When `ownershipLongitudes` holds more than one satellite longitude, each
 * output pixel is kept only for the satellite it is angularly closest to, with
 * a smooth alpha ramp over `featherDeg` at the sector boundary. That turns the
 * hard overlap between two geostationary disks into a feathered seam.
 *
 * @param {{rgba: ArrayLike<number>, srcWidth: number, srcHeight: number,
 *   nav: object, outputHeight?: number, maxOutputWidth?: number,
 *   ownershipLongitudes?: number[], ownerLon0?: number, featherDeg?: number}} input
 */
export function reprojectToEquirectangular({
  rgba,
  srcWidth,
  srcHeight,
  nav,
  outputHeight = 1024,
  maxOutputWidth = 4096,
  ownershipLongitudes = null,
  ownerLon0 = nav.lon0,
  featherDeg = 3,
}) {
  const maxLat = horizonSearch(
    (lat) => geodeticToScanAngles(lat, nav.lon0, nav) !== null,
  );
  const maxLonOffset = horizonSearch(
    (offset) => geodeticToScanAngles(0, nav.lon0 + offset, nav) !== null,
  );
  const minLat = -maxLat;
  const minLon = nav.lon0 - maxLonOffset;
  const maxLon = nav.lon0 + maxLonOffset;
  const longitudeParts =
    minLon >= -180 && maxLon <= 180
      ? [{ west: minLon, east: maxLon }]
      : minLon < -180
        ? [
            { west: minLon + 360, east: 180 },
            { west: -180, east: maxLon },
          ]
        : [
            { west: minLon, east: 180 },
            { west: -180, east: maxLon - 360 },
          ];
  const ownsSectors =
    Array.isArray(ownershipLongitudes) && ownershipLongitudes.length > 1;
  return {
    parts: longitudeParts.map(({ west, east }) => {
      const width = Math.max(
        1,
        Math.min(
          maxOutputWidth,
          Math.round((outputHeight * (east - west)) / (maxLat - minLat)),
        ),
      );
      const output = new Uint8ClampedArray(width * outputHeight * 4);
      for (let row = 0; row < outputHeight; row += 1) {
        for (let col = 0; col < width; col += 1) {
          const lat = maxLat - ((row + 0.5) / outputHeight) * (maxLat - minLat);
          const lon = west + ((col + 0.5) / width) * (east - west);
          let alpha = 1;
          if (ownsSectors) {
            const own = Math.abs(normalizeDegrees(lon - ownerLon0));
            let nearestOther = Infinity;
            for (const other of ownershipLongitudes) {
              if (other === ownerLon0) continue;
              nearestOther = Math.min(
                nearestOther,
                Math.abs(normalizeDegrees(lon - other)),
              );
            }
            // Another satellite is closer: this pixel belongs to it.
            if (own >= nearestOther) continue;
            alpha = Math.min(1, (nearestOther - own) / featherDeg);
          }
          const scan = geodeticToScanAngles(lat, lon, nav);
          if (!scan) continue;
          const srcX =
            ((scan.x + GOES_GRID_HALF_EXTENT_RAD) /
              (2 * GOES_GRID_HALF_EXTENT_RAD)) *
            (srcWidth - 1);
          const srcY =
            ((GOES_GRID_HALF_EXTENT_RAD - scan.y) /
              (2 * GOES_GRID_HALF_EXTENT_RAD)) *
            (srcHeight - 1);
          if (
            srcX < 0 ||
            srcX > srcWidth - 1 ||
            srcY < 0 ||
            srcY > srcHeight - 1
          )
            continue;
          const x0 = Math.floor(srcX);
          const y0 = Math.floor(srcY);
          const x1 = Math.min(x0 + 1, srcWidth - 1);
          const y1 = Math.min(y0 + 1, srcHeight - 1);
          const fx = srcX - x0;
          const fy = srcY - y0;
          const index = (row * width + col) * 4;
          for (let channel = 0; channel < 3; channel += 1) {
            const top =
              rgba[(y0 * srcWidth + x0) * 4 + channel] * (1 - fx) +
              rgba[(y0 * srcWidth + x1) * 4 + channel] * fx;
            const bottom =
              rgba[(y1 * srcWidth + x0) * 4 + channel] * (1 - fx) +
              rgba[(y1 * srcWidth + x1) * 4 + channel] * fx;
            output[index + channel] = top * (1 - fy) + bottom * fy;
          }
          output[index + 3] = Math.round(255 * alpha);
        }
      }
      return {
        rgba: output,
        width,
        height: outputHeight,
        rectangle: { west, south: minLat, east, north: maxLat },
      };
    }),
  };
}

function horizonSearch(isVisible) {
  let low = 0;
  let high = 90;
  for (let i = 0; i < 60; i += 1) {
    const middle = (low + high) / 2;
    if (isVisible(middle)) low = middle;
    else high = middle;
  }
  return low;
}
