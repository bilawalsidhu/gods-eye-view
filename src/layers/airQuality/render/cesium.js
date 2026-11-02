import * as Cesium from 'cesium';

export function createAirQualityCesiumRenderer({ viewer }) {
  const dataSource = new Cesium.CustomDataSource('air-quality');
  dataSource.show = false;
  viewer.dataSources.add(dataSource);
  return {
    viewRectangle: () => viewer.camera?.computeViewRectangle?.(),
    setVisible(visible) {
      dataSource.show = visible;
    },
    replace(readings, radius) {
      dataSource.entities.removeAll();
      for (const reading of readings) {
        const position = Cesium.Cartesian3.fromDegrees(
          reading.lon,
          reading.lat,
        );
        const color = Cesium.Color.fromCssColorString(reading.color);
        dataSource.entities.add(
          new Cesium.Entity({
            id: `air-quality:${reading.id}`,
            position,
            ellipse: {
              // Static axes, as in the earthquake layer: a per-frame axis
              // re-tessellates the clamped ground primitive every frame.
              semiMajorAxis: radius,
              semiMinorAxis: radius,
              material: new Cesium.ColorMaterialProperty(color.withAlpha(0.35)),
              outline: true,
              outlineColor: color.withAlpha(0.9),
              outlineWidth: 2,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            },
            properties: {
              provider: reading.provider,
              scale: reading.scale,
              value: reading.value,
              band: reading.band,
              name: reading.name,
              zone: reading.zone,
              risk: reading.risk,
              observedMs: reading.observedMs,
              note: reading.note,
              lat: reading.lat,
              lon: reading.lon,
            },
          }),
        );
      }
    },
    destroy() {
      viewer.dataSources.remove(dataSource, true);
    },
  };
}
