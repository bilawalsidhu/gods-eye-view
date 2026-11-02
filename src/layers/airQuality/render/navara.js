import * as geo from '../../../geo/index.js';

function stationFeature(reading, radius) {
  const origin = geo.cartesian3.fromDegrees(reading.lon, reading.lat);
  const frame = geo.transforms.eastNorthUpToFixedFrame(origin);
  const ring = [];
  for (let i = 0; i < 48; i++) {
    const angle = (i * 2 * Math.PI) / 48;
    const local = geo.cartesian3.create(
      radius * Math.cos(angle),
      radius * Math.sin(angle),
      0,
    );
    const world = geo.matrix4.multiplyByPoint(
      frame,
      local,
      geo.cartesian3.create(),
    );
    const point = geo.cartographic.fromCartesian(world);
    ring.push([
      geo.math.toDegrees(point.longitude),
      geo.math.toDegrees(point.latitude),
    ]);
  }
  ring.push(ring[0]);
  return {
    type: 'Feature',
    id: `air-quality:${reading.id}`,
    properties: { ...reading },
    geometry: { type: 'Polygon', coordinates: [ring] },
  };
}

/** One native GeoJSON layer per AQHI colour, independent of station count. */
export function createAirQualityNavaraRenderer(engine, { view }) {
  let visible = false;
  let batches = [];
  function release(items) {
    for (const { layer, source } of items) {
      layer?.delete();
      source.delete();
    }
  }
  return {
    viewRectangle: () => engine.camera.viewRectangle(),
    setVisible(show) {
      if (visible === show) return;
      visible = show;
      for (const { layer, source, paint } of batches) {
        layer.update({ type: 'vector', source, polygon: { ...paint, show } });
      }
      engine.render.request('air-quality-visibility');
    },
    replace(rows, radius) {
      const groups = new Map();
      for (const row of rows) {
        if (!groups.has(row.color)) groups.set(row.color, []);
        groups.get(row.color).push(stationFeature(row, radius));
      }
      const next = [];
      try {
        for (const [css, features] of groups) {
          const color = Number.parseInt(css.slice(1), 16);
          const paint = {
            color,
            transparent: true,
            opacity: 0.35,
            clampToGround: true,
            outline: true,
            outlineShow: true,
            outlineColor: color,
            outlineWidth: 2,
          };
          const source = view.addSource({
            type: 'geojson',
            data: { type: 'FeatureCollection', features },
          });
          const batch = { source, paint };
          next.push(batch);
          batch.layer = view.addLayer({
            type: 'vector',
            source,
            polygon: { ...paint, show: visible },
          });
        }
      } catch (error) {
        release(next);
        throw error;
      }
      release(batches);
      batches = next;
      engine.render.request('air-quality-readings');
    },
    destroy() {
      release(batches);
      batches = [];
      engine.render.request('air-quality-destroy');
    },
  };
}
