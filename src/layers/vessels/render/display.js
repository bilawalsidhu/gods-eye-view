// The vessels layer's display (contract: ./contract.js), the same on every
// globe engine, through the engine contract only: the ship chevrons are one
// engine.movers sprite bank drawn without a depth test (the ellipsoid
// horizon hides the far side), screen-aligned and centred, whose atlas holds
// every chevron the layer draws (../icons.js, rasterised at 32 px); the
// selected vessel's trail is engine.lines; the camera reads go through the
// shared engine layer view (engine.camera.pose(), the projector) and "another
// layer took the camera" is engine.camera.followChanged.
//
// Handles keep the Billboard field vocabulary the logic writes (contract.js)
// as setters that write the bank; the writes of a frame are committed once,
// at the end of the frame listener that made them (or in a microtask for
// writes outside a frame).

import * as geo from '../../../geo/index.js';
import { createMoverBank } from '../../shared/render/moverBank.js';
import { createEngineLayerView } from '../../shared/render/engineView.js';
import { Rgba, rgbaFromCss } from '../../shared/color.js';
import {
  decodeImages,
  imageAtlasLayout,
  packImageAtlas,
} from '../../shared/render/imageAtlas.js';
import { SPRITE_LAYER_ORDER } from '../../../data/spriteOrder.js';
import { allVesselChevronIcons, VESSEL_ICON_PX } from '../icons.js';

const LAYER_ID = 'ais-live-vessels';
// Where the trail passes the depth test, and where the scene hides it: dimmed,
// never gone.
const TRAIL_ALPHA = 0.85;
const TRAIL_OCCLUDED_ALPHA = 0.4;
const MIN_SEGMENT_DISTANCE_SQ = 0.01;
const ATLAS_PAD = 2;
/** The id namespace of track-history lines (vessels and aircraft). */
export const TRAIL_PICK_PREFIX = 'gev-trail:';

const iconEntry = (key, image) => ({
  key,
  image,
  width: VESSEL_ICON_PX,
  height: VESSEL_ICON_PX,
});
const atlasOptions = (icons) => ({
  cell: VESSEL_ICON_PX + 2 * ATLAS_PAD,
  pad: ATLAS_PAD,
  columns: icons.length,
});

/** The chevron atlas layout (pure): one 32 px cell per icon, in a row. */
export function vesselAtlasLayout(icons = allVesselChevronIcons()) {
  return imageAtlasLayout(
    icons.map((icon) => iconEntry(icon)),
    atlasOptions(icons),
  );
}

/** Draws the atlas (browser): a canvas and its cells, once the SVGs decode. */
async function drawVesselAtlas() {
  const icons = allVesselChevronIcons();
  const images = await decodeImages(icons);
  return packImageAtlas(
    icons.map((icon, i) => iconEntry(icon, images[i])),
    { ...atlasOptions(icons), resize: true },
  );
}

/**
 * Registry factory (src/app/layers/renderers.js): `(engine, options)`.
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 * @param {{ drawAtlas?: () => Promise<{ canvas: object, cells: object }> }} [options]
 *   Test seam: the chevron atlas.
 * @returns {import('./contract.js').VesselRenderer}
 */
export function createVesselsDisplay(
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
  const layerView = createEngineLayerView(engine, {
    layerId: LAYER_ID,
    wrap: inFrameDo,
    isDestroyed: () => destroyed,
  });
  const view = layerView.view;

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
        // Contacts are always visible: no depth test (the ellipsoid horizon
        // hides the far side). The tile sea mesh is not the geoid exactly, so
        // a depth-tested chevron at the geoid would clip behind mesh noise.
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
    })
    .catch((error) =>
      console.warn(`[${LAYER_ID}] chevron atlas failed`, error),
    );

  const update = (handle, fields) => {
    if (handle.gevBank) handle.gevBank.update(handle, fields);
  };
  const scratchRgba = [1, 1, 1, 1];
  const newHandle = (spec) => {
    const record = spec.id;
    const pickId =
      record?.id != null && record.id !== ''
        ? String(record.id)
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
      storedColor: new Rgba(),
      // The chevron artwork's size, before the scale.
      width: VESSEL_ICON_PX,
      height: VESSEL_ICON_PX,
      // The bank draws without a depth test.
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
        handle.storedColor = new Rgba(
          value?.red ?? 1,
          value?.green ?? 1,
          value?.blue ?? 1,
          value?.alpha ?? 1,
        );
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
  const lines = new Set();
  let lineSeq = 0;
  const trails = {
    create({ color, width = 2.5 }) {
      const [r, g, b] = rgbaFromCss(color).rgba();
      const id = `${TRAIL_PICK_PREFIX}${LAYER_ID}-${++lineSeq}`;
      let line = null;
      let shown = true;
      let gone = false;
      const ensure = () => {
        if (!line) {
          line = engine.lines.createLine({
            id,
            widthPx: width,
            color: [r, g, b, TRAIL_ALPHA],
            depthFailAlpha: TRAIL_OCCLUDED_ALPHA / TRAIL_ALPHA,
            arc: 'geodesic',
            pickId: id,
          });
          line.show(shown);
          lines.add(line);
        }
        return line;
      };
      return {
        // Fewer than 2 distinct positions draw nothing; consecutive
        // near-duplicates are dropped.
        setPositions(cartesians) {
          if (gone || destroyed) return;
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
        /** Hides or shows the trail and keeps its positions. */
        setVisible(next) {
          shown = next !== false;
          line?.show(shown);
        },
        clear() {
          line?.setPositions([]);
        },
        destroy() {
          gone = true;
          if (line && lines.delete(line)) line.destroy();
          line = null;
        },
      };
    },
  };

  return {
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
      for (const line of lines) line.destroy();
      lines.clear();
      layerView.destroy();
    },
  };
}
