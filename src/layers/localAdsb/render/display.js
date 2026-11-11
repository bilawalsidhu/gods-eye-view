// The Local ADS-B layer's display, the same on every engine: the aircraft
// display (src/layers/aircraft/render/display.js) draws the magenta markers
// (its fleet glyphs), the Flights models and the trail; the markers'
// position, rotation and visibility are read each frame, within a 2,000 km
// display distance; the 978 MHz UAT ring is a point set (24 px, transparent,
// a 1.5 px outline). The camera never follows a local aircraft.
//
// The display:
//   view                 camera, scene, horizon(), frustumTester(),
//                        engine, requestRender(), on('preRender', fn)
//   attach(), setVisible(bool), detach()
//   markers.add({ id, image, position(), rotation(), show() }) → handle
//     (the context and readout annotations go on it), remove(handle),
//     setImage(handle, image), setScale(handle, scale), hasRing(handle),
//     setRing(handle, on, visible())
//   models               the aircraft display's models (live, loadFleet,
//                        add, remove, destroy, setPose)
//   trails.create({ color, width }) → Trail, createHead({ id, positions(),
//     color, width }), removeHead(head)
//   engine, destroy()

import * as geo from '../../../geo/index.js';
import { createAircraftDisplay } from '../../aircraft/render/display.js';
import { createMoverBank } from '../../shared/render/moverBank.js';
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
const TRANSPARENT = [0, 0, 0, 0];
const SCALE_BY_DISTANCE = Object.freeze(
  nearFarScale(1000, 3.0, 8_000_000, 0.5),
);
const RING_PIXEL_SIZE = 24;
const RING_OUTLINE_PX = 1.5;
// Under the aircraft layers' sprites (data/spriteOrder).
const MARKER_ORDER = -1;

/**
 * Registry factory (src/app/layers/renderers.js): `(engine, options)`.
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 * @param {{ drawAtlas?: Function }} [options] Test seam: the glyph atlas.
 */
export function createLocalAdsbDisplay(engine, { drawAtlas } = {}) {
  const aircraft = createAircraftDisplay(engine, {
    layerId: LAYER_ID,
    order: MARKER_ORDER,
    headingOffsetDeg: MODEL_HEADING_OFFSET_DEG,
    ...(drawAtlas ? { drawAtlas } : {}),
  });
  const view = aircraft.view;
  // Hidden until the layer shows it.
  aircraft.fleet.setVisible(false);
  const handles = new Set();
  let visible = false;
  let ringBank = null;
  let ringDirty = false;
  let removeFrame = null;
  const scratch = geo.cartesian3.create();

  const ringWrite = (handle, set, index) => {
    set.set(index, {
      position: handle.sprite.position,
      color: TRANSPARENT,
      show: handle.ringShown,
      pickId: handle.id,
    });
  };
  const commitRings = () => {
    ringDirty = false;
    ringBank?.commit();
  };
  const ringBankFor = () => {
    if (ringBank) return ringBank;
    ringBank = createMoverBank(engine, {
      options: (capacity, generation) => ({
        id: `${LAYER_ID}-rings-${generation}`,
        kind: 'point',
        capacity,
        order: MARKER_ORDER + 0.25,
        depthTest: 'always',
        pickable: true,
        point: {
          sizePx: RING_PIXEL_SIZE,
          outlinePx: RING_OUTLINE_PX,
          outlineColor: RING,
          scaleByDistance: [
            SCALE_BY_DISTANCE.near,
            SCALE_BY_DISTANCE.nearValue,
            SCALE_BY_DISTANCE.far,
            SCALE_BY_DISTANCE.farValue,
          ],
        },
      }),
      write: ringWrite,
      // Committed at the end of the frame pass, or in a microtask.
      onCommit: () => {
        if (ringDirty) return;
        ringDirty = true;
        queueMicrotask(commitRings);
      },
    });
    ringBank.setVisible(visible);
    return ringBank;
  };

  // Each frame: the markers' position, rotation and visibility, and the
  // display distance.
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
    commitRings();
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
    engine,
    view,
    markers,
    models: aircraft.models,
    trails: aircraft.trails,
    /** The model tint (the layer's magenta). */
    modelColor: MAGENTA,
    dataSource: null,
    whenReady: () => aircraft.whenReady(),
    attach() {
      aircraft.fleet.attach();
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
