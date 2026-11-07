// A prototype of engine.ground on Navara's own vector layers, kept to
// measure against the screen pass (pass.js) and not used by the engine:
// each set's items grouped by style into one GeoJSON source and one
// clamped vector layer per group (discs and cells as polygons, pixel
// corridors as polylines; metre corridors are not drawn). `hide` picks how a
// hidden set goes: 'delete' (its layers deleted, rebuilt when shown) or
// 'update' (layer.update with show false).

import { areaRings, createGroundRegistry } from '../../ground.js';

const toHex = (rgba) =>
  (Math.round(rgba[0] * 255) << 16) |
  (Math.round(rgba[1] * 255) << 8) |
  Math.round(rgba[2] * 255);

function ringCoordinates(flat) {
  const ring = [];
  for (let index = 0; index < flat.length; index += 2)
    ring.push([flat[index], flat[index + 1]]);
  ring.push(ring[0]);
  return ring;
}

// Features grouped by their layer style: Map<key, { style, features }>.
export function vectorGroups(kind, items) {
  const groups = new Map();
  const add = (key, style, feature) => {
    if (!groups.has(key)) groups.set(key, { style, features: [] });
    groups.get(key).features.push(feature);
  };
  items.forEach((item, index) => {
    if (kind === 'corridor') {
      if (!item.widthPx) return;
      const coordinates = [];
      for (let at = 0; at < item.path.length; at += 2)
        coordinates.push([item.path[at], item.path[at + 1]]);
      add(
        `line:${item.fill.join()}:${item.widthPx}`,
        {
          polyline: {
            color: toHex(item.fill),
            width: item.widthPx,
            opacity: item.fill[3],
            transparent: item.fill[3] < 1,
            clampToGround: true,
          },
        },
        {
          type: 'Feature',
          id: index,
          properties: {},
          geometry: { type: 'LineString', coordinates },
        },
      );
      return;
    }
    const rings = areaRings(kind, item).map(ringCoordinates);
    const fill = item.fill ?? [0, 0, 0, 0];
    const outline = item.outline;
    add(
      `area:${fill.join()}:${outline ? `${outline.color.join()}:${outline.widthPx}` : ''}`,
      {
        polygon: {
          color: toHex(fill),
          opacity: fill[3],
          transparent: true,
          clampToGround: true,
          ...(outline
            ? {
                outline: true,
                outlineShow: true,
                outlineColor: toHex(outline.color),
                outlineWidth: outline.widthPx,
              }
            : {}),
        },
      },
      {
        type: 'Feature',
        id: index,
        properties: {},
        geometry: { type: 'Polygon', coordinates: rings },
      },
    );
  });
  return groups;
}

/**
 * @param {object} view an initialised Navara ThreeView
 * @param {{ hide?: 'delete'|'update' }} [options]
 */
export function createNavaraVectorGround(view, { hide = 'delete' } = {}) {
  const registry = createGroundRegistry((options) => {
    let groups = new Map();
    let batches = [];
    let shown = true;
    const release = () => {
      for (const { layer, source } of batches) {
        layer.delete();
        source.delete();
      }
      batches = [];
    };
    const build = () => {
      release();
      for (const { style, features } of groups.values()) {
        const source = view.addSource({
          type: 'geojson',
          data: { type: 'FeatureCollection', features },
        });
        const config = { type: 'vector', source, ...style };
        batches.push({ source, config, layer: view.addLayer(config) });
      }
    };
    return {
      commit(items) {
        groups = vectorGroups(options.kind, items);
        if (shown || hide === 'update') build();
        if (!shown && hide === 'update')
          for (const batch of batches)
            batch.layer.update({ ...batch.config, show: false });
        view.forceUpdate();
      },
      show(visible) {
        if (visible === shown) return;
        shown = visible;
        if (hide === 'delete') {
          if (visible) build();
          else release();
        } else
          for (const batch of batches)
            batch.layer.update({ ...batch.config, show: visible });
        view.forceUpdate();
      },
      destroy() {
        release();
        view.forceUpdate();
      },
    };
  });
  return {
    ground: registry.ground,
    pickables: () => [...registry.live.values()],
    destroy: () => registry.destroyAll(),
  };
}
