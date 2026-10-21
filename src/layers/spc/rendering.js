import * as Cesium from 'cesium';

/** Ground-classified risk bands on terrain AND photorealistic 3D tiles. */
export function createSpcRendering({ viewer, cesium: C = Cesium }) {
  const source = new C.CustomDataSource('severe-weather-outlooks');
  viewer.dataSources.add(source);
  const rowsByPick = new Map();
  const render = () => viewer.scene.requestRender?.();
  return {
    setSnapshot(snapshot) {
      source.entities.removeAll();
      rowsByPick.clear();
      const alpha = snapshot.product.endsWith('-tornado') ? 0.7 : 0.35;
      for (const row of snapshot.rows) {
        for (const [index, rings] of row.polygons.entries()) {
          const positions = rings.map((ring) =>
            ring.map(([lon, lat]) => C.Cartesian3.fromDegrees(lon, lat)),
          );
          const id = `spc:${snapshot.product}:${row.id}:${index}`;
          // NOAA publishes bands, not additive probabilities. Interior holes
          // separate higher-risk bands; never flatten or refill them.
          const entity = source.entities.add({
            id,
            polygon: {
              hierarchy: new C.PolygonHierarchy(
                positions[0],
                positions.slice(1).map((ring) => new C.PolygonHierarchy(ring)),
              ),
              material: C.Color.fromCssColorString(row.fill).withAlpha(alpha),
              classificationType: C.ClassificationType.BOTH,
              arcType: C.ArcType.GEODESIC,
            },
          });
          rowsByPick.set(entity.id, row.id);
          positions.forEach((ring, ringIndex) => {
            const line = source.entities.add({
              id: `${id}:ring:${ringIndex}`,
              polyline: {
                positions: ring,
                clampToGround: true,
                width: 2,
                zIndex: row.dn,
                classificationType: C.ClassificationType.BOTH,
                material: C.Color.fromCssColorString(row.stroke),
                arcType: C.ArcType.GEODESIC,
              },
            });
            rowsByPick.set(line.id, row.id);
          });
        }
      }
      render();
    },
    pickRow(picked) {
      const value = picked?.id ?? picked?.primitive?.id;
      return (
        rowsByPick.get(typeof value === 'object' ? value?.id : value) ?? null
      );
    },
    clear() {
      source.entities.removeAll();
      rowsByPick.clear();
      render();
    },
    destroy() {
      rowsByPick.clear();
      viewer.dataSources.remove(source, true);
      render();
    },
  };
}
