/**
 * Interactive Geofence & Proximity Alerting Engine.
 *
 * Evaluates real-time geospatial entity breaches across circular and
 * polygonal perimeter zones using ray-casting point-in-polygon and spherical geodesics.
 */

import { getTacticalAudio } from '../audio/tacticalAudio.js';

const EARTH_RADIUS_M = 6371008.8;
const STORAGE_KEY = 'gev:geofences:v1';

/**
 * Spherical distance between two points in meters (Haversine).
 */
export function haversineDistanceM(lat1, lon1, lat2, lon2) {
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) *
      Math.cos(phi2) *
      Math.sin(deltaLambda / 2) *
      Math.sin(deltaLambda / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

/**
 * Tests whether a point (lat, lon) is inside a polygon defined by vertices [{latDeg, lonDeg}].
 * Uses Jordan ray-casting algorithm.
 */
export function isPointInPolygon(lat, lon, vertices) {
  if (!Array.isArray(vertices) || vertices.length < 3) return false;
  let inside = false;
  const n = vertices.length;

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = vertices[i].lonDeg;
    const yi = vertices[i].latDeg;
    const xj = vertices[j].lonDeg;
    const yj = vertices[j].latDeg;

    const intersect =
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;

    if (intersect) inside = !inside;
  }

  return inside;
}

export class GeofenceEngine {
  /**
   * @param {object} [options]
   * @param {TacticalAudioEngine} [options.audioEngine]
   * @param {(event: { type: string, zone: object, entity: object, distanceM: number }) => void} [options.onAlert]
   */
  constructor({ audioEngine = null, onAlert = null } = {}) {
    this.audioEngine = audioEngine || getTacticalAudio();
    this.onAlert = onAlert;
    this.zones = [];
    this._insideState = new Map(); // `${zone.id}:${entity.id}` -> boolean
    this._loadStoredZones();
  }

  _loadStoredZones() {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.zones = parsed;
        }
      }
    } catch {}
  }

  _saveZones() {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.zones));
    } catch {}
  }

  /**
   * Add a circular or polygonal perimeter zone.
   * @param {object} zone
   * @param {string} zone.id
   * @param {string} zone.name
   * @param {'circle'|'polygon'} zone.type
   * @param {string} [zone.color='#00f0ff']
   * @param {'info'|'warning'|'critical'} [zone.alertLevel='warning']
   * @param {'all'|'flights'|'military'|'vessels'} [zone.filter='all']
   * @param {{ latDeg: number, lonDeg: number }} [zone.center] - for circle
   * @param {number} [zone.radiusM] - for circle
   * @param {Array<{ latDeg: number, lonDeg: number }>} [zone.vertices] - for polygon
   */
  addZone(zone) {
    if (!zone || !zone.id) return;
    this.removeZone(zone.id);
    const validated = {
      id: zone.id,
      name: zone.name || `Zone ${this.zones.length + 1}`,
      type: zone.type || (zone.vertices ? 'polygon' : 'circle'),
      color: zone.color || '#00f0ff',
      alertLevel: zone.alertLevel || 'warning',
      filter: zone.filter || 'all',
      center: zone.center || null,
      radiusM: Number(zone.radiusM) || 50000,
      vertices: zone.vertices || null,
      createdAt: Date.now(),
    };
    this.zones.push(validated);
    this._saveZones();
  }

  removeZone(zoneId) {
    const idx = this.zones.findIndex((z) => z.id === zoneId);
    if (idx >= 0) {
      this.zones.splice(idx, 1);
      // Clean up cached states
      for (const key of this._insideState.keys()) {
        if (key.startsWith(`${zoneId}:`)) {
          this._insideState.delete(key);
        }
      }
      this._saveZones();
    }
  }

  clearZones() {
    this.zones = [];
    this._insideState.clear();
    this._saveZones();
  }

  getZones() {
    return [...this.zones];
  }

  /**
   * Evaluates if a coordinate is inside a zone.
   * @param {number} lat
   * @param {number} lon
   * @param {object} zone
   * @returns {{ inside: boolean, distanceM: number }}
   */
  checkCoordinateInZone(lat, lon, zone) {
    if (zone.type === 'circle' && zone.center) {
      const d = haversineDistanceM(
        lat,
        lon,
        zone.center.latDeg,
        zone.center.lonDeg,
      );
      return {
        inside: d <= zone.radiusM,
        distanceM: Math.abs(d - zone.radiusM),
      };
    }

    if (zone.type === 'polygon' && zone.vertices) {
      const inside = isPointInPolygon(lat, lon, zone.vertices);
      return { inside, distanceM: 0 };
    }

    return { inside: false, distanceM: Infinity };
  }

  /**
   * Scans a list of active entities and fires breach events on zone perimeter entry.
   * @param {Array<{ id: string, latDeg: number, lonDeg: number, type?: string, name?: string }>} entities
   * @returns {Array<{ type: 'breach'|'exit', zone: object, entity: object, distanceM: number }>}
   */
  scanEntities(entities) {
    if (!Array.isArray(entities) || !this.zones.length) return [];
    const alerts = [];

    for (const entity of entities) {
      if (!entity || entity.latDeg === undefined || entity.lonDeg === undefined)
        continue;
      const entityId = entity.id || entity.name || 'entity';

      for (const zone of this.zones) {
        // Match filter
        if (
          zone.filter !== 'all' &&
          entity.type &&
          zone.filter !== entity.type
        ) {
          continue;
        }

        const { inside, distanceM } = this.checkCoordinateInZone(
          entity.latDeg,
          entity.lonDeg,
          zone,
        );

        const stateKey = `${zone.id}:${entityId}`;
        const wasInside = this._insideState.get(stateKey) || false;

        if (inside && !wasInside) {
          // Breach event!
          this._insideState.set(stateKey, true);
          const alert = {
            type: 'breach',
            zone,
            entity,
            distanceM,
            timestamp: Date.now(),
          };
          alerts.push(alert);

          if (zone.alertLevel === 'critical') {
            this.audioEngine.playGeofenceBreach();
          } else {
            this.audioEngine.playAlert();
          }

          this.onAlert?.(alert);
        } else if (!inside && wasInside) {
          // Exit event
          this._insideState.set(stateKey, false);
          alerts.push({
            type: 'exit',
            zone,
            entity,
            distanceM,
            timestamp: Date.now(),
          });
        }
      }
    }

    return alerts;
  }
}
