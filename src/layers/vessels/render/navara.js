// The vessels layer's renderer on the Navara engine (phase 3 Task 13b),
// with render/cesium.js's interface (./contract.js), built only on the
// engine contract: the chevrons are one engine.movers sprite bank (always on
// top, as Cesium's depth-test-free billboards) whose atlas holds every
// chevron the layer draws (../icons.js, rasterised at 32 px as Cesium's
// billboard texture); the trail is engine.lines; the camera reads go
// through the shared Navara layer view (engine.camera.pose(), the
// projector). No three, no Cesium. Registered for 'navara' by the Navara
// mode after its import() (src/app/navaraMode.js).
//
// Handles keep Cesium's Billboard field vocabulary as setters that write
// the bank; the writes of a frame are committed once, at the end of the
// frame listener that made them (or in a microtask for writes outside a
// frame).

import * as geo from '../../../geo/index.js';
import { createMoverBank } from '../../aircraft/render/navara.js';
import { createNavaraLayerView } from '../../shared/render/navaraView.js';
import { SPRITE_LAYER_ORDER } from '../../../data/spriteOrder.js';
import { allVesselChevronIcons, VESSEL_ICON_PX } from '../icons.js';

const LAYER_ID = 'ais-live-vessels';
const TRAIL_ALPHA = 0.85;
const TRAIL_OCCLUDED_ALPHA = 0.4;
const MIN_SEGMENT_DISTANCE_SQ = 0.01;
const ATLAS_PAD = 2;

/** The chevron atlas layout (pure): one 32 px cell per icon, in a row. */
export function vesselAtlasLayout(icons = allVesselChevronIcons()) {
  const cell = VESSEL_ICON_PX + 2 * ATLAS_PAD;
  const width = icons.length * cell;
  const height = cell;
  const rects = new Map();
  const cells = {};
  icons.forEach((icon, column) => {
    const x = column * cell + ATLAS_PAD;
    const y = ATLAS_PAD;
    rects.set(icon, { x, y, size: VESSEL_ICON_PX });
    cells[icon] = [
      x / width,
      y / height,
      (x + VESSEL_ICON_PX) / width,
      (y + VESSEL_ICON_PX) / height,
    ];
  });
  return { width, height, rects, cells };
}

/** Draws the atlas (browser): a canvas and its cells, once the SVGs decode. */
export async function drawVesselAtlas() {
  const layout = vesselAtlasLayout();
  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  const context = canvas.getContext('2d');
  await Promise.all(
    [...layout.rects].map(async ([uri, { x, y, size }]) => {
      const image = new Image();
      image.src = uri;
      await image.decode();
      context.drawImage(image, x, y, size, size);
    }),
  );
  return { canvas, cells: layout.cells };
}

const cssToRgb = (css) => {
  const hex = String(css).replace('#', '');
  return [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
};

/** Plain colour copy (what a handle's colour getter returns). */
class StoredColor {
  constructor(color) {
    this.red = color?.red ?? 1;
    this.green = color?.green ?? 1;
    this.blue = color?.blue ?? 1;
    this.alpha = color?.alpha ?? 1;
  }

  withAlpha(alpha) {
    return new StoredColor({ ...this, alpha });
  }
}

/**
 * Registry factory (src/app/layers/renderers.js): `(engine, options)`.
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 * @param {{ drawAtlas?: () => Promise<{ canvas: object, cells: object }> }} [options]
 *   Test seam: the chevron atlas.
 * @returns {import('./contract.js').VesselRenderer}
 */
export function createVesselsNavaraRenderer(
  engine,
  { drawAtlas = drawVesselAtlas } = {},
) {
  let destroyed = false;

  // --- commits: once per frame listener, or in a microtask -----------------
  let bank = null;
  let inFrame = 0;
  let microtask = false;
  let pendingCommit = false;
  const flush = () => {
    microtask = false;
    if (!pendingCommit) return;
    pendingCommit = false;
    bank?.commit();
  };
  const onCommit = () => {
    pendingCommit = true;
    if (inFrame === 0 && !microtask) {
      microtask = true;
      queueMicrotask(flush);
    }
  };
  const inFrameDo = (run) => {
    inFrame++;
    try {
      return run();
    } finally {
      inFrame--;
      if (inFrame === 0) flush();
    }
  };

  // --- the view --------------------------------------------------------------
  const layerView = createNavaraLayerView(engine, {
    layerId: LAYER_ID,
    wrap: inFrameDo,
    isDestroyed: () => destroyed,
  });
  const base = layerView.view;
  const view = {
    get camera() {
      return base.camera;
    },
    scene: base.scene,
    horizon: () => base.horizon(),
    worldToWindow: (position, result) => base.worldToWindow(position, result),
    canvasSize: () => engine.host.size(),
    requestRender: () => base.requestRender(),
    on(event, listener) {
      return event === 'preRender' || event === 'moveEnd'
        ? base.on(event, listener)
        : null;
    },
  };

  // --- the chevrons ------------------------------------------------------------
  let atlas = null;
  let visible = true;
  let attached = false;
  const handles = new Set();
  const records = new Map(); // pickId → record
  let unkeyedSeq = 0;
  const scratchColor = [1, 1, 1, 1];
  const write = (handle, set, index) => {
    const color = handle.storedColor;
    scratchColor[0] = color.red;
    scratchColor[1] = color.green;
    scratchColor[2] = color.blue;
    scratchColor[3] = color.alpha;
    set.set(index, {
      position: handle.storedPosition,
      rotation: handle.storedRotation,
      scale: handle.storedScale,
      color: scratchColor,
      cell: atlas.cells[handle.storedImage]
        ? handle.storedImage
        : Object.keys(atlas.cells)[0],
      show: handle.storedShow,
      pickId: handle.pickId,
    });
  };
  const ensureBank = () => {
    if (bank || !atlas || destroyed) return;
    bank = createMoverBank(engine, {
      options: (capacity, generation) => ({
        id: `${LAYER_ID}-chevrons-${generation}`,
        kind: 'sprite',
        capacity,
        order: SPRITE_LAYER_ORDER.indexOf('ais'),
        // Cesium's disableDepthTestDistance: Infinity.
        depthTest: 'always',
        pickable: true,
        sprite: { atlas, sizePx: VESSEL_ICON_PX },
      }),
      write,
      onCommit,
    });
    bank.setVisible(visible && attached);
    for (const handle of handles) bank.add(handle);
  };
  const atlasReady = Promise.resolve()
    .then(() => drawAtlas())
    .then((drawn) => {
      if (destroyed) return;
      atlas = drawn;
      if (attached) ensureBank();
    });

  const update = (handle, fields) => {
    if (handle.gevBank) handle.gevBank.update(handle, fields);
  };
  const scratchRgba = [1, 1, 1, 1];
  const newHandle = (spec) => {
    const record = spec.id;
    const pickId =
      record?.mmsi != null && record.mmsi !== ''
        ? String(record.mmsi)
        : `gev-vessel-unkeyed:${++unkeyedSeq}`;
    const handle = {
      id: record,
      pickId,
      gevBank: null,
      gevIndex: -1,
      storedPosition: geo.cartesian3.clone(spec.position),
      storedShow: spec.show !== false,
      storedRotation: spec.rotation ?? 0,
      storedScale: spec.scale ?? 1,
      storedImage: spec.image,
      storedColor: new StoredColor(),
      // Cesium reads these before the image loads as undefined (the logic
      // falls back to the 32 px artwork).
      width: undefined,
      height: undefined,
      // The bank draws without a depth test (Cesium's billboards: Infinity).
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      get position() {
        return handle.storedPosition;
      },
      set position(value) {
        handle.storedPosition = geo.cartesian3.clone(value);
        update(handle, { position: handle.storedPosition });
      },
      get show() {
        return handle.storedShow;
      },
      set show(value) {
        const next = value !== false;
        if (next === handle.storedShow) return;
        handle.storedShow = next;
        update(handle, { show: next });
      },
      get rotation() {
        return handle.storedRotation;
      },
      set rotation(value) {
        handle.storedRotation = value;
        update(handle, { rotation: value });
      },
      get scale() {
        return handle.storedScale;
      },
      set scale(value) {
        handle.storedScale = value;
        update(handle, { scale: value });
      },
      get image() {
        return handle.storedImage;
      },
      set image(value) {
        handle.storedImage = value;
        if (atlas?.cells[value]) update(handle, { cell: value });
      },
      get color() {
        return handle.storedColor;
      },
      set color(value) {
        handle.storedColor = new StoredColor(value);
        scratchRgba[0] = handle.storedColor.red;
        scratchRgba[1] = handle.storedColor.green;
        scratchRgba[2] = handle.storedColor.blue;
        scratchRgba[3] = handle.storedColor.alpha;
        update(handle, { color: scratchRgba });
      },
    };
    return handle;
  };

  const fleet = {
    collection: null,
    attached: () => attached,
    attach({ show }) {
      if (attached || destroyed) return;
      attached = true;
      visible = show !== false;
      ensureBank();
      bank?.setVisible(visible);
    },
    setVisible(show) {
      visible = show !== false;
      bank?.setVisible(visible && attached);
      if (visible) view.requestRender();
    },
    add(spec) {
      const handle = newHandle(spec);
      handles.add(handle);
      records.set(handle.pickId, handle.id);
      bank?.add(handle);
      return handle;
    },
    remove(handle) {
      if (!handle || !handles.delete(handle)) return;
      records.delete(handle.pickId);
      handle.gevBank?.remove(handle);
    },
    detach() {
      attached = false;
      for (const handle of handles) {
        handle.gevBank = null;
        handle.gevIndex = -1;
      }
      handles.clear();
      records.clear();
      bank?.destroy();
      bank = null;
    },
  };

  /** The record a pick is of: pick ids are the MMSI (unkeyed: their own). */
  const pickedRecord = (picked) => {
    const id = picked?.id;
    return id === undefined || id === null
      ? null
      : (records.get(String(id)) ?? null);
  };

  // Vessels never follow: a follow belongs to another layer.
  const follow = {
    onChanged: (listener) =>
      engine.camera.followChanged.addEventListener(listener),
    active: () => engine.camera.following() !== null,
  };

  // --- the trail (engine.lines) ----------------------------------------------
  let lineSeq = 0;
  const trails = {
    create({ color, width = 2.5 }) {
      const [r, g, b] = cssToRgb(color);
      const id = `gev-trail:${LAYER_ID}-${++lineSeq}`;
      let line = null;
      const ensure = () =>
        (line ??= engine.lines.createLine({
          id,
          widthPx: width,
          color: [r, g, b, TRAIL_ALPHA],
          depthFailAlpha: TRAIL_OCCLUDED_ALPHA / TRAIL_ALPHA,
          arc: 'geodesic',
          pickId: id,
        }));
      return {
        setPositions(cartesians) {
          if (destroyed) return;
          const positions = [];
          for (const position of Array.isArray(cartesians) ? cartesians : []) {
            if (!position) continue;
            const last = positions[positions.length - 1];
            if (
              last &&
              geo.cartesian3.distanceSquared(last, position) <
                MIN_SEGMENT_DISTANCE_SQ
            )
              continue;
            positions.push(position);
          }
          ensure().setPositions(positions.length >= 2 ? positions : []);
        },
        clear() {
          line?.setPositions([]);
        },
        destroy() {
          line?.destroy();
          line = null;
        },
      };
    },
  };

  return {
    kind: 'navara',
    engine,
    view,
    fleet,
    pickedRecord,
    follow,
    trails,
    /** The atlas is drawn (tests, QA). */
    whenReady: () => atlasReady,
    destroy() {
      if (destroyed) return;
      flush();
      fleet.detach();
      destroyed = true;
      layerView.destroy();
    },
  };
}
