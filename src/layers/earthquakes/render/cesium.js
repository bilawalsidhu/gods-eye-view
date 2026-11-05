// Native earthquake entities: static CLAMP_TO_GROUND ellipses with the
// layer's properties and analyst snapshot semantics.
import * as Cesium from 'cesium';

export function createEarthquakesCesiumRenderer(_engine, { viewer }) {
  if (!viewer?.dataSources)
    throw new TypeError('Earthquakes require a native viewer');
  const dataSource = new Cesium.CustomDataSource('earthquakes');
  dataSource.show = false;
  viewer.dataSources.add(dataSource);
  let destroyed = false;
  return {
    kind: 'cesium',
    setVisible(show) {
      if (!destroyed) dataSource.show = show !== false;
    },
    replace(discs) {
      if (destroyed) return;
      const entities = discs.map(
        ({
          stableId,
          usgsId,
          position,
          baseRadius,
          color,
          isSignificant,
          fillAlpha,
          outlineAlpha,
          mag,
          place,
          time,
          depthKm,
        }) =>
          new Cesium.Entity({
            id: `earthquake:${stableId}`,
            position,
            ellipse: {
              semiMajorAxis: baseRadius,
              semiMinorAxis: baseRadius,
              material: new Cesium.ColorMaterialProperty(
                color.withAlpha(fillAlpha),
              ),
              outline: true,
              outlineColor: color.withAlpha(outlineAlpha),
              outlineWidth: isSignificant ? 3 : 2,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            },
            properties: { usgsId, mag, place, time, depth: depthKm },
          }),
      );
      dataSource.entities.removeAll();
      for (const entity of entities) dataSource.entities.add(entity);
    },
    records(limit) {
      if (destroyed || !dataSource.show) return [];
      const now = Cesium.JulianDate.now();
      const rows = [];
      for (const entity of dataSource.entities.values) {
        if (rows.length >= limit) break;
        const position = entity.position?.getValue(now);
        const carto = position
          ? Cesium.Cartographic.fromCartesian(position)
          : null;
        const p = entity.properties;
        rows.push({
          id: p?.usgsId?.getValue(now) ?? null,
          mag: p?.mag?.getValue(now),
          place: p?.place?.getValue(now),
          time: p?.time?.getValue(now),
          depth: p?.depth?.getValue(now),
          lat: carto ? Cesium.Math.toDegrees(carto.latitude) : null,
          lon: carto ? Cesium.Math.toDegrees(carto.longitude) : null,
        });
      }
      return rows;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      viewer.dataSources.remove(dataSource, true);
    },
  };
}
