// Samples the authored story graphics into ground sets and point movers.
// The story owns reveal time; this display owns only its attached drawing.
import { createSurfacePoints } from '../../../globe/surfacePlacement.js';
import * as geo from '../../../geo/index.js';

const value = (property) =>
  property?.getValue ? property.getValue() : property;
const rgba = (color) => [color.red, color.green, color.blue, color.alpha];
const lonLat = (position) => {
  const place = geo.cartographic.fromCartesian(position);
  return [
    geo.math.toDegrees(place.longitude),
    geo.math.toDegrees(place.latitude),
  ];
};
const drape = (graphics) => {
  const classification = value(graphics.classificationType);
  return classification === 0
    ? 'terrain'
    : classification === 1
      ? 'tiles'
      : 'both';
};

export function drawStorySource(engine, data) {
  const entries = new Map();
  let order = 0;
  let destroyed = false;
  const groups = new Set();
  const surface = createSurfacePoints(engine, {
    groups: () => groups,
    prefer: 'scene',
    estimateGround: true,
    request: () => engine.render.request(data.name),
  });

  function point(entity) {
    const graphics = entity.point;
    const distance = value(graphics.scaleByDistance);
    const depth = value(graphics.disableDepthTestDistance);
    const set = engine.movers.createSet({
      id: `${data.name}-${entity.id}`,
      kind: 'point',
      capacity: 1,
      pickable: true,
      depthTest:
        depth === Infinity
          ? 'always'
          : depth > 0
            ? { disableWithinM: depth }
            : 'normal',
      point: {
        sizePx: 1,
        outlinePx: value(graphics.outlineWidth) ?? 0,
        scaleByDistance: distance
          ? [distance.near, distance.nearValue, distance.far, distance.farValue]
          : null,
      },
    });
    const row = { show: false };
    const group = { set, points: [row] };
    groups.add(group);
    let authored;
    let previous;
    return {
      paint(show) {
        let position = value(entity.position);
        show = Boolean(show && value(graphics.show) !== false && position);
        const clamped = show && value(graphics.heightReference) === 1;
        if (clamped && !row.show) delete row.surfaceRevision;
        row.show = clamped;
        if (row.show) {
          if (!authored || !geo.cartesian3.equals(position, authored)) {
            authored = geo.cartesian3.clone(position);
            row.cartographic = geo.cartographic.fromCartesian(position);
            row.position = position;
            delete row.surfaceRevision;
            delete row.surfaceHeight;
          }
          position = row.position;
        }
        const fields = show
          ? {
              position,
              pickId: entity,
              color: rgba(value(graphics.color)),
              outlineColor: rgba(
                value(graphics.outlineColor) ?? {
                  red: 0,
                  green: 0,
                  blue: 0,
                  alpha: 1,
                },
              ),
              scale: value(graphics.pixelSize) ?? 1,
              show: true,
            }
          : { show: false };
        const snapshot = JSON.stringify(fields, (key, item) =>
          key === 'pickId' ? undefined : item,
        );
        if (snapshot === previous) return;
        if (show) set.set(0, fields);
        set.setCount(show ? 1 : 0);
        set.commit();
        previous = snapshot;
      },
      destroy() {
        groups.delete(group);
        set.destroy();
      },
    };
  }

  function geometry(entity) {
    const polygon = Boolean(entity.polygon);
    const graphics = polygon ? entity.polygon : entity.polyline;
    const set = engine.ground.createSet({
      id: `${data.name}-${entity.id}`,
      kind: polygon ? 'polygon' : 'corridor',
      order: order++,
      drape: drape(graphics),
      pickable: true,
      dynamic: !polygon && graphics.positions?.isConstant === false,
    });
    let previous;
    let visible = true;
    return {
      paint(show) {
        const hierarchy = polygon ? value(graphics.hierarchy) : null;
        const path = polygon ? hierarchy?.positions : value(graphics.positions);
        show = Boolean(
          show &&
          value(graphics.show) !== false &&
          path?.length >= (polygon ? 3 : 2),
        );
        if (visible !== show) set.show((visible = show));
        if (!show) return;
        const material = value(graphics.material);
        const color = rgba(material?.color ?? material);
        let item;
        if (polygon)
          item = {
            rings: [
              path.map(lonLat),
              ...(hierarchy.holes ?? []).map((hole) =>
                hole.positions.map(lonLat),
              ),
            ],
            fill: color,
          };
        else
          item = {
            positions: path.map(lonLat),
            color,
            widthPx: value(graphics.width) ?? 1,
            ...(material.glowPower !== undefined
              ? {
                  glow: {
                    power: material.glowPower,
                    taper: material.taperPower,
                  },
                }
              : {}),
            ...(material.dashLength !== undefined
              ? {
                  dashPattern: {
                    lengthPx: material.dashLength,
                    pattern: material.dashPattern,
                  },
                }
              : {}),
          };
        item.pickId = entity;
        const snapshot = JSON.stringify(item, (key, value) =>
          key === 'pickId' ? undefined : value,
        );
        if (snapshot === previous) return;
        set.replace([item]);
        set.commit();
        previous = snapshot;
      },
      destroy: () => set.destroy(),
    };
  }

  function frame() {
    if (destroyed) return;
    const live = new Set(data.entities.values);
    for (const [entity, item] of entries) {
      if (live.has(entity)) continue;
      item.destroy();
      entries.delete(entity);
    }
    for (const entity of live) {
      let item = entries.get(entity);
      if (!item) {
        if (!entity.point && !entity.polyline && !entity.polygon) continue;
        item = entity.point ? point(entity) : geometry(entity);
        entries.set(entity, item);
      }
      item.paint(data.show !== false && value(entity.show) !== false);
    }
    surface.place();
  }
  const off = engine.frames.preRender.addEventListener(frame);
  engine.render.request(data.name);
  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      off();
      surface.destroy();
      for (const item of entries.values()) item.destroy();
      entries.clear();
      engine.render.request(data.name);
    },
  };
}
