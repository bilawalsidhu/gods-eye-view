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

/** Build a linked attribution from plain text and an HTTPS URL only. */
export function alprCreditMarkup(attribution) {
  if (!attribution?.text || !attribution?.href) return null;
  const href = new URL(attribution.href);
  if (href.protocol !== 'https:' || href.username || href.password) {
    throw new TypeError('Camera attribution requires a public HTTPS link');
  }
  const escape = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (char) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[char],
    );
  return `<span class="gev-alpr-credit">ALPR: <a href="${escape(href.href)}" target="_blank" rel="noopener">${escape(attribution.text)}</a></span>`;
}
