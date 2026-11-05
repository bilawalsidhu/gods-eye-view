// The Local ADS-B layer's renderer on the Navara engine,
// with render/cesium.js's interface: the shared aircraft renderer
// (src/layers/aircraft/render/navara.js) draws the magenta markers (its
// fleet glyphs), the Flights models and the trail; the markers' per-frame
// position, rotation and visibility (Cesium's CallbackProperties and the
// 2,000 km display distance) are written each frame; the 978 MHz UAT ring
// is its own sprite set (Cesium's 24 px transparent point with a 1.5 px
// outline). Registered for 'navara' by the Navara mode after its import()
// (src/app/navaraMode.js). The camera never follows a local aircraft.

import * as geo from '../../../geo/index.js';
import { createAircraftNavaraRenderer } from '../../aircraft/render/navara.js';
import { createMoverBank } from '../../shared/render/navaraMoverBank.js';
import { MODEL_HEADING_OFFSET_DEG } from '../../flights/policy.js';
import { nearFarScale, rgbaFromCss } from '../../shared/color.js';
import {
  LAYER_ID,
  LOCAL_ADSB_COLOR,
  LOCAL_ADSB_UAT_RING_COLOR,
} from '../policy.js';

/** Markers (and the UAT ring) are not drawn past this camera distance (m). */
export const LOCAL_ADSB_DISPLAY_DISTANCE_M = 2_000_000;

const MAGENTA = Object.freeze(rgbaFromCss(LOCAL_ADSB_COLOR));
const RING = rgbaFromCss(LOCAL_ADSB_UAT_RING_COLOR).rgba();
const SCALE_BY_DISTANCE = Object.freeze(
  nearFarScale(1000, 3.0, 8_000_000, 0.5),
);
// Cesium's point: 24 px plus a 1.5 px outline on each side, the outline
// drawn on the outer 1.5 px.
const RING_PIXEL_SIZE = 24;
const RING_OUTLINE_PX = 1.5;
const RING_TOTAL_PX = RING_PIXEL_SIZE + 2 * RING_OUTLINE_PX;
const MARKER_ORDER = -1;

/** The ring's atlas: a white ring on a 64 px canvas (tinted per instance). */
function drawUatRingAtlas(size = 64) {
  const canvas = globalThis.document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  const scale = size / RING_TOTAL_PX;
  const outer = (RING_TOTAL_PX / 2) * scale;
  const band = RING_OUTLINE_PX * scale;
  context.strokeStyle = '#ffffff';
  context.lineWidth = band;
  context.beginPath();
  context.arc(size / 2, size / 2, outer - band / 2, 0, Math.PI * 2);
  context.stroke();
  return { canvas, cells: { ring: [0, 0, 1, 1] } };
}

/**
 * Registry factory (src/app/layers/renderers.js): `(engine, options)`.
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 * @param {{ drawAtlas?: Function, drawRing?: Function }} [options] Test seams.
 */
export function createLocalAdsbNavaraRenderer(
  engine,
  { drawAtlas, drawRing = drawUatRingAtlas } = {},
) {
  const aircraft = createAircraftNavaraRenderer({
    engine,
    layerId: LAYER_ID,
    // Under every sprite collection, as Cesium draws the layer's entities
    // (data/spriteOrder raises the collections over the data sources).
    order: MARKER_ORDER,
    headingOffsetDeg: MODEL_HEADING_OFFSET_DEG,
    ...(drawAtlas ? { drawAtlas } : {}),
  });
  const view = aircraft.view;
  const handles = new Set();
  let visible = false;
  let ringBank = null;
  let removeFrame = null;
  const scratch = geo.cartesian3.create();

  const ringWrite = (handle, set, index) => {
    set.set(index, {
      position: handle.sprite.position,
      color: RING,
      cell: 'ring',
      show: handle.ringShown,
      pickId: handle.id,
    });
  };
  const ringBankFor = () => {
    if (ringBank) return ringBank;
    const atlas = drawRing();
    ringBank = createMoverBank(engine, {
      options: (capacity, generation) => ({
        id: `${LAYER_ID}-rings-${generation}`,
        kind: 'sprite',
        capacity,
        order: MARKER_ORDER + 0.25,
        depthTest: 'always',
        pickable: true,
        sprite: {
          atlas,
          sizePx: RING_TOTAL_PX,
          scaleByDistance: [
            SCALE_BY_DISTANCE.near,
            SCALE_BY_DISTANCE.nearValue,
            SCALE_BY_DISTANCE.far,
            SCALE_BY_DISTANCE.farValue,
          ],
        },
      }),
      write: ringWrite,
      onCommit: (bank) => queueMicrotask(() => bank.commit()),
    });
    ringBank.setVisible(visible);
    return ringBank;
  };

  // Each frame: Cesium's per-frame callbacks and its display distance.
  const frame = () => {
    const camera = view.camera.positionWC;
    const limitSq = LOCAL_ADSB_DISPLAY_DISTANCE_M ** 2;
    for (const handle of handles) {
      const position = handle.spec.position();
      if (!position) continue;
      geo.cartesian3.clone(position, scratch);
      const near = geo.cartesian3.distanceSquared(camera, scratch) <= limitSq;
      const sprite = handle.sprite;
      if (!geo.cartesian3.equals(sprite.position, scratch))
        sprite.position = scratch;
      const rotation = handle.spec.rotation();
      if (rotation !== sprite.rotation) sprite.rotation = rotation;
      const show = near && handle.spec.show() === true;
      if (show !== sprite.show) sprite.show = show;
      if (handle.ring) {
        handle.ringShown = near && handle.ring() === true;
        ringBank?.update(handle, {
          position: sprite.position,
          show: handle.ringShown,
        });
      }
    }
    ringBank?.commit();
  };

  const markers = {
    add(spec) {
      const sprite = aircraft.fleet.add({
        position: spec.position() ?? geo.cartesian3.ZERO,
        image: spec.image,
        width: 20,
        height: 20,
        scale: 1,
        color: MAGENTA,
        rotation: 0,
        scaleByDistance: SCALE_BY_DISTANCE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        id: spec.id,
        show: false,
      });
      const handle = {
        id: spec.id,
        spec,
        sprite,
        ring: null,
        ringShown: false,
        gevBank: null,
        gevIndex: -1,
      };
      handles.add(handle);
      return handle;
    },
    remove(handle) {
      if (!handle) return;
      handles.delete(handle);
      aircraft.fleet.remove(handle.sprite);
      handle.gevBank?.remove(handle);
    },
    setImage(handle, image) {
      if (handle) handle.sprite.image = image;
    },
    setScale(handle, scale) {
      if (handle) handle.sprite.scale = scale;
    },
    hasRing: (handle) => Boolean(handle?.ring),
    setRing(handle, on, ringVisible) {
      if (on) {
        handle.ring = ringVisible;
        ringBankFor().add(handle);
      } else {
        handle.ring = null;
        handle.gevBank?.remove(handle);
      }
    },
  };

  return {
    kind: 'navara',
    engine,
    view,
    markers,
    models: aircraft.models,
    trails: aircraft.trails,
    modelColor: MAGENTA,
    dataSource: null,
    whenReady: () => aircraft.whenReady(),
    attach() {
      removeFrame ??= view.on('preRender', frame);
    },
    setVisible(next) {
      visible = next;
      aircraft.fleet.setVisible(next);
      ringBank?.setVisible(next);
      if (next) view.requestRender();
    },
    detach() {
      removeFrame?.();
      removeFrame = null;
      for (const handle of [...handles]) markers.remove(handle);
      ringBank?.destroy();
      ringBank = null;
      aircraft.fleet.detach();
    },
    destroy() {
      aircraft.destroy();
    },
  };
}
