import * as Cesium from 'cesium';

export const UK_MAP_COLORS = Object.freeze({
  cameras: '#60dfff',
  'ea-floods': '#ff6c6c',
  'ea-rivers': '#459eff',
  'sepa-rivers': '#459eff',
  air: '#8ee28a',
  weather: '#fff1a0',
  'london-roads': '#ffac63',
  'london-rail': '#d8abff',
  'wales-incidents': '#ffac63',
  'wales-roadworks': '#ffac63',
  'ni-incidents': '#ffac63',
  'ni-roadworks': '#ffac63',
  'ni-events': '#ffac63',
  places: '#d8abff',
});

/** Render owned, pickable point collections without a per-frame entity callback. */
export function createUkMapRenderer({ viewer, onPick }) {
  const collections = new Map(),
    owner = {};
  let destroyed = false;
  function remove(id) {
    const collection = collections.get(id);
    if (!collection) return;
    if (!viewer.isDestroyed()) viewer.scene.primitives.remove(collection);
    collections.delete(id);
    if (!viewer.isDestroyed()) viewer.scene.requestRender();
  }
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);
  handler.setInputAction((click) => {
    const picked = viewer.scene.pick(click.position)?.id;
    if (!destroyed && picked?.owner === owner)
      onPick(picked.sourceId, picked.row);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  return {
    remove,
    replace(id, rows) {
      if (destroyed || viewer.isDestroyed()) return;
      remove(id);
      if (!rows.length) return;
      const collection = viewer.scene.primitives.add(
        new Cesium.PointPrimitiveCollection(),
      );
      collections.set(id, collection);
      const color = Cesium.Color.fromCssColorString(
        UK_MAP_COLORS[id] || '#ffffff',
      );
      for (const row of rows)
        collection.add({
          position: Cesium.Cartesian3.fromDegrees(row.lon, row.lat, 30),
          color,
          pixelSize: 4,
          scaleByDistance: new Cesium.NearFarScalar(50000, 1.3, 2000000, 0.6),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 0.5,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          id: { owner, sourceId: id, row },
        });
      viewer.scene.requestRender();
    },
    destroy() {
      destroyed = true;
      handler.destroy();
      for (const id of [...collections.keys()]) remove(id);
    },
  };
}
