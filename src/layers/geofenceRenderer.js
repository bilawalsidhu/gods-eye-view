/**
 * Geofence Cesium Scene Renderer.
 *
 * Renders polygonal and circular boundary perimeters as glowing, translucent
 * Cesium polygons with animated breach alert pulses.
 */

import * as Cesium from 'cesium';

export class GeofenceRenderer {
  /**
   * @param {Cesium.Viewer} viewer
   */
  constructor(viewer) {
    this.viewer = viewer;
    this.dataSource = new Cesium.CustomDataSource('gev-geofences');
    this._mounted = false;
    this._init();
  }

  _init() {
    if (this.viewer?.dataSources && !this._mounted) {
      this.viewer.dataSources.add(this.dataSource);
      this._mounted = true;
    }
  }

  /**
   * Synchronize rendered Cesium entities with current zones.
   * @param {Array<object>} zones
   */
  render(zones = []) {
    if (!this.dataSource) return;
    this.dataSource.entities.removeAll();

    for (const zone of zones) {
      const color = Cesium.Color.fromCssColorString(zone.color || '#00f0ff');
      const fillColor = color.withAlpha(0.18);
      const outlineColor = color.withAlpha(0.85);

      if (zone.type === 'circle' && zone.center) {
        this.dataSource.entities.add({
          id: `geofence-${zone.id}`,
          position: Cesium.Cartesian3.fromDegrees(
            zone.center.lonDeg,
            zone.center.latDeg,
            0,
          ),
          ellipse: {
            semiMajorAxis: zone.radiusM,
            semiMinorAxis: zone.radiusM,
            material: fillColor,
            outline: true,
            outlineColor,
            outlineWidth: 2,
            height: 0,
          },
        });
      } else if (zone.type === 'polygon' && zone.vertices?.length >= 3) {
        const hierarchy = zone.vertices.map((v) =>
          Cesium.Cartesian3.fromDegrees(v.lonDeg, v.latDeg, 0),
        );
        this.dataSource.entities.add({
          id: `geofence-${zone.id}`,
          polygon: {
            hierarchy: new Cesium.PolygonHierarchy(hierarchy),
            material: fillColor,
            outline: true,
            outlineColor,
            outlineWidth: 2,
            height: 0,
          },
        });
      }
    }
  }

  /**
   * Visual alarm flash on perimeter breach.
   * @param {string} zoneId
   */
  flashBreach(zoneId) {
    const entity = this.dataSource?.entities?.getById(`geofence-${zoneId}`);
    if (!entity) return;

    const originalMaterial =
      entity.ellipse?.material || entity.polygon?.material;
    const flashMaterial = Cesium.Color.RED.withAlpha(0.45);

    let step = 0;
    const interval = setInterval(() => {
      step++;
      const current = step % 2 === 1 ? flashMaterial : originalMaterial;
      if (entity.ellipse) entity.ellipse.material = current;
      if (entity.polygon) entity.polygon.material = current;

      if (step >= 6) {
        clearInterval(interval);
        if (entity.ellipse) entity.ellipse.material = originalMaterial;
        if (entity.polygon) entity.polygon.material = originalMaterial;
      }
    }, 200);
  }

  clear() {
    this.dataSource?.entities?.removeAll();
  }

  destroy() {
    this.clear();
    if (this._mounted && this.viewer?.dataSources) {
      this.viewer.dataSources.remove(this.dataSource, true);
      this._mounted = false;
    }
  }
}
