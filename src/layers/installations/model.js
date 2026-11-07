import { installationResponseSaturated } from './source.js';
import * as Cesium from 'cesium';
import {
  EARTH_MEAN_RADIUS_M,
  COLOR_BY_CLASS,
  GOOGLE_MILITARY_PLACE_TYPES,
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

  function colorFor(record) {
    return Cesium.Color.fromCssColorString(
      COLOR_BY_CLASS[record.class] || '#9ca6b0',
    );
  }

  /**
   * Classify a Places text-search result without turning a name match into a
   * mapped military-land claim. Google currently has no documented military
   * Places type, so ordinary results remain visually distinct candidates; the
   * explicit branch is retained for any source response that does carry one.
   * @param {object} place Google Places result.
   * @returns {string|null} Installation class, or null when not authoritative.
   */

  function classifyGoogleMilitaryPlace(place) {
    const types = new Set(
      [place?.primaryType, ...(Array.isArray(place?.types) ? place.types : [])]
        .map((value) =>
          String(value || '')
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean),
    );
    return [...types].some((type) => GOOGLE_MILITARY_PLACE_TYPES.has(type))
      ? 'military_land'
      : 'places_candidate';
  }

  /** @param {object} record @returns {string} Human-readable source attribution. */

  function installationSourceLabel(record) {
    const names = [
      ...new Set(
        (Array.isArray(record?.sources) ? record.sources : [])
          .map((source) => String(source?.name || '').trim())
          .filter(Boolean),
      ),
    ];
    return names.join(' + ') || 'Unknown mapped source';
  }

  /**
   * Whether a mapped record belongs to the REQUESTED viewport.
   *
   * The proxy snaps the request bbox outward onto a shared cache grid, so a
   * response is a SUPERSET of what was asked for, and rendering that superset
   * would put off-screen sites into the map and into the "CURRENT VIEWPORT ONLY"
   * context claim. What may be tested depends on how much of a feature's geometry
   * we actually hold:
   *
   *  - A NODE is a point: its centre IS its whole geometry, so an exact
   *    containment test is correct and loses nothing.
   *  - A record WITH a footprint is tested by bounding-box overlap. Overpass bbox
   *    queries return features that merely INTERSECT the box, so centre-testing
   *    these would drop large bases whose centre sits just outside.
   *  - A way or relation WITHOUT a footprint is KEPT. Relations carry geometry on
   *    their members and ways beyond MAX_FOOTPRINT_POINTS are normalized without
   *    one, so their true extent is unknown here — and Overpass already proved
   *    they intersect the queried bbox. Centre-testing them would erase exactly
   *    the biggest installations. The honest cost is slight over-inclusion,
   *    bounded by one snap cell (~5.5 km) around the viewport.
   *
   * @param {{latitude:number, longitude:number, footprint:?Array, osmType:?string}} record
   * @param {{south:number, west:number, north:number, east:number}} box Requested viewport.
   * @returns {boolean}
   */

  function installationWithinViewport(record, box) {
    if (!record || !box) return false;
    const { latitude, longitude, footprint } = record;
    const centreInside =
      latitude >= box.south &&
      latitude <= box.north &&
      longitude >= box.west &&
      longitude <= box.east;
    if (centreInside) return true;
    const footprints =
      record.footprints?.map((rings) => rings[0]) ||
      (footprint?.length ? [footprint] : []);
    if (footprints.length)
      return footprints.some((footprint) => {
        let minLat = Infinity;
        let maxLat = -Infinity;
        let minLon = Infinity;
        let maxLon = -Infinity;
        for (const [lon, lat] of footprint) {
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
        }
        return (
          maxLat >= box.south &&
          minLat <= box.north &&
          maxLon >= box.west &&
          minLon <= box.east
        );
      });
    // Unknown extent: inclusive. Only a point feature may be excluded on centre.
    return record.osmType !== 'node';
  }

  return {
    approximateSurfaceDistanceM,
    colorFor,
    classifyGoogleMilitaryPlace,
    installationSourceLabel,
    installationWithinViewport,
    installationResponseSaturated,
  };
}
