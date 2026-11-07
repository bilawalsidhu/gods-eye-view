// A prototype earthquake renderer on engine.ground, for every engine: each
// disc a ground disc of its radius in the Cesium renderer's fill, picked as
// `earthquake:${stableId}`. Without the outline cesium.js asks for: Cesium
// draws no outline on a ground-clamped ellipse, nor does navara.js, so none
// shows today. Not wired into the layer: scripts/qa-ground-prototypes.mjs
// draws it next to cesium.js to compare.
import * as geo from '../../../geo/index.js';

const rgba = (color, alpha) => [color.red, color.green, color.blue, alpha];

export function createEarthquakesGroundRenderer(engine) {
  const set = engine.ground.createSet({
    id: 'earthquakes',
    kind: 'disc',
    pickable: true,
  });
  set.show(false);
  let visible = false;
  let rows = [];
  let destroyed = false;
  return {
    kind: 'ground',
    setVisible(show) {
      if (destroyed) return;
      visible = show !== false;
      set.show(visible);
    },
    replace(discs) {
      if (destroyed) return;
      const items = [];
      const nextRows = [];
      for (const disc of discs) {
        const place = geo.cartographic.fromCartesian(disc.position);
        if (!place) continue;
        const lon = geo.math.toDegrees(place.longitude);
        const lat = geo.math.toDegrees(place.latitude);
        items.push({
          center: [lon, lat],
          radiusM: disc.baseRadius,
          fill: rgba(disc.color, disc.fillAlpha),
          pickId: `earthquake:${disc.stableId}`,
        });
        nextRows.push({
          id: disc.usgsId ?? null,
          mag: disc.mag,
          place: disc.place,
          time: disc.time,
          depth: disc.depthKm,
          lat,
          lon,
        });
      }
      set.replace(items);
      set.commit();
      rows = nextRows;
    },
    records(limit) {
      return !destroyed && visible
        ? rows.slice(0, limit).map((row) => ({ ...row }))
        : [];
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      rows = [];
      set.destroy();
    },
  };
}
