import * as Cesium from 'cesium';
import { EARTH_MEAN_RADIUS_M } from './policy.js';
export * from './records.js';

/**
 * Great-circle destination point — used only to draw the short
 * facing-direction line when a node carries `camera:direction`/`direction`.
 * @param {number} latDeg @param {number} lonDeg
 * @param {number} bearingDeg Compass bearing, degrees clockwise from north.
 * @param {number} distanceM
 * @returns {{latitude:number, longitude:number}}
 */
export function destinationPointDeg(latDeg, lonDeg, bearingDeg, distanceM) {
  const angularDistance = distanceM / EARTH_MEAN_RADIUS_M;
  const bearing = Cesium.Math.toRadians(bearingDeg);
  const lat1 = Cesium.Math.toRadians(latDeg);
  const lon1 = Cesium.Math.toRadians(lonDeg);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2),
    );
  return {
    latitude: Cesium.Math.toDegrees(lat2),
    longitude: Cesium.Math.toDegrees(lon2),
  };
}

/**
 * The on-map credit for the renderer's credits port, from plain text and an
 * HTTPS URL only; the port escapes it as it shows it.
 * @returns {{text: string, href: string, inline: true}|null}
 */
export function alprCredit(attribution) {
  if (!attribution?.text || !attribution?.href) return null;
  const href = new URL(attribution.href);
  if (href.protocol !== 'https:' || href.username || href.password) {
    throw new TypeError('Camera attribution requires a public HTTPS link');
  }
  return { text: `ALPR: ${attribution.text}`, href: href.href, inline: true };
}
