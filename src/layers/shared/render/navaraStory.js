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

// Graphics an imported file (UTILITIES ▸ Import) may carry that Navara does
// not draw; each one present is counted and reported.
const UNDRAWN_GRAPHICS = Object.freeze([
  'label',
  'model',
  'rectangle',
  'wall',
  'ellipse',
  'ellipsoid',
  'corridor',
  'box',
  'cylinder',
  'path',
  'plane',
  'polylineVolume',
  'tileset',
]);
const DEGREES = 180 / Math.PI;
// Unique mover set ids for imported files.
let importSets = 0;
const css = (c) =>
  '#' +
  [c.red, c.green, c.blue]
    .map((v) =>
      Math.round(Math.max(0, Math.min(1, v)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');
const lonLat = (position) => {
  const c = position && geo.cartographic.fromCartesian(position);
  return c && Number.isFinite(c.longitude) && Number.isFinite(c.latitude)
    ? [c.longitude * DEGREES, c.latitude * DEGREES]
    : null;
};
const ringOf = (positions) => {
  const ring = (positions ?? []).map(lonLat).filter(Boolean);
  if (ring.length >= 3) {
    const [first] = ring;
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);
  }
  return ring;
};
const colorOf = (material, fallback) => {
  const value = val(material);
  return value?.color ?? val(material?.color) ?? fallback;
};

/**
 * The plan for an imported data source on Navara, as plain data: GeoJSON
 * features grouped by paint (`fills` and `lines`: Map of style key →
 * { color: '#rrggbb', opacity, width?, features }), point sprites (`points`)
 * and billboards grouped by image (`images`: Map of image key →
 * { image, sizePx, items }), and what is left out (`undrawn`: graphic kind →
 * count; `drawn`: entities with something drawn).
 */
export function planImportedSource(dataSource, { sizes = new Map() } = {}) {
  const fills = new Map();
  const lines = new Map();
  const points = [];
  const images = new Map();
  const undrawn = {};
  let drawn = 0;
  const group = (map, key, entry) => {
    let target = map.get(key);
    if (!target) map.set(key, (target = { ...entry, features: [] }));
    return target;
  };
  for (const entity of dataSource.entities.values) {
    if (val(entity.show) === false) continue;
    let any = false;
    const polygon = entity.polygon;
    if (polygon && val(polygon.fill) !== false) {
      const hierarchy = val(polygon.hierarchy);
      const outer = ringOf(hierarchy?.positions);
      if (outer.length >= 4) {
        const holes = (hierarchy.holes ?? [])
          .map((hole) => ringOf(hole?.positions))
          .filter((ring) => ring.length >= 4);
        const color = colorOf(polygon.material, null);
        const fill = color ? css(color) : '#ffffff';
        const opacity = color?.alpha ?? 1;
        group(fills, `${fill}|${opacity.toFixed(3)}`, {
          color: fill,
          opacity,
        }).features.push({
          type: 'Feature',
          properties: {},
          geometry: { type: 'Polygon', coordinates: [outer, ...holes] },
        });
        any = true;
      }
    }
    const polyline = entity.polyline;
    if (polyline) {
      const path = (val(polyline.positions) ?? []).map(lonLat).filter(Boolean);
      if (path.length >= 2) {
        const color = colorOf(polyline.material, null);
        const stroke = color ? css(color) : '#ffffff';
        const opacity = color?.alpha ?? 1;
        const width = Number(val(polyline.width)) || 1;
        group(lines, `${stroke}|${opacity.toFixed(3)}|${width}`, {
          color: stroke,
          opacity,
          width,
        }).features.push({
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: path },
        });
        any = true;
      }
    }
    const position = val(entity.position);
    if (position && entity.billboard && val(entity.billboard.image)) {
      const raw = val(entity.billboard.image);
      // A URL (a Cesium Resource's too), else a canvas; one sprite set per
      // image (Cesium's pin builder hands every marker of a colour the same
      // canvas).
      const image =
        typeof raw === 'string'
          ? raw
          : typeof raw?.url === 'string'
            ? raw.url
            : typeof raw?.getContext === 'function'
              ? raw
              : typeof raw?.src === 'string'
                ? raw.src
                : null;
      if (!image) {
        undrawn.billboard = (undrawn.billboard ?? 0) + 1;
        continue;
      }
      const natural = sizes.get(image);
      const width =
        Number(val(entity.billboard.width)) ||
        Number(image.width) ||
        natural?.width ||
        32;
      const height =
        Number(val(entity.billboard.height)) ||
        Number(image.height) ||
        natural?.height ||
        width;
      const entry = group(images, image, {
        image,
        sizePx: Math.max(width, height),
      });
      const tint = val(entity.billboard.color);
      entry.features.push({
        entity,
        position,
        scale: Number(val(entity.billboard.scale)) || 1,
        color: tint ? rgba(tint) : [1, 1, 1, 1],
      });
      any = true;
    } else if (position && entity.point) {
      const p = entity.point;
      const color = val(p.color);
      const outline = val(p.outlineColor);
      points.push({
        entity,
        position,
        sizePx: Number(val(p.pixelSize)) || 1,
        color: color ? rgba(color) : [1, 1, 1, 1],
        outline: outline && Number(val(p.outlineWidth)) ? rgba(outline) : null,
      });
      any = true;
    }
    for (const kind of UNDRAWN_GRAPHICS) {
      const graphic = entity[kind];
      if (!graphic || val(graphic.show) === false) continue;
      if (kind === 'label' && !val(graphic.text)) continue;
      undrawn[kind] = (undrawn[kind] ?? 0) + 1;
    }
    if (any) drawn++;
  }
  return { fills, lines, points, images, undrawn, drawn };
}

/**
 * Draw an imported file's data source (UTILITIES ▸ Import) on Navara: its
 * polygons and lines as clamped GeoJSON vector layers (one per paint), its
 * points as circle sprites and its billboards as sprites of their own image.
 * Labels, models and the other graphics Navara has no drawing for are left
 * out and counted in `report`. `setShow` follows the row's visibility;
 * `refresh` re-reads the pins' positions after a ground refresh.
 */
export function drawImportedSource(
  engine,
  { view },
  dataSource,
  { sizes } = {},
) {
  const plan = planImportedSource(dataSource, { sizes });
  const layers = [];
  const sets = [];
  let shown = dataSource.show !== false;
  const layerStyle = (kind, entry) =>
    kind === 'polygon'
      ? {
          polygon: {
            color: Number.parseInt(entry.color.slice(1), 16),
            show: shown,
            clampToGround: true,
            transparent: true,
            opacity: entry.opacity,
          },
        }
      : {
          polyline: {
            color: Number.parseInt(entry.color.slice(1), 16),
            show: shown,
            clampToGround: true,
            width: entry.width,
            transparent: true,
            opacity: entry.opacity,
          },
        };
  const id = (kind) => `geo-import-${kind}-${++importSets}`;
  try {
    for (const [kind, groups] of [
      ['polygon', plan.fills],
      ['polyline', plan.lines],
    ])
      for (const entry of groups.values()) {
        const source = view.addSource({
          type: 'geojson',
          data: { type: 'FeatureCollection', features: entry.features },
        });
        const record = { kind, entry, source, layer: null };
        layers.push(record);
        record.layer = view.addLayer({
          type: 'vector',
          source,
          ...layerStyle(kind, entry),
        });
      }
    if (plan.points.length) {
      const set = engine.movers.createSet({
        id: id('points'),
        kind: 'sprite',
        capacity: plan.points.length * 2,
        pickable: false,
        depthTest: 'always',
        sprite: { sizePx: 64, atlas: circleAtlas() },
      });
      const write = () => {
        let at = 0;
        for (const item of plan.points) {
          const scale = item.sizePx / 58;
          set.set(at++, {
            position: item.position,
            cell: 'fill',
            color: item.color,
            scale,
            show: true,
          });
          if (item.outline)
            set.set(at++, {
              position: item.position,
              cell: 'rim',
              color: item.outline,
              scale,
              show: true,
            });
        }
        return at;
      };
      sets.push({ set, count: write(), write });
    }
    for (const entry of plan.images.values()) {
      const { image } = entry;
      const set = engine.movers.createSet({
        id: id('pins'),
        kind: 'sprite',
        capacity: entry.features.length,
        pickable: false,
        depthTest: 'always',
        sprite: {
          sizePx: entry.sizePx,
          atlas: {
            ...(typeof image === 'string' ? { url: image } : { canvas: image }),
            cells: { image: [0, 0, 1, 1] },
          },
        },
      });
      const write = () => {
        entry.features.forEach((item, index) =>
          set.set(index, {
            position: item.position,
            cell: 'image',
            color: item.color,
            scale: item.scale,
            show: true,
          }),
        );
        return entry.features.length;
      };
      sets.push({ set, count: write(), write });
    }
    for (const record of sets) {
      record.set.setCount(shown ? record.count : 0);
      record.set.commit();
    }
  } catch (error) {
    release();
    throw error;
  }
  engine.render.request('geo-import');
  function release() {
    for (const { layer, source } of layers.splice(0)) {
      try {
        layer?.delete();
        source.delete();
      } catch {
        /* the view went first */
      }
    }
    for (const { set } of sets.splice(0)) set.destroy();
  }
  const undrawn = Object.values(plan.undrawn).reduce((n, c) => n + c, 0);
  return {
    report: { drawn: plan.drawn, undrawn, kinds: { ...plan.undrawn } },
    setShow(show) {
      if (show === shown) return;
      shown = show;
      for (const { kind, entry, source, layer } of layers)
        layer.update({ type: 'vector', source, ...layerStyle(kind, entry) });
      for (const record of sets) {
        record.set.setCount(shown ? record.count : 0);
        record.set.commit();
      }
      engine.render.request('geo-import');
    },
    /** The pins' positions moved onto refreshed ground heights. */
    refresh() {
      const items = [
        ...plan.points,
        ...[...plan.images.values()].flatMap((entry) => entry.features),
      ];
      for (const item of items)
        item.position = val(item.entity.position) ?? item.position;
      for (const record of sets) {
        record.count = record.write();
        record.set.setCount(shown ? record.count : 0);
        record.set.commit();
      }
      engine.render.request('geo-import');
    },
    destroy() {
      release();
      engine.render.request('geo-import');
    },
  };
}

/**
 * The natural sizes of an imported file's pin images (the file's own, as
 * data: or blob: URLs), so each pin draws at the size Cesium gives it.
 * Remote URLs are never loaded. Resolves with a Map of URL → { width, height }.
 */
export async function measureImportImages(
  dataSource,
  { timeoutMs = 2000, createImage = () => new Image() } = {},
) {
  const urls = new Set();
  for (const entity of dataSource.entities.values) {
    const image = val(entity.billboard?.image);
    const url = typeof image === 'string' ? image : image?.url;
    if (typeof url === 'string' && /^(data|blob):/.test(url)) urls.add(url);
  }
  const sizes = new Map();
  await Promise.all(
    [...urls].map(async (url) => {
      const image = createImage();
      image.src = url;
      let timer;
      try {
        await Promise.race([
          image.decode(),
          new Promise((_, reject) => {
            timer = setTimeout(reject, timeoutMs);
          }),
        ]);
        if (image.naturalWidth > 0)
          sizes.set(url, {
            width: image.naturalWidth,
            height: image.naturalHeight,
          });
      } catch {
        /* drawn at the default size */
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return sizes;
}
