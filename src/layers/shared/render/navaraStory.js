import * as geo from '../../../geo/index.js';

const val = (p) => (p?.getValue ? p.getValue() : p);
const rgba = (c) => [c.red, c.green, c.blue, c.alpha];
const tint = (c) =>
  (Math.round(c.red * 255) << 16) |
  (Math.round(c.green * 255) << 8) |
  Math.round(c.blue * 255);
function samePath(old, points) {
  return (
    old?.length === points.length &&
    points.every(
      (p, i) => p.x === old[i].x && p.y === old[i].y && p.z === old[i].z,
    )
  );
}
function circleAtlas() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.beginPath();
  ctx.arc(32, 32, 29, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'white';
  ctx.beginPath();
  ctx.arc(96, 32, 27, 0, Math.PI * 2);
  ctx.stroke();
  return { canvas, cells: { fill: [0, 0, 0.5, 1], rim: [0.5, 0, 1, 1] } };
}

// The authored story owns the clock and geographic graphics. This adapter only samples them
// while its scene is attached. Neither a Cesium viewer nor an additional globe is needed.
export function drawStorySource(engine, { view, NavaraColor }, data) {
  const entries = new Map();
  let atlas;
  // Story graphics encode map colors. Compensate the planet's photographic
  // exposure before its tone-mapping pass so a cyan overlay stays readable.
  function displayColor(hex) {
    const c = new NavaraColor().setHex(hex);
    const exposure = Math.max(1, view.toneMappingExposure ?? 1);
    const [r, g, b] = c.toArray();
    return c.setRGBLinear(r / exposure, g / exposure, b / exposure);
  }
  function point(entity) {
    const p = entity.point,
      nearFar = val(p.scaleByDistance),
      depth = val(p.disableDepthTestDistance);
    const set = engine.movers.createSet({
      id: data.name + '-' + entity.id,
      kind: 'sprite',
      capacity: 2,
      pickable: false,
      depthTest: depth === Infinity ? 'always' : 'normal',
      sprite: {
        sizePx: 64,
        atlas: (atlas ??= circleAtlas()),
        scaleByDistance: nearFar
          ? [nearFar.near, nearFar.nearValue, nearFar.far, nearFar.farValue]
          : null,
      },
    });
    return {
      paint(show) {
        const position = val(entity.position);
        if (!show || !position) {
          set.setCount(0);
          set.commit();
          return;
        }
        let at = position;
        if (val(p.heightReference) === 1) {
          const carto = geo.cartographic.fromCartesian(position);
          const h = engine.surface.terrainHeight(carto);
          if (Number.isFinite(h))
            at = geo.cartesian3.fromRadians(carto.longitude, carto.latitude, h);
        }
        const scale = Number(val(p.pixelSize)) / 58;
        const color = val(p.color),
          outline = val(p.outlineColor);
        set.set(0, {
          position: at,
          show: true,
          cell: 'fill',
          color: rgba(color),
          scale,
        });
        const hasOutline = Boolean(outline && val(p.outlineWidth));
        if (hasOutline)
          set.set(1, {
            position: at,
            show: true,
            cell: 'rim',
            color: rgba(outline),
            scale,
          });
        set.setCount(hasOutline ? 2 : 1);
        set.commit();
      },
      destroy: () => set.destroy(),
    };
  }
  function geometry(entity) {
    const key = entity.polyline ? 'polyline' : 'polygon',
      g = entity[key];
    let handle,
      previous = null,
      visible = null;
    return {
      paint(show) {
        const path =
          key === 'polygon' ? val(g.hierarchy)?.positions : val(g.positions);
        show = Boolean(show && path?.length >= (key === 'polygon' ? 3 : 2));
        if (!show) {
          if (handle && visible) handle.update({ visible: false });
          visible = false;
          return;
        }
        if (!handle || !samePath(previous, path)) {
          const color = val(g.material)?.color ?? val(g.material?.color);
          previous = path.map(({ x, y, z }) => ({ x, y, z }));
          const geom = {
            points: previous,
            clampToGround: true,
            color: displayColor(color ? tint(color) : 0x20e7f2),
            opacity: color?.alpha ?? 1,
            transparent: true,
            ...(key === 'polyline' ? { width: val(g.width) ?? 2 } : {}),
          };
          if (handle) handle.update({ [key]: geom, visible: true });
          else
            handle = view.addMesh({
              [key]: geom,
              visible: true,
              lit: false,
              pickable: false,
            });
        } else if (!visible) handle.update({ visible: true });
        visible = true;
      },
      destroy: () => handle?.delete(),
    };
  }
  function frame() {
    const live = new Set(data.entities.values);
    for (const [e, item] of entries)
      if (!live.has(e)) {
        item.destroy();
        entries.delete(e);
      }
    for (const e of live) {
      let item = entries.get(e);
      if (!item) {
        if (!e.point && !e.polyline && !e.polygon) continue;
        item = e.point ? point(e) : geometry(e);
        entries.set(e, item);
      }
      item.paint(data.show !== false && val(e.show) !== false);
    }
  }
  const off = engine.frames.preRender.addEventListener(frame);
  engine.render.request(data.name);
  return {
    destroy() {
      off();
      for (const item of entries.values()) item.destroy();
      entries.clear();
      engine.render.request(data.name);
    },
  };
}
