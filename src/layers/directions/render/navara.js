import * as geo from '../../../geo/index.js';

function endpointAtlas(letter, css) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.arc(32, 32, 10, 0, 2 * Math.PI);
  ctx.fillStyle = css;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'black';
  ctx.stroke();
  ctx.font = 'bold 17px monospace';
  ctx.textAlign = 'center';
  ctx.lineWidth = 3;
  ctx.strokeText(letter, 32, 17);
  ctx.fillStyle = 'white';
  ctx.fillText(letter, 32, 17);
  return { canvas, cells: { pin: [0, 0, 1, 1] } };
}

// Bake the route into bounded pieces once. Each keeps every original turn.
// Features share one clamped vector layer. Only their opacity changes per tick.
function flowFeatures(path) {
  const vertices = path.map(([lon, lat]) =>
    geo.cartesian3.fromDegrees(lon, lat),
  );
  const arc = [0];
  for (let i = 1; i < vertices.length; i++)
    arc.push(
      arc[i - 1] + geo.cartesian3.distance(vertices[i - 1], vertices[i]),
    );
  const total = arc.at(-1),
    features = [];
  if (!total) return features;
  const n = 64 * 6;
  let start = path[0],
    i = 1;
  for (let j = 1; j <= n; j++) {
    const endAt = (total * j) / n,
      points = [start];
    while (i < path.length - 1 && arc[i] < endAt) points.push(path[i++]);
    const f = Math.max(
      0,
      Math.min(1, (endAt - arc[i - 1]) / (arc[i] - arc[i - 1] || 1)),
    );
    const [lon, lat] = path[i - 1],
      [nextLon, nextLat] = path[i];
    const delta = ((nextLon - lon + 540) % 360) - 180;
    start =
      j === n
        ? path.at(-1)
        : [((lon + f * delta + 540) % 360) - 180, lat + f * (nextLat - lat)];
    points.push(start);
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: points },
      properties: { phase: (j - 0.5) / 6 },
    });
  }
  return features;
}
export function createDirectionsNavaraRenderer(engine, { view }) {
  const assets = new Map();
  let steps = [],
    bank,
    capacity = 0;
  const syncSteps = () => {
    if (steps.length > capacity) {
      bank?.destroy();
      capacity = steps.length;
      bank = engine.movers.createSet({
        id: 'directions-steps',
        kind: 'point',
        capacity,
        depthTest: 'always',
        pickable: true,
        point: { sizePx: 8, outlinePx: 2, outlineColor: [0.22, 0.82, 1, 1] },
      });
    }
    if (!bank) return;
    steps.forEach((p, i) =>
      bank.set(i, {
        position: p.position,
        show: p.show,
        scale: p.pixelSize / 8,
        color: [1, 1, 1, 0.95],
        pickId: p.id,
      }),
    );
    bank.setCount(steps.length);
    bank.commit();
    engine.render.request('directions-steps');
  };
  return {
    steps: {
      get length() {
        return steps.length;
      },
      get: (i) => steps[i],
      add(p) {
        steps.push(p);
        return p;
      },
      removeAll() {
        steps = [];
        syncSteps();
      },
      sync: syncSteps,
    },
    marker(letter, point, css) {
      const bank = engine.movers.createSet({
        id: 'directions-marker-' + letter,
        kind: 'sprite',
        capacity: 1,
        depthTest: 'always',
        pickable: false,
        sprite: { sizePx: 48, atlas: endpointAtlas(letter, css) },
      });
      const carto = geo.cartographic.fromDegrees(point.lon, point.lat);
      const place = () => {
        const h = engine.surface.terrainHeight(carto) ?? 0;
        bank.set(0, {
          position: geo.cartesian3.fromDegrees(point.lon, point.lat, h),
          cell: 'pin',
          color: [1, 1, 1, 1],
          show: true,
        });
        bank.setCount(1);
        bank.commit();
      };
      let remove;
      try {
        place();
        remove = engine.camera.moveEnd.addEventListener(place);
      } catch (e) {
        bank.destroy();
        throw e;
      }
      const handle = {
        destroy() {
          remove();
          bank.destroy();
          assets.delete(handle);
        },
      };
      assets.set(handle, true);
      return handle;
    },
    route(path, css) {
      const features = flowFeatures(path);
      const source = view.addSource({
        type: 'geojson',
        data: { type: 'FeatureCollection', features },
      });
      let layer, remove;
      try {
        layer = view.addLayer({
          type: 'vector',
          source,
          polyline: {
            color: parseInt(css.slice(1), 16),
            width: 9,
            lit: false,
            transparent: true,
            clampToGround: true,
          },
        });
        layer.on('featureUpdated', ({ evaluator }) => {
          const t = (performance.now() / 1000) * 0.55;
          evaluator.evaluate(({ properties }) => {
            const x = (properties.phase - t) % 1;
            return { opacity: (x + 1) % 1 < 0.46 ? 0.95 : 0.18 };
          });
        });
        let frame = -1;
        remove = engine.frames.preRender.addEventListener(() => {
          const n = Math.floor(performance.now() / 60);
          if (n !== frame) {
            frame = n;
            layer.forceUpdate();
          }
        });
      } catch (e) {
        layer?.delete();
        source.delete();
        throw e;
      }
      const handle = {
        destroy() {
          remove?.();
          layer.delete();
          source.delete();
          assets.delete(handle);
        },
      };
      assets.set(handle, true);
      return handle;
    },
    destroy() {
      for (const h of assets.keys()) h.destroy();
      bank?.destroy();
      bank = null;
      capacity = 0;
      steps = [];
    },
  };
}
