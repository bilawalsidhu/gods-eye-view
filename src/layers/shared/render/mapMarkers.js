import * as geo from '../../../geo/index.js';
import { createSurfacePoints } from '../../../globe/surfacePlacement.js';
import { decodeImages, packImageAtlas } from './imageAtlas.js';

async function drawMarkerAtlas(images) {
  const decoded = await Promise.all(
    images.map(async (image) =>
      typeof image === 'string' ? (await decodeImages([image]))[0] : image,
    ),
  );
  return packImageAtlas(
    decoded.map((image, index) => ({
      key: String(index),
      image,
      width: image.naturalWidth || image.width,
      height: image.naturalHeight || image.height,
    })),
    {
      cell:
        Math.max(
          ...decoded.map((image) =>
            Math.max(
              image.naturalWidth || image.width,
              image.naturalHeight || image.height,
            ),
          ),
        ) + 4,
    },
  );
}

/** Snapshot markers on the surface, with one atlas for their images. */
export function createMapMarkers(
  engine,
  { id, order = 0, drawAtlas = drawMarkerAtlas },
) {
  let groups = [];
  let visible = false;
  let generation = 0;
  let destroyed = false;
  const request = () => engine.render.request(id);
  const surface = createSurfacePoints(engine, {
    groups: () =>
      groups.map((group) => ({
        points: group.rows,
        exclude: groups.map((item) => item.set),
        set: {
          set(index, fields) {
            // Overlay anchors share the original position object.
            geo.cartesian3.clone(fields.position, group.anchors[index]);
            fields.position = group.anchors[index];
            Object.assign(group.rows[index], fields);
            group.set.set(index, fields);
          },
          commit: () => group.set.commit(),
        },
      })),
    request,
    estimateGround: true,
  });
  function release() {
    for (const group of groups) group.set.destroy();
    groups = [];
  }
  function refresh() {
    if (destroyed) return;
    for (const group of groups) {
      let changed = false;
      group.rows.forEach((row, index) => {
        const look = row.billboard || row.point;
        const size =
          typeof look.pixelSize === 'function'
            ? look.pixelSize()
            : (look.pixelSize ?? look.width);
        const show =
          visible &&
          row.show !== false &&
          engine.projector.horizonVisible(row.position);
        if (row.drawnShow === show && row.drawnSize === size) return;
        row.drawnShow = show;
        row.drawnSize = size;
        group.set.set(index, { show, scale: size });
        changed = true;
      });
      if (changed) group.set.commit();
    }
  }
  function install(nextRows, atlas, images, epoch) {
    if (destroyed || epoch !== generation) return;
    const buckets = new Map();
    for (const row of nextRows) {
      const key = row.billboard
        ? 'sprite'
        : `point:${row.point.outlineWidth || 0}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(row);
    }
    for (const [key, items] of buckets) {
      const sprite = key === 'sprite';
      const set = engine.movers.createSet({
        id: `${id}-${key}`,
        kind: sprite ? 'sprite' : 'point',
        capacity: items.length,
        order: order + (sprite ? 0.1 : 0),
        depthTest: 'always',
        pickable: true,
        ...(sprite
          ? { sprite: { atlas, sizePx: 1 } }
          : {
              point: { sizePx: 1, outlinePx: items[0].point.outlineWidth || 0 },
            }),
      });
      items.forEach((row, index) => {
        row.cartographic = geo.cartographic.fromCartesian(row.position);
        row.drawnShow = row.drawnSize = undefined;
        const look = row.billboard || row.point;
        set.set(index, {
          position: row.position,
          color: look.color?.rgba() || [1, 1, 1, 1],
          pickId: row.id,
          ...(sprite
            ? { cell: String(images.indexOf(look.image)) }
            : { outlineColor: look.outlineColor?.rgba() || [0, 0, 0, 1] }),
        });
      });
      set.setCount(items.length);
      groups.push({
        set,
        rows: items,
        anchors: items.map((row) => row.position),
      });
    }
    refresh();
    for (const group of groups) group.set.commit();
    surface.place({ all: true });
    request();
  }
  const removeFrame = engine.frames.preRender.addEventListener(refresh);
  return {
    replace(nextRows) {
      const epoch = ++generation;
      release();
      const points = nextRows.filter((row) => row.point);
      install(points, null, [], epoch);
      const sprites = nextRows.filter((row) => row.billboard);
      if (!sprites.length) return Promise.resolve();
      const images = [...new Set(sprites.map((row) => row.billboard.image))];
      return Promise.resolve(drawAtlas(images)).then((atlas) =>
        install(sprites, atlas, images, epoch),
      );
    },
    show(next) {
      visible = next !== false;
      refresh();
    },
    refresh,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      generation++;
      removeFrame();
      surface.destroy();
      release();
    },
  };
}
