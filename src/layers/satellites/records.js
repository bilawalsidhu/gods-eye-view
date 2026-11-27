import { satelliteClassText } from '../../data/satelliteClass.js';
import { toLonLatH } from '../../geo/ellipsoid.js';
import { ISS_NORAD } from './policy.js';
import {
  cosparIdFromTleLine1,
  satelliteOperator,
  satelliteOwner,
} from './classes.js';

/**
 * Map one CelesTrak catalog satellite to a JSON-safe analyst record
 * (analyst query engine seam). Pure — no Cesium types. Missing/unknown
 * fields are null, never NaN/undefined. `id` is the display name (same
 * convention as vessels); `noradId` is the track_entity key.
 * @param {Object|null|undefined} raw - {noradId, name, group, lat, lon, altitudeM, speedMps}.
 * @returns {{id: string, noradId: string|null, name: string|null,
 *   lat: number|null, lon: number|null, altitudeM: number|null,
 *   speedMps: number|null, satelliteClass: string|null, group: string|null}}
 */
export function mapAnalystRecord(raw) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const text = (v) => {
    const t = String(v ?? '').trim();
    return t || null;
  };
  const noradNum =
    raw?.noradId == null || raw.noradId === '' ? NaN : Number(raw.noradId);
  const noradId = Number.isFinite(noradNum)
    ? String(Math.trunc(noradNum))
    : text(raw?.noradId);
  const name = text(raw?.name);
  const group = text(raw?.group);
  const isIss = noradNum === ISS_NORAD;
  return {
    id: name || (noradId ? `SAT-${noradId}` : 'SAT-00000'),
    noradId,
    name,
    lat: num(raw?.lat),
    lon: num(raw?.lon),
    altitudeM: num(raw?.altitudeM),
    speedMps: num(raw?.speedMps),
    // Empty records stay class-less; the class table's fallback is VISUAL and
    // must not leak onto a row that has no satellite identity.
    satelliteClass:
      noradId || group
        ? satelliteClassText(text(raw?.satelliteClass), group, {
            isIss,
            localize: false,
          })
        : null,
    group,
  };
}

/** Create on-demand analyst snapshots owned by one layer instance. */
export function createRecords({ state, parts }) {
  // A class the user hid stays out of answers too; the tracked one stays.
  function isVisible(noradId) {
    return (
      noradId === state._trackedNorad ||
      parts.controls?._classVisible?.(noradId) !== false
    );
  }

  function catalogRecord(noradId, sat, position) {
    return mapAnalystRecord({
      noradId,
      name: sat?.name,
      group: sat?.group,
      satelliteClass: sat?.satelliteClass,
      ...position,
    });
  }

  function analystGeo(noradId, sat, now) {
    const pos = sat?.satrec
      ? parts.orbits.propagatePosition(sat.satrec, now)
      : null;
    if (
      pos &&
      Number.isFinite(pos.latitude) &&
      Number.isFinite(pos.longitude)
    ) {
      return {
        lat: pos.latitude,
        lon: pos.longitude,
        altitudeM: pos.altitude,
        speedMps: Number.isFinite(pos.speedMps) ? pos.speedMps : null,
      };
    }
    const position = parts.rendering._pointPosition(noradId);
    if (!position) return null;
    const carto = toLonLatH(position);
    if (!carto) return null;
    return {
      lat: carto.lat,
      lon: carto.lon,
      altitudeM: carto.height,
      speedMps: null,
    };
  }

  function getAnalystRecords(maxCount = 2000) {
    if (!state._enabled || !state._catalog.size) return [];
    const limit = Number.isFinite(maxCount)
      ? Math.max(1, Math.floor(maxCount))
      : 2000;
    const now = new Date(state.now());
    const result = [];
    const emit = (noradId, sat) => {
      if (result.length >= limit) return false;
      if (!isVisible(noradId)) return true;
      const pos = analystGeo(noradId, sat, now);
      if (!pos) return true;
      result.push(catalogRecord(noradId, sat, pos));
      return result.length < limit;
    };
    for (const [noradId, sat] of state._catalog) {
      if (sat?.group === 'dense') continue;
      if (!emit(noradId, sat)) break;
    }
    if (result.length < limit) {
      for (const [noradId, sat] of state._catalog) {
        if (sat?.group !== 'dense') continue;
        if (!emit(noradId, sat)) break;
      }
    }
    return result;
  }

  /** The widest standard swath of a sensor-pack entry, in km, or null. */
  function widestSwathKm(sensor) {
    const widths = (sensor?.modes || [])
      .map((mode) => mode.swathKm)
      .filter((km) => Number.isFinite(km) && km > 0);
    return widths.length ? Math.max(...widths) : null;
  }

  /**
   * What a satellite is and where it came from, for its Context card: its
   * orbit (class and inclination, from its elements) and its launch and type
   * (from the SATCAT and UCS records the layer read). Fields not known are
   * null. Null for a satellite the layer does not hold.
   * @param {string|number} noradId
   * @returns {?{orbitClass: ?string, inclinationDeg: ?number,
   *   launchDate: ?string, owner: ?string, ownerCountryCode: ?string,
   *   operator: ?string, objectType: ?string, cosparId: ?string,
   *   opsStatus: ?string, sensor: ?{label: ?string, swathKm: ?number}}}
   */
  function describeSatellite(noradId) {
    const sat = state._catalog.get(Number(noradId));
    if (!sat) return null;
    const satrec = sat.satrec || null;
    const inclination = Number(satrec?.inclo);
    const meanMotion = Number(satrec?.no); // radians per minute
    const eccentricity = Number(satrec?.ecco);
    const periodMin = meanMotion > 0 ? (2 * Math.PI) / meanMotion : Number.NaN;
    let orbitClass = null;
    if (Number.isFinite(periodMin)) {
      if (Number.isFinite(eccentricity) && eccentricity > 0.25)
        orbitClass = 'HEO';
      else if (periodMin < 128) orbitClass = 'LEO';
      else if (Math.abs(periodMin - 1436) < 30) orbitClass = 'GEO';
      else if (periodMin <= 1406) orbitClass = 'MEO';
    }
    const owner = satelliteOwner({
      ucs: sat.ucs,
      satcat: sat.satcat,
      satelliteClass: sat.satelliteClass,
    });
    const text = (value) => {
      const shown = String(value ?? '').trim();
      return shown || null;
    };
    return {
      orbitClass,
      inclinationDeg: Number.isFinite(inclination)
        ? (inclination * 180) / Math.PI
        : null,
      launchDate: text(sat.satcat?.launchDate),
      owner: text(owner?.label),
      ownerCountryCode: text(owner?.countryCode),
      operator: text(
        satelliteOperator({ ucs: sat.ucs, satelliteClass: sat.satelliteClass }),
      ),
      objectType: text(sat.satcat?.objectType),
      cosparId: text(sat.satcat?.cosparId) || cosparIdFromTleLine1(sat.line1),
      opsStatus: text(sat.satcat?.opsStatus),
      // Its imaging sensor, when the bundled pack knows it: the widest
      // standard swath is the ground it can image as it passes.
      sensor: sat.sensor
        ? {
            label: text(sat.sensor.sensor) || text(sat.sensor.label),
            swathKm: widestSwathKm(sat.sensor),
          }
        : null,
    };
  }
  /**
   * In-view records use the drawn standalone points. When Space Missions hides
   * that buffer, use current orbital positions with the caller's record limit.
   * @param {number} [maxCount] Limit for the analytic fallback.
   * @returns {Array<object>}
   */
  function getViewRecords(maxCount) {
    if (state._params?.showPoints === false) return getAnalystRecords(maxCount);
    if (!state._enabled || !state._catalog.size) return [];
    const result = [];
    for (const [noradId, sat] of state._catalog) {
      if (!isVisible(noradId)) continue;
      const position = parts.rendering._pointPosition?.(noradId);
      const carto = position ? toLonLatH(position) : null;
      if (!carto || !Number.isFinite(carto.lat) || !Number.isFinite(carto.lon))
        continue;
      result.push(
        catalogRecord(noradId, sat, {
          lat: carto.lat,
          lon: carto.lon,
          altitudeM: carto.height,
          speedMps: null,
        }),
      );
    }
    return result;
  }

  return { getAnalystRecords, getViewRecords, describeSatellite };
}
