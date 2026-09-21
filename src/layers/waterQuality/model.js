import * as Cesium from 'cesium';
import {
  COLOR_BY_FAMILY,
  DEFAULT_COLOR,
  EARTH_MEAN_RADIUS_M,
} from './policy.js';

export function createModel({ state: layerState, services, parts, source }) {
  /**
   * Allocation-free spherical distance used only as a conservative rejection
   * pass before the exact ellipsoidal geodesic calculation.
   */

  function approximateSurfaceDistanceM(
    latitudeARad,
    longitudeARad,
    latitudeBDeg,
    longitudeBDeg,
  ) {
    const latitudeBRad = Cesium.Math.toRadians(latitudeBDeg);
    const longitudeBRad = Cesium.Math.toRadians(longitudeBDeg);
    const latitudeDelta = latitudeBRad - latitudeARad;
    const longitudeDelta = Math.atan2(
      Math.sin(longitudeBRad - longitudeARad),
      Math.cos(longitudeBRad - longitudeARad),
    );
    const sinLatitude = Math.sin(latitudeDelta / 2);
    const sinLongitude = Math.sin(longitudeDelta / 2);
    const haversine =
      sinLatitude * sinLatitude +
      Math.cos(latitudeARad) *
        Math.cos(latitudeBRad) *
        sinLongitude *
        sinLongitude;
    return (
      2 * EARTH_MEAN_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(haversine)))
    );
  }

  /** @param {object} record Site record. @returns {Cesium.Color} Family colour. */

  function colorFor(record) {
    return Cesium.Color.fromCssColorString(
      COLOR_BY_FAMILY[record?.family] || DEFAULT_COLOR,
    );
  }

  /**
   * Whether a site belongs to the REQUESTED viewport.
   *
   * The proxy snaps the request bbox outward onto a shared cache grid, so a
   * response is a SUPERSET of what was asked for. A monitoring site is a point —
   * its coordinate IS its whole geometry — so unlike a mapped installation
   * footprint there is nothing an exact containment test can wrongly discard.
   * @param {{latitude:number, longitude:number}} record Site record.
   * @param {{south:number, west:number, north:number, east:number}} box Requested viewport.
   * @returns {boolean} Whether the site is inside the requested viewport.
   */

  function siteWithinViewport(record, box) {
    if (!record || !box) return false;
    return (
      record.latitude >= box.south &&
      record.latitude <= box.north &&
      record.longitude >= box.west &&
      record.longitude <= box.east
    );
  }

  /**
   * Attach the active family to each site so a record carries the question it
   * was found by. Without it a dot rendered under one family would be coloured
   * by whatever family is selected when a later repaint happens.
   * @param {Array<object>} sites Normalized proxy sites.
   * @param {string} family Active analyte family.
   * @returns {Array<object>} Records ready for rendering.
   */

  function toRecords(sites, family) {
    return sites.map((site) => ({ ...site, family }));
  }

  /** @param {object} record Site record. @returns {string} Human-readable attribution. */

  function waterQualitySourceLabel(record) {
    const parts = [record?.organization, record?.provider]
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    return parts.length
      ? `${parts.join(' · ')} via Water Quality Portal`
      : 'Water Quality Portal';
  }

  /**
   * The most recent sample date across a site's loaded measurements.
   * @param {Array<object>} measurements Loaded measurements.
   * @returns {?string} ISO date, or null when nothing is loaded.
   */

  function latestSampleDate(measurements) {
    if (!Array.isArray(measurements) || !measurements.length) return null;
    return (
      measurements
        .map((measurement) => measurement?.sampledAt)
        .filter(Boolean)
        .sort()
        .at(-1) || null
    );
  }

  return {
    approximateSurfaceDistanceM,
    colorFor,
    siteWithinViewport,
    toRecords,
    waterQualitySourceLabel,
    latestSampleDate,
  };
}
