import * as geo from '../../../geo/index.js';
import { Rgba } from '../../shared/color.js';
import { createMoverBank } from '../../aircraft/render/navara.js';
import { SPRITE_LAYER_ORDER } from '../../../data/spriteOrder.js';
import { TRANSIT_ICON_KINDS, transitIcon } from '../../../data/transitIcons.js';

/** The same bounded mode/selection/style rasters used by native billboards. */
export async function drawTransitAtlas() {
  const urls = [
    ...new Set(
      TRANSIT_ICON_KINDS.flatMap((mode) =>
        ['normal', 'thermal', 'retro'].flatMap((style) =>
          [48, 96].map((px) => transitIcon(mode, px, { style })),
        ),
      ),
    ),
  ];
  const images = await Promise.all(
    urls.map(async (url) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      return image;
    }),
  );
  const cell = Math.max(...images.map((image) => image.naturalWidth)) + 4;
  const columns = Math.ceil(Math.sqrt(images.length));
  const canvas = document.createElement('canvas');
  canvas.width = columns * cell;
  canvas.height = Math.ceil(images.length / columns) * cell;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Transit atlas requires a canvas');
  const cells = {};
  images.forEach((image, i) => {
    const x = (i % columns) * cell + 2,
      y = Math.floor(i / columns) * cell + 2;
    context.drawImage(image, x, y);
    cells[urls[i]] = [
      x / canvas.width,
      y / canvas.height,
      (x + image.naturalWidth) / canvas.width,
      (y + image.naturalHeight) / canvas.height,
    ];
  });
  return { canvas, cells };
}

/** Two independently dirty banks: moving contacts never upload the static fleet. */
export function createTransitSpriteBanks(
  engine,
  { drawAtlas = drawTransitAtlas } = {},
) {
  let destroyed = false,
    atlas = null,
    queued = false,
    inFrame = 0;
  const pending = new Set();
  const owners = [];
  const api = {
    flush() {
      queued = false;
      if (destroyed) return;
      for (const bank of pending) bank.commit();
      pending.clear();
    },
    inFrame(run) {
      inFrame++;
      try {
        return run();
      } finally {
        if (--inFrame === 0) api.flush();
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const owner of owners) owner.destroy();
      pending.clear();
      atlas = null;
    },
  };
  const schedule = (bank) => {
    pending.add(bank);
    if (!queued && !inFrame && !destroyed) {
      queued = true;
      queueMicrotask(() => api.flush());
    }
  };
  function collection(id) {
    const handles = new Set();
    let bank = null,
      visible = false;
    const rgba = [1, 1, 1, 1];
    const colorValues = (color) => {
      rgba[0] = color.red;
      rgba[1] = color.green;
      rgba[2] = color.blue;
      rgba[3] = color.alpha;
      return rgba;
    };
    const fields = {
      position: null,
      rotation: undefined,
      scale: undefined,
      color: undefined,
      show: undefined,
      cell: undefined,
    };
    const update = (handle, key, value) => {
      if (!bank || destroyed || !handles.has(handle)) return;
      fields[key] = value;
      bank.update(handle, fields);
      fields[key] = undefined;
    };
    fields.position = undefined;
    const ensure = () => {
      if (bank || !atlas || destroyed) return;
      bank = createMoverBank(engine, {
        options: (capacity, generation) => ({
          id: `${id}-${generation}`,
          kind: 'sprite',
          capacity,
          order: SPRITE_LAYER_ORDER.indexOf(id),
          depthTest: 'always',
          pickable: true,
          sprite: { atlas, sizePx: 20 },
        }),
        write: (h, set, index) =>
          set.set(index, {
            position: h.position,
            rotation: h.rotation,
            scale: h.width / 20,
            color: colorValues(h.color),
            cell: h.image,
            show: h.show,
            pickId: h.id,
          }),
        onCommit: schedule,
      });
      bank.setVisible(visible);
      for (const handle of handles) bank.add(handle);
    };
    const owner = {
      ensure,
      destroy() {
        handles.clear();
        bank?.destroy();
        bank = null;
      },
    };
    owners.push(owner);
    return {
      get show() {
        return visible;
      },
      set show(value) {
        const next = Boolean(value);
        if (destroyed || next === visible) return;
        visible = next;
        bank?.setVisible(next);
      },
      get length() {
        return handles.size;
      },
      get: (index) => bank?.handles[index] ?? [...handles][index],
      contains: (handle) => handles.has(handle),
      add(spec) {
        if (destroyed) throw new Error('Transit sprite banks are destroyed');
        let position = geo.cartesian3.clone(spec.position),
          image = spec.image,
          show = spec.show !== false,
          rotation = spec.rotation ?? 0,
          width = spec.width ?? 20,
          height = spec.height ?? width;
        let color = new Rgba(
          spec.color?.red,
          spec.color?.green,
          spec.color?.blue,
          spec.color?.alpha,
        );
        const handle = {
          id: spec.id,
          gevBank: null,
          gevIndex: -1,
          alignedAxis: geo.cartesian3.ZERO,
          disableDepthTestDistance: Infinity,
          get position() {
            return position;
          },
          set position(value) {
            if (destroyed || geo.cartesian3.equals(position, value)) return;
            geo.cartesian3.clone(value, position);
            update(handle, 'position', position);
          },
          get image() {
            return image;
          },
          set image(value) {
            if (destroyed || image === value) return;
            image = value;
            update(handle, 'cell', image);
          },
          get show() {
            return show;
          },
          set show(value) {
            const next = Boolean(value);
            if (destroyed || show === next) return;
            show = next;
            update(handle, 'show', show);
          },
          get rotation() {
            return rotation;
          },
          set rotation(value) {
            if (destroyed || rotation === value) return;
            rotation = value;
            update(handle, 'rotation', rotation);
          },
          get width() {
            return width;
          },
          set width(value) {
            if (destroyed || width === value) return;
            width = value;
            update(handle, 'scale', width / 20);
          },
          get height() {
            return height;
          },
          set height(value) {
            height = value;
          },
          get color() {
            return color;
          },
          set color(value) {
            if (destroyed || color.equals(value)) return;
            color = new Rgba(value.red, value.green, value.blue, value.alpha);
            update(handle, 'color', colorValues(color));
          },
        };
        handles.add(handle);
        ensure();
        bank?.add(handle);
        return handle;
      },
      remove(handle) {
        if (!handles.delete(handle)) return false;
        bank?.remove(handle);
        return true;
      },
      removeAll() {
        for (const handle of handles) bank?.remove(handle);
        handles.clear();
      },
    };
  }
  api.collections = [collection('transit'), collection('transit-motion')];
  api.ready = Promise.resolve()
    .then(drawAtlas)
    .then((drawn) => {
      if (destroyed) return;
      atlas = drawn;
      for (const owner of owners) owner.ensure();
      api.flush();
    });
  // Keep an early decode failure observed even before a caller awaits ready.
  api.ready.catch(() => {
    if (!destroyed) console.error('Transit sprite atlas failed');
  });
  return api;
}
