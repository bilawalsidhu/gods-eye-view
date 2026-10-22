import * as Cesium from 'cesium';

/**
 * @module layers/safespot/telemetry
 * @description Garmin fēnix 6 Pro Solar real-time telemetry, multi-sensor location fusion,
 * and barometer 3D floor elevation visualizer for God's Eye View.
 *
 * Implements:
 * - Multi-source location fusion states:
 *   - Watch GNSS: draped ellipse with accuracy radius (±10m).
 *   - Phone GPS: draped ellipse with larger accuracy radius (±25m).
 *   - BLE Beacon: 3D cylinder envelope with micro-location precision (<5m).
 *   - Fused location marker.
 * - Barometer 3D floor elevation:
 *   - Vertical altitude stalk: Polyline from ground H_ground up to Z = H_ground + floors * 2.8 + 1.2m.
 *   - 3D billboard pin at elevation Z.
 * - Emergency fall alert / SOS beacon visualization.
 *
 * STRICT INVARIANT: noCesiumLabels! No Cesium LabelCollection or entity labels.
 * All badges, pins, and HUD elements use inline SVG data URIs via BillboardGraphics
 * and PointGraphics with disableDepthTestDistance: Number.POSITIVE_INFINITY.
 */

export const TELEMETRY_COLORS = Object.freeze({
  WATCH_GNSS: '#06b6d4', // Cyan
  PHONE_GPS: '#f59e0b', // Amber
  BLE_BEACON: '#a855f7', // Purple
  FUSED_MARKER: '#10b981', // Emerald
  STALK_COLOR: '#38bdf8', // Neon Sky Cyan
  ALERT_CRITICAL: '#ef4444', // Crimson Red
});

/** Encode SVG text as a data URL */
export function svgToDataUri(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.trim())}`;
}

/**
 * Calculate Barometer 3D elevation above ground level.
 * Formula: Z = H_ground + floors * 2.8 + 1.2m
 * (2.8m standard HDB floor-to-ceiling height, 1.2m body waist/wrist sensor elevation)
 *
 * @param {number} floors Number of floors above ground (0 for ground level)
 * @param {number} [groundAlt=0] Terrain altitude in meters
 * @returns {number} Calculated altitude in meters
 */
export function calculateBarometerAltitude(floors, groundAlt = 0) {
  const safeFloors = typeof floors === 'number' && Number.isFinite(floors) ? Math.max(0, floors) : 0;
  const safeGround = typeof groundAlt === 'number' && Number.isFinite(groundAlt) ? groundAlt : 0;
  return Math.round((safeGround + safeFloors * 2.8 + 1.2) * 100) / 100;
}

/**
 * Generate SVG Floor Level Billboard Badge data URI.
 * @param {number} floors
 * @param {number} elevationMeters
 * @param {number} [heartRate=74]
 * @param {number} [battery=84]
 * @returns {string} SVG data URI
 */
export function createFloorLevelBadgeSvg(floors, elevationMeters, heartRate = 74, battery = 84) {
  const floorLevel = Math.max(1, Math.round(floors) + 1);
  const elevStr = `+${Number(elevationMeters || 0).toFixed(1)}m`;
  const hrStr = `${heartRate ?? '--'} bpm`;
  const batStr = `${battery ?? '--'}%`;
  return svgToDataUri(`
    <svg xmlns="http://www.w3.org/2000/svg" width="176" height="42" viewBox="0 0 176 42">
      <defs>
        <filter id="shadow" x="-10%" y="-10%" width="120%" height="120%">
          <feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-color="#000000" flood-opacity="0.72"/>
        </filter>
        <linearGradient id="stalkBadgeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#0a0e17"/>
          <stop offset="100%" stop-color="#111827"/>
        </linearGradient>
      </defs>
      <rect filter="url(#shadow)" x="1" y="1" width="174" height="40" rx="6"
        fill="url(#stalkBadgeGrad)" fill-opacity="0.94" stroke="#38bdf8" stroke-width="1"/>
      <!-- Watch icon circle -->
      <circle cx="19" cy="21" r="10" fill="#0f172a" stroke="#38bdf8" stroke-width="0.8"/>
      <rect x="16" y="14" width="6" height="14" rx="1.5" fill="#38bdf8"/>
      <circle cx="19" cy="21" r="4" fill="#0a0e17"/>
      <circle cx="19" cy="21" r="2" fill="#38bdf8"/>
      <!-- Level Title -->
      <text x="35" y="18" font-family="'JetBrains Mono', 'Inter', monospace"
        font-size="10.5" font-weight="800" fill="#f8fafc">LEVEL ${floorLevel}</text>
      <text x="88" y="18" font-family="'JetBrains Mono', monospace"
        font-size="9.5" font-weight="700" fill="#38bdf8">(${elevStr})</text>
      <!-- HR & Battery status -->
      <circle cx="38" cy="30" r="2.5" fill="#ef4444"/>
      <text x="44" y="33" font-family="'JetBrains Mono', monospace"
        font-size="8.5" font-weight="700" fill="#ef4444">${hrStr}</text>
      <rect x="92" y="27.5" width="6" height="5" rx="1" fill="none" stroke="#10b981" stroke-width="1"/>
      <rect x="93.5" y="29" width="3" height="2" fill="#10b981"/>
      <text x="101" y="33" font-family="'JetBrains Mono', monospace"
        font-size="8.5" font-weight="700" fill="#10b981">${batStr}</text>
      <text x="134" y="33" font-family="'Inter', system-ui, sans-serif"
        font-size="7.5" font-weight="600" fill="#94a3b8">fēnix 6</text>
    </svg>
  `);
}

/**
 * Generate SVG Emergency Fall Alert Billboard data URI.
 * @param {number} floors
 * @returns {string} SVG data URI
 */
export function createFallAlertBadgeSvg(floors) {
  const floorLevel = Math.max(1, Math.round(floors) + 1);
  return svgToDataUri(`
    <svg xmlns="http://www.w3.org/2000/svg" width="220" height="56" viewBox="0 0 220 56">
      <defs>
        <filter id="alertGlow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#ef4444" flood-opacity="0.9"/>
        </filter>
      </defs>
      <rect filter="url(#alertGlow)" x="2" y="2" width="216" height="52" rx="8"
        fill="#991b1b" stroke="#ffffff" stroke-width="2.5"/>
      <!-- Warning triangle -->
      <path fill="#ffffff" d="M24 12 L10 38 L38 38 Z"/>
      <path fill="#991b1b" d="M22.5 20 h3 v9 h-3 Z M22.5 31 h3 v3 h-3 Z"/>
      <!-- Alert Text -->
      <text x="46" y="25" font-family="system-ui, -apple-system, sans-serif"
        font-size="12" font-weight="900" fill="#ffffff">FALL DETECTED</text>
      <text x="46" y="42" font-family="system-ui, -apple-system, sans-serif"
        font-size="10" font-weight="800" fill="#fecaca">Level ${floorLevel} · Immediate Response</text>
    </svg>
  `);
}

/**
 * Generate SVG Sensor Marker Pin.
 * @param {string} sensorType 'watch' | 'phone' | 'beacon' | 'fused'
 * @returns {string} SVG data URI
 */
export function createSensorPinSvg(sensorType) {
  let color = TELEMETRY_COLORS.FUSED_MARKER;
  let icon = 'M14 18 L14 14 L18 14 L18 18 Z';

  if (sensorType === 'watch') {
    color = TELEMETRY_COLORS.WATCH_GNSS;
    icon = 'M12 10 h8 v12 h-8 Z';
  } else if (sensorType === 'phone') {
    color = TELEMETRY_COLORS.PHONE_GPS;
    icon = 'M12 8 h8 v16 h-8 Z';
  } else if (sensorType === 'beacon') {
    color = TELEMETRY_COLORS.BLE_BEACON;
    icon = 'M16 8 L22 14 L16 20 L10 14 Z';
  }

  return svgToDataUri(`
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="38" viewBox="0 0 32 38">
      <defs>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000000" flood-opacity="0.6"/>
        </filter>
      </defs>
      <path filter="url(#shadow)" fill="${color}" stroke="#ffffff" stroke-width="2"
        d="M16 2 C8.8 2 3 7.8 3 15 C3 24 16 36 16 36 C16 36 29 24 29 15 C29 7.8 23.2 2 16 2 Z"/>
      <circle cx="16" cy="15" r="7" fill="#ffffff"/>
      <path fill="${color}" d="${icon}"/>
    </svg>
  `);
}

/**
 * SafeSpot Garmin fēnix 6 Pro Solar Telemetry & Multi-Sensor Fusion Visualizer.
 */
export class SafeSpotTelemetryVisualizer {
  constructor(viewer, { surface = null } = {}) {
    this._viewer = viewer;
    this._surface = surface;
    this._dataSource = new Cesium.CustomDataSource('safespot-watch-telemetry');
    this._attached = false;
    this._lastTelemetry = null;
    this._activeAlert = null;
    this._stalkCartesians = [];
  }

  /** Attach data source to viewer */
  attach() {
    if (!this._viewer || this._attached) return;
    if (!this._viewer.dataSources.contains(this._dataSource)) {
      this._viewer.dataSources.add(this._dataSource);
    }
    this._attached = true;
    this._dataSource.show = true;
  }

  /** Detach data source from viewer */
  detach() {
    if (!this._viewer || !this._attached) return;
    this._dataSource.show = false;
    this._attached = false;
  }

  /** Clear all telemetry visual primitives */
  clear() {
    this._dataSource.entities.removeAll();
    this._stalkCartesians = [];
  }

  /** Complete teardown */
  destroy() {
    this.detach();
    this.clear();
    if (this._viewer && !this._viewer.isDestroyed()) {
      try {
        this._viewer.dataSources.remove(this._dataSource, true);
      } catch {
        // ignore
      }
    }
    this._viewer = null;
    this._surface = null;
    this._lastTelemetry = null;
    this._activeAlert = null;
  }

  /**
   * Sample ground terrain elevation at specified coordinates.
   * @param {number} lng
   * @param {number} lat
   * @returns {number} Altitude in meters
   */
  getGroundAltitude(lng, lat) {
    if (this._viewer?.scene?.globe) {
      try {
        const carto = Cesium.Cartographic.fromDegrees(lng, lat);
        const height = this._viewer.scene.globe.getHeight(carto);
        if (typeof height === 'number' && Number.isFinite(height)) {
          return height;
        }
      } catch {
        // Globe sampling not available in mock/headless
      }
    }
    return 0;
  }

  /**
   * Render or update multi-source location fusion states, uncertainty envelopes,
   * and barometer 3D floor elevation stalk.
   *
   * @param {object} telemetry Telemetry frame from WebSocket tick or REST status
   */
  updateTelemetry(telemetry) {
    this.clear();
    if (!telemetry) return;
    this._lastTelemetry = telemetry;

    const entities = this._dataSource.entities;

    // Normalize coordinates & sensor fields across both WS tick and REST schemas
    const fused = telemetry.fusedLocation || telemetry;
    const sensors = telemetry.sensorStreams || telemetry.sensors || telemetry.rawSensors || {};

    const fusedLat = Number(fused.lat);
    const fusedLng = Number(fused.lng);
    if (!Number.isFinite(fusedLat) || !Number.isFinite(fusedLng)) return;

    const groundAlt = this.getGroundAltitude(fusedLng, fusedLat);

    // Extract sensor components
    const watchGnss = sensors.watchGnss || sensors.watchGps || {
      lat: fusedLat + 0.00002,
      lng: fusedLng + 0.00001,
      accuracy: 12,
    };
    const phoneGps = sensors.phoneGps || {
      lat: fusedLat - 0.00003,
      lng: fusedLng + 0.00002,
      accuracy: 25,
    };
    const bleBeacon = (Array.isArray(sensors.bleBeacons) ? sensors.bleBeacons[0] : sensors.bleBeacon) || {
      lat: fusedLat,
      lng: fusedLng,
      estimatedDistanceMeters: 2.4,
    };

    const floors = typeof fused.floorsAbove === 'number'
      ? fused.floorsAbove
      : (typeof sensors.barometer?.floorsAbove === 'number'
        ? sensors.barometer.floorsAbove
        : 3);

    const barometerAlt = calculateBarometerAltitude(floors, groundAlt);
    const heartRate = telemetry.heartRate ?? telemetry.deviceState?.heartRate ?? 74;
    const battery = telemetry.battery ?? telemetry.deviceState?.battery ?? 84;

    // 1. Watch GNSS Uncertainty Envelope (Draped Ellipse with accuracy ~10-12m)
    const watchAcc = Number(watchGnss.accuracy || 12);
    const watchPos = Cesium.Cartesian3.fromDegrees(Number(watchGnss.lng), Number(watchGnss.lat), 0);
    entities.add({
      id: 'safespot:telemetry:watch-envelope',
      name: `Watch GNSS Uncertainty (±${watchAcc}m)`,
      position: watchPos,
      ellipse: {
        semiMinorAxis: watchAcc,
        semiMajorAxis: watchAcc,
        material: Cesium.Color.fromCssColorString(TELEMETRY_COLORS.WATCH_GNSS).withAlpha(0.25),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        classificationType: Cesium.ClassificationType.BOTH,
      },
    });
    entities.add({
      id: 'safespot:telemetry:watch-pin',
      name: 'Garmin fēnix 6 Watch GNSS Fix',
      position: watchPos,
      billboard: {
        image: createSensorPinSvg('watch'),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scale: 0.85,
        scaleByDistance: new Cesium.NearFarScalar(1200, 1.0, 18000, 0.35),
      },
    });

    // 2. Phone GPS Uncertainty Envelope (Draped Ellipse with larger accuracy ~25m)
    const phoneAcc = Number(phoneGps.accuracy || 25);
    const phonePos = Cesium.Cartesian3.fromDegrees(Number(phoneGps.lng), Number(phoneGps.lat), 0);
    entities.add({
      id: 'safespot:telemetry:phone-envelope',
      name: `Phone GPS Uncertainty (±${phoneAcc}m)`,
      position: phonePos,
      ellipse: {
        semiMinorAxis: phoneAcc,
        semiMajorAxis: phoneAcc,
        material: Cesium.Color.fromCssColorString(TELEMETRY_COLORS.PHONE_GPS).withAlpha(0.18),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        classificationType: Cesium.ClassificationType.BOTH,
      },
    });
    entities.add({
      id: 'safespot:telemetry:phone-pin',
      name: 'Companion Phone GPS Fix',
      position: phonePos,
      billboard: {
        image: createSensorPinSvg('phone'),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scale: 0.85,
        scaleByDistance: new Cesium.NearFarScalar(1200, 1.0, 18000, 0.35),
      },
    });

    // 3. BLE Beacon Envelope (3D Cylinder & Draped circle with <5m radius)
    const beaconDist = Number(bleBeacon.estimatedDistanceMeters || bleBeacon.distanceM || 3.0);
    const beaconRadius = Math.min(Math.max(2.0, beaconDist), 4.8);
    const beaconLat = Number(bleBeacon.lat ?? fusedLat);
    const beaconLng = Number(bleBeacon.lng ?? fusedLng);
    const beaconPos = Cesium.Cartesian3.fromDegrees(beaconLng, beaconLat, 0);

    entities.add({
      id: 'safespot:telemetry:beacon-drape',
      name: `BLE Beacon Micro-Location (<5m envelope)`,
      position: beaconPos,
      ellipse: {
        semiMinorAxis: beaconRadius,
        semiMajorAxis: beaconRadius,
        material: Cesium.Color.fromCssColorString(TELEMETRY_COLORS.BLE_BEACON).withAlpha(0.3),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        classificationType: Cesium.ClassificationType.BOTH,
      },
    });

    entities.add({
      id: 'safespot:telemetry:beacon-pin',
      name: 'BLE Proximity Beacon',
      position: beaconPos,
      billboard: {
        image: createSensorPinSvg('beacon'),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scale: 0.8,
        scaleByDistance: new Cesium.NearFarScalar(1200, 1.0, 18000, 0.35),
      },
    });

    // 4. Barometer 3D Floor Elevation: Vertical Altitude Stalk
    const groundCartesian = Cesium.Cartesian3.fromDegrees(fusedLng, fusedLat, groundAlt);
    const stalkTopCartesian = Cesium.Cartesian3.fromDegrees(fusedLng, fusedLat, barometerAlt);
    this._stalkCartesians = [groundCartesian, stalkTopCartesian];

    // Vertical stalk polyline (in the air from ground up to Z)
    entities.add({
      id: 'safespot:telemetry:barometer-stalk',
      name: `Barometer Floor Elevation Stalk (+${(barometerAlt - groundAlt).toFixed(1)}m)`,
      polyline: {
        positions: [groundCartesian, stalkTopCartesian],
        width: 4,
        material: Cesium.Color.fromCssColorString(TELEMETRY_COLORS.STALK_COLOR),
      },
    });

    // Ground footprint anchor point
    entities.add({
      id: 'safespot:telemetry:ground-anchor',
      name: 'Ground Footprint Anchor',
      position: groundCartesian,
      point: {
        pixelSize: 8,
        color: Cesium.Color.fromCssColorString(TELEMETRY_COLORS.STALK_COLOR),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });

    // Elevated 3D Billboard Pin at altitude Z
    entities.add({
      id: 'safespot:telemetry:floor-marker',
      name: `fēnix 6 Pro Solar: Level ${floors + 1} (${barometerAlt.toFixed(1)}m)`,
      position: stalkTopCartesian,
      billboard: {
        image: createFloorLevelBadgeSvg(floors, barometerAlt - groundAlt, heartRate, battery),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scale: 1.0,
        scaleByDistance: new Cesium.NearFarScalar(1000, 1.0, 14000, 0.0),
        translucencyByDistance: new Cesium.NearFarScalar(2500, 1.0, 12000, 0.0),
      },
      point: {
        pixelSize: 12,
        color: Cesium.Color.fromCssColorString(TELEMETRY_COLORS.FUSED_MARKER),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });

    // 5. If Fall Alert Active: Render Emergency Alert Beacon
    if (this._activeAlert || telemetry.sosActive || telemetry.eventType === 'FALL_DETECTED') {
      entities.add({
        id: 'safespot:telemetry:fall-alert',
        name: 'CRITICAL ALERT: Senior Fall Detected',
        position: stalkTopCartesian,
        billboard: {
          image: createFallAlertBadgeSvg(floors),
          verticalOrigin: Cesium.VerticalOrigin.TOP,
          pixelOffset: new Cesium.Cartesian2(0, 10),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scale: 1.1,
        },
      });
    }

    if (this._viewer && typeof this._viewer.scene?.requestRender === 'function') {
      this._viewer.scene.requestRender();
    }
  }

  /**
   * Trigger emergency fall alert in visualization.
   * @param {object} alert
   */
  triggerFallAlert(alert = {}) {
    this._activeAlert = alert;
    if (this._lastTelemetry) {
      this.updateTelemetry({ ...this._lastTelemetry, sosActive: true, eventType: 'FALL_DETECTED' });
    }
  }

  /**
   * Clear active fall alert.
   */
  clearAlert() {
    this._activeAlert = null;
    if (this._lastTelemetry) {
      this.updateTelemetry({ ...this._lastTelemetry, sosActive: false, eventType: 'HEARTBEAT' });
    }
  }

  /**
   * Fly camera to focus on watch telemetry stalk and floor elevation.
   */
  flyToWatch() {
    if (!this._viewer || this._stalkCartesians.length === 0) return;
    try {
      const boundingSphere = Cesium.BoundingSphere.fromPoints(this._stalkCartesians);
      this._viewer.camera.flyToBoundingSphere(boundingSphere, {
        duration: 1.5,
        offset: new Cesium.HeadingPitchRange(
          Cesium.Math.toRadians(45),
          Cesium.Math.toRadians(-30),
          Math.max(boundingSphere.radius * 3.5, 40),
        ),
      });
    } catch (err) {
      console.warn('[SafeSpotTelemetryVisualizer] flyToWatch error:', err);
    }
  }
}
