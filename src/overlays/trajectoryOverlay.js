/**
 * Trajectory & Orbital Footprint Cesium Overlay.
 *
 * Renders 3D futuristic polyline ribbons and groundtrack footprint cones in Cesium.
 */

import * as Cesium from 'cesium';
import {
  predictVehicleTrajectory,
  predictSatelliteOrbit,
} from '../layers/trajectoryPredictor.js';

export class TrajectoryOverlay {
  /**
   * @param {Cesium.Viewer} viewer
   */
  constructor(viewer) {
    this.viewer = viewer;
    this.dataSource = new Cesium.CustomDataSource('gev-trajectories');
    this.activeEntityId = null;
    this._enabled = true;
    this._mounted = false;
    this._init();
  }

  _init() {
    if (this.viewer && this.viewer.dataSources && !this._mounted) {
      this.viewer.dataSources.add(this.dataSource);
      this._mounted = true;
    }
  }

  setEnabled(enabled) {
    this._enabled = Boolean(enabled);
    if (this.dataSource) {
      this.dataSource.show = this._enabled;
    }
    if (!this._enabled) {
      this.clear();
    }
  }

  isEnabled() {
    return this._enabled;
  }

  clear() {
    if (this.dataSource) {
      this.dataSource.entities.removeAll();
    }
    this.activeEntityId = null;
  }

  /**
   * Render predictive trajectory for an active vehicle or satellite entity.
   * @param {object} entity
   */
  showTrajectoryForEntity(entity) {
    if (!this._enabled || !entity) return;
    this.clear();

    const entityId = entity.id || entity.name || 'target';
    this.activeEntityId = entityId;

    // Check if entity is a satellite with TLE lines
    const tle1 =
      entity?.properties?.tleLine1?.getValue?.() ||
      entity?.tleLine1 ||
      entity?.tle1;
    const tle2 =
      entity?.properties?.tleLine2?.getValue?.() ||
      entity?.tleLine2 ||
      entity?.tle2;

    if (tle1 && tle2) {
      this._renderSatelliteTrajectory(tle1, tle2, entityId);
      return;
    }

    // Otherwise vehicle (aircraft/vessel)
    this._renderVehicleTrajectory(entity, entityId);
  }

  _renderVehicleTrajectory(entity, entityId) {
    let lat = null;
    let lon = null;
    let alt = 0;
    let heading = 0;
    let speed = 0;
    let verticalRate = 0;

    // Extract telemetry from entity properties or position
    if (entity.position && typeof entity.position.getValue === 'function') {
      const time = this.viewer?.clock?.currentTime || Cesium.JulianDate.now();
      const cartesian = entity.position.getValue(time);
      if (cartesian) {
        const carto = Cesium.Cartographic.fromCartesian(cartesian);
        lat = (carto.latitude * 180) / Math.PI;
        lon = (carto.longitude * 180) / Math.PI;
        alt = carto.height;
      }
    }

    if (lat === null && entity.latitude !== undefined) {
      lat = Number(entity.latitude);
      lon = Number(entity.longitude);
      alt = Number(entity.altitude || entity.altitudeM || 0);
    }

    if (lat === null) return;

    heading = Number(
      entity?.properties?.heading?.getValue?.() ||
        entity?.heading ||
        entity?.trueTrack ||
        0,
    );
    speed = Number(
      entity?.properties?.speed?.getValue?.() ||
        entity?.speed ||
        entity?.groundSpeedKts ||
        250,
    );
    verticalRate = Number(
      entity?.properties?.verticalRate?.getValue?.() ||
        entity?.verticalRate ||
        0,
    );

    const segments = predictVehicleTrajectory({
      latDeg: lat,
      lonDeg: lon,
      altitudeM: alt,
      headingDeg: heading,
      speedKts: speed,
      verticalRateFpm: verticalRate,
    });

    segments.forEach((seg, idx) => {
      const positions = seg.waypoints.map((wp) =>
        Cesium.Cartesian3.fromDegrees(wp.lonDeg, wp.latDeg, wp.altitudeM),
      );

      if (positions.length < 2) return;

      const cesiumColor = Cesium.Color.fromCssColorString(seg.color).withAlpha(
        idx === 0 ? 0.9 : idx === 1 ? 0.65 : 0.4,
      );

      this.dataSource.entities.add({
        id: `gev-traj-${entityId}-${seg.horizonSec}`,
        polyline: {
          positions,
          width: idx === 0 ? 3.5 : 2.5,
          material: new Cesium.PolylineDashMaterialProperty({
            color: cesiumColor,
            dashLength: 16.0,
          }),
        },
      });
    });
  }

  _renderSatelliteTrajectory(tle1, tle2, entityId) {
    const orbit = predictSatelliteOrbit(tle1, tle2, new Date(), 5400, 45);
    if (!orbit.groundtrack.length) return;

    const positions = orbit.groundtrack.map((wp) =>
      Cesium.Cartesian3.fromDegrees(wp.lonDeg, wp.latDeg, wp.altitudeM),
    );

    if (positions.length > 1) {
      this.dataSource.entities.add({
        id: `gev-orbit-${entityId}`,
        polyline: {
          positions,
          width: 2.0,
          material: new Cesium.PolylineGlowMaterialProperty({
            glowPower: 0.25,
            color: Cesium.Color.CYAN.withAlpha(0.8),
          }),
        },
      });
    }

    // Render instant sensor footprint circle
    if (orbit.currentPosition && orbit.footprintRadiusM > 0) {
      const { latDeg, lonDeg } = orbit.currentPosition;
      this.dataSource.entities.add({
        id: `gev-footprint-${entityId}`,
        position: Cesium.Cartesian3.fromDegrees(lonDeg, latDeg, 0),
        ellipse: {
          semiMajorAxis: orbit.footprintRadiusM,
          semiMinorAxis: orbit.footprintRadiusM,
          material: Cesium.Color.CYAN.withAlpha(0.12),
          outline: true,
          outlineColor: Cesium.Color.CYAN.withAlpha(0.6),
          outlineWidth: 2,
        },
      });
    }
  }

  destroy() {
    this.clear();
    if (this._mounted && this.viewer && this.viewer.dataSources) {
      this.viewer.dataSources.remove(this.dataSource, true);
      this._mounted = false;
    }
  }
}
