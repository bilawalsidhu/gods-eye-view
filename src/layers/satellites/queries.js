import * as Cesium from 'cesium';
import { satelliteClassLabel } from '../../data/satelliteClass.js';
import { ISS_NORAD } from './policy.js';

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
  const noradNum = Number(raw?.noradId);
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
      noradId || group ? satelliteClassLabel(group, { isIss }) : null,
    group,
  };
}

/**
 * Analyst-record snapshot over the in-memory CelesTrak catalog.
 * On-demand only — zero per-frame cost, no listeners, no caching.
 */
export function createQueries({ state: layerState, parts }) {
  /**
   * Geodetic snapshot for one catalog row: prefer a fresh SGP4 sample so the
   * analyst answer matches "where is it now", then fall back to the last
   * rendered point (no satrec in tests that only planted a Cartesian).
   * @param {number} noradId
   * @param {{satrec?: object}|null|undefined} sat
   * @param {Date} now
   * @returns {{lat: number, lon: number, altitudeM: number, speedMps: number|null}|null}
   */
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
    const point = layerState._points.get(noradId);
    if (!point?.position) return null;
    const carto = Cesium.Cartographic.fromCartesian(point.position);
    if (!carto) return null;
    return {
      lat: Cesium.Math.toDegrees(carto.latitude),
      lon: Cesium.Math.toDegrees(carto.longitude),
      altitudeM: carto.height,
      speedMps: null,
    };
  }

  const methods = {
    /**
     * Snapshot the layer's in-memory CelesTrak catalog as plain JSON-safe
     * objects for the analyst query engine. On-demand only (called at most
     * once per spoken query) — zero per-frame cost, no listeners, no caching.
     * Core catalog rows are emitted before dense Starlink extras so the 2,000
     * cap keeps named constellations (ISS, GPS, GEO, …) ahead of the shell.
     * Returns [] while the layer is disabled or empty.
     * @param {number} [maxCount=2000] - Maximum records to return (truncation).
     * @returns {Array<Object>} See mapAnalystRecord for the record shape.
     */
    getAnalystRecords(maxCount = 2000) {
      if (!layerState._enabled || !layerState._catalog.size) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const now = new Date();
      const result = [];
      const emit = (noradId, sat) => {
        if (result.length >= limit) return false;
        const pos = analystGeo(noradId, sat, now);
        if (!pos) return true;
        result.push(
          mapAnalystRecord({
            noradId,
            name: sat?.name,
            group: sat?.group,
            lat: pos.lat,
            lon: pos.lon,
            altitudeM: pos.altitudeM,
            speedMps: pos.speedMps,
          }),
        );
        return result.length < limit;
      };
      for (const [noradId, sat] of layerState._catalog) {
        if (sat?.group === 'dense') continue;
        if (!emit(noradId, sat)) break;
      }
      if (result.length < limit) {
        for (const [noradId, sat] of layerState._catalog) {
          if (sat?.group !== 'dense') continue;
          if (!emit(noradId, sat)) break;
        }
      }
      return result;
    },
  };

  return { methods };
}
