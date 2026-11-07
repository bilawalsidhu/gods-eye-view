import * as geo from '../../geo/index.js';
import { polygonShape, rectangleShape } from './shapes.js';

const cyan = [0, 1, 1, 1];
const xyz = ([lon, lat, height]) =>
  geo.cartesian3.fromDegrees(lon, lat, height);

export function createPackRenderer(engine) {
  function addMesh(handle, shape, style, id) {
    if (!shape) return;
    const mesh = engine.meshes.createMesh({
      id: `scene-pack-mesh-${id}`,
      positions: shape.attributes.position.values,
      indices: shape.indices,
      uv: shape.attributes.st?.values,
      ...style,
    });
    handle.own(() => mesh.destroy());
  }
  return {
    geometry(pack, features, handle) {
      const points = features.filter((f) => f.type === 'Point');
      let bank;
      if (points.length) {
        bank = engine.movers.createSet({
          id: 'scene-pack-points-' + pack.id,
          capacity: points.length,
          kind: 'point',
          depthTest: 'normal',
          pickable: true,
          point: { sizePx: 12, outlinePx: 2, outlineColor: [0, 0, 0, 1] },
        });
        handle.own(() => bank.destroy());
      }
      let index = 0;
      for (const f of features) {
        const id = JSON.stringify([pack.id, f.id]);
        handle.feature({ packId: pack.id, featureId: f.id }, id);
        if (f.type === 'Point') {
          bank.set(index++, {
            position: xyz(f.coordinates),
            color: cyan,
            pickId: id,
            show: true,
          });
        } else if (f.type === 'LineString') {
          const line = engine.lines.createLine({
            id,
            widthPx: 4,
            color: cyan,
            pickId: id,
            arc: 'none',
          });
          handle.own(() => line.destroy());
          line.setPositions(f.coordinates.map(xyz));
        } else {
          addMesh(
            handle,
            polygonShape(f.coordinates),
            { color: [0, 1, 1, 0.35], pickId: id },
            id,
          );
        }
      }
      if (bank) {
        bank.setCount(index);
        bank.commit();
      }
      engine.render.request('scene-pack');
    },
    image(pack, image, handle) {
      addMesh(
        handle,
        rectangleShape(pack.placement.bounds, pack.placement.height),
        { image, pickId: { packId: pack.id } },
        pack.id,
      );
    },
    media(pack, anchor, handle) {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 256;
      const ctx = canvas.getContext('2d');
      ctx.font = '14px sans-serif';
      canvas.width = canvas.height = Math.max(
        256,
        Math.ceil(ctx.measureText(pack.id).width + 12),
      );
      const center = canvas.width / 2;
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'white';
      ctx.fillText(pack.id, center, center - 24);
      ctx.fillStyle = '#ff0';
      ctx.beginPath();
      ctx.arc(center, center, 8, 0, Math.PI * 2);
      ctx.fill();
      const set = engine.movers.createSet({
        id: 'scene-media-' + pack.id,
        kind: 'sprite',
        capacity: 1,
        // The whole square would take clicks meant for the pack's features
        // around the anchor; no action targets the media marker.
        pickable: false,
        depthTest: 'normal',
        sprite: {
          sizePx: canvas.width,
          atlas: { canvas, cells: { icon: [0, 0, 1, 1] } },
        },
      });
      handle.own(() => set.destroy());
      set.set(0, {
        position: xyz([anchor.lon, anchor.lat, anchor.alt]),
        cell: 'icon',
        color: [1, 1, 1, 1],
        show: true,
      });
      set.setCount(1);
      set.commit();
    },
  };
}
