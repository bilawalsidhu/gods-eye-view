import * as geo from '../../../geo/index.js';
import { screenProjectedRotation } from '../../../data/iconOrientation.js';
import { bindGroundShapePicks } from '../../shared/render/navaraGroundPicks.js';

export function createStreetMap(engine, { view }) {
  const { camera } = engine;
  function billboards(id) {
    const rows = new Set(),
      sets = new Map();
    let visible = true,
      dirty = true,
      lastCamera = '',
      settled = false;
    const wake = () => {
      dirty = true;
      engine.render.request(id);
    };
    function paint() {
      const pose = camera.pose();
      const signature = [
        pose.position.x,
        pose.position.y,
        pose.position.z,
        pose.heading,
        pose.pitch,
        pose.roll,
      ].join('/');
      const loaded = engine.surface.tilesLoaded();
      if (!dirty && signature === lastCamera && loaded === settled) return;
      settled = loaded;
      dirty = false;
      lastCamera = signature;
      const scenes = { camera: { rightWC: pose.right, upWC: pose.up } };
      const groups = new Map();
      if (visible)
        for (const row of rows) {
          const key = row.imageId ?? row.image;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(row);
        }
      for (const [key, record] of sets)
        if (!groups.has(key)) {
          record.bank.destroy();
          sets.delete(key);
        }
      for (const [key, group] of groups) {
        const first = group[0],
          scale = first.scaleByDistance;
        let rec = sets.get(key);
        if (!rec || rec.capacity < group.length) {
          rec?.bank.destroy();
          const capacity = Math.max(1, group.length);
          const bank = engine.movers.createSet({
            id: id + '-' + key,
            kind: 'sprite',
            capacity,
            depthTest: 'always',
            pickable: true,
            sprite: {
              sizePx: first.width,
              atlas: { url: first.image, cells: { glyph: [0, 0, 1, 1] } },
              scaleByDistance: scale
                ? [scale.near, scale.nearValue, scale.far, scale.farValue]
                : null,
            },
          });
          rec = { capacity, bank };
          sets.set(key, rec);
        }
        let i = 0;
        for (const row of group) {
          const pos = row.position,
            carto = geo.cartographic.fromCartesian(pos);
          const h = engine.surface.terrainHeight(carto) ?? carto.height;
          const ground = geo.cartesian3.fromRadians(
            carto.longitude,
            carto.latitude,
            h,
          );
          rec.bank.set(i++, {
            position: ground,
            rotation: screenProjectedRotation(
              scenes,
              ground,
              -geo.math.toDegrees(row.rotation || 0),
              0,
            ),
            color: [1, 1, 1, 1],
            cell: 'glyph',
            pickId: row.id,
            show: row.show !== false && engine.projector.horizonVisible(ground),
          });
        }
        rec.bank.setCount(i);
        rec.bank.commit();
      }
    }
    const off = engine.frames.preRender.addEventListener(paint);
    return {
      add(spec) {
        const row = { ...spec };
        rows.add(row);
        wake();
        return row;
      },
      remove(row) {
        rows.delete(row);
        wake();
      },
      removeAll() {
        rows.clear();
        wake();
      },
      set show(value) {
        visible = value;
        wake();
      },
      get show() {
        return visible;
      },
      changed: wake,
      destroy() {
        off();
        for (const rec of sets.values()) rec.bank.destroy();
        sets.clear();
        rows.clear();
      },
    };
  }
  function lines(sequences, color, width, prefix) {
    const features = [],
      shapes = [];
    for (const seq of sequences)
      for (const path of seq.parts) {
        if (path.length < 2) continue;
        const id = prefix + seq.id;
        features.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: path },
          properties: { id },
        });
        shapes.push({
          id,
          geometry: { type: 'line', positions: path },
          style: { lineWidth: width },
        });
      }
    if (!features.length) return null;
    const source = view.addSource({
      type: 'geojson',
      data: { type: 'FeatureCollection', features },
    });
    let layer, unbind;
    try {
      layer = view.addLayer({
        type: 'vector',
        source,
        polyline: {
          color: parseInt(color.slice(1), 16),
          width,
          opacity: 0.92,
          clampToGround: true,
          lit: false,
          transparent: true,
        },
      });
      unbind = bindGroundShapePicks(engine, 'street-level', shapes);
    } catch (e) {
      layer?.delete();
      source.delete();
      throw e;
    }
    return {
      destroy() {
        unbind();
        layer.delete();
        source.delete();
        engine.render.request('street-level-line');
      },
    };
  }
  return { engine, camera, billboards, lines };
}
