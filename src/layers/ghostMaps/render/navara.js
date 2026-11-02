import { bindProductPicks } from './navaraPick.js';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function tint(rgba, fallback) {
  if (!rgba) return parseInt(fallback.slice(1), 16);
  return (
    (Math.round(rgba[0] * 255) << 16) |
    (Math.round(rgba[1] * 255) << 8) |
    Math.round(rgba[2] * 255)
  );
}

function closedRing(ring) {
  const last = ring.at(-1);
  return last[0] === ring[0][0] && last[1] === ring[0][1]
    ? ring
    : [...ring, ring[0]];
}

/** Native vector batches preserve each KML style and carry the source feature ID in picks. */
export function createGhostMapsNavaraRenderer(engine, view) {
  return {
    requestRender: () => engine.render.request('s2-ghostmaps'),
    onClick: (run) =>
      engine.input.on('click', (event) => run(event, () => event.picked), {
        pick: true,
      }),
    draw(productId, features, fallback, markerImage) {
      const groups = new Map();
      function add(style, geom, id) {
        const key = JSON.stringify(style);
        if (!groups.has(key)) groups.set(key, { style, features: [] });
        groups
          .get(key)
          .features.push({
            type: 'Feature',
            geometry: geom,
            properties: { gevId: id },
          });
      }
      for (const [index, feature] of features.entries()) {
        const { style } = feature;
        const line = {
          color: tint(style.lineColor, fallback),
          opacity: style.lineColor?.[3] ?? 1,
          width: clamp(style.lineWidth ?? 2, 1.5, 8),
          transparent: true,
          clampToGround: true,
        };
        for (const [part, geometry] of feature.geometries.entries()) {
          const id = `ghostmaps:${productId}:${index}:${part}`;
          if (geometry.type === 'point') {
            const color =
              style.iconColor && style.icon ? style.iconColor : null;
            const billboard = {
              url: style.icon || markerImage(fallback),
              sizeInMeters: false,
              size: 20 * clamp((style.iconScale ?? 1) * 0.7, 0.35, 1.5),
              color: tint(color, '#ffffff'),
              opacity: color?.[3] ?? 1,
              clampToGround: true,
              declutter: false,
              offsetDepth: true,
            };
            add(
              { billboard },
              { type: 'Point', coordinates: geometry.position },
              id,
            );
          } else if (geometry.type === 'line') {
            add(
              { polyline: line },
              { type: 'LineString', coordinates: geometry.positions },
              id,
            );
          } else {
            const outer = closedRing(geometry.outer);
            if (style.fill !== false)
              add(
                {
                  polygon: {
                    color: tint(style.polyColor, fallback),
                    opacity: style.polyColor?.[3] ?? 0.25,
                    transparent: true,
                    clampToGround: true,
                  },
                },
                {
                  type: 'Polygon',
                  coordinates: [outer, ...geometry.holes.map(closedRing)],
                },
                id,
              );
            if (style.outline !== false)
              add(
                { polyline: { ...line, width: Math.min(6, line.width) } },
                { type: 'LineString', coordinates: outer },
                id,
              );
          }
        }
      }
      const batches = [];
      let unbind;
      const destroy = () => {
        unbind?.();
        for (const batch of batches.splice(0)) {
          batch.layer?.delete();
          batch.source.delete();
        }
        engine.render.request('ghostmaps-release');
      };
      try {
        for (const group of groups.values()) {
          const source = view.addSource({
            type: 'geojson',
            data: { type: 'FeatureCollection', features: group.features },
          });
          const batch = { source };
          batches.push(batch);
          batch.layer = view.addLayer({
            type: 'vector',
            source,
            ...group.style,
          });
        }
        unbind = bindProductPicks(engine, productId, features);
      } catch (error) {
        destroy();
        throw error;
      }
      engine.render.request('ghostmaps-data');
      return { destroy };
    },
    destroy() {},
  };
}
