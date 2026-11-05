// The Local ADS-B layer's renderer on Cesium: its
// CustomDataSource of marker entities (billboard with per-frame position,
// rotation and visibility callbacks, a 2,000 km display distance, the 978 MHz
// UAT ring as a point graphic), its model PrimitiveCollection (models load,
// pose and leave through the shared aircraft renderer's model part), the
// selected aircraft's trail and live head segment, and the camera reads.
// Nothing here decides anything: the layer's logic decides, this draws.
//
// The renderer (contract shared with render/navara.js):
//   view                 camera, scene, horizon(), frustumTester(),
//                        surfaceOwner, requestRender(), on('preRender', fn)
//   attach(), setVisible(bool), detach()
//   markers.add({ id, image, scale, position(), rotation(), show() }) →
//     handle (an Entity on Cesium: the context and readout annotations go
//     on it), remove(handle), setImage(handle, image), setScale(handle,
//     scale), hasRing(handle), setRing(handle, on, visible())
//   models               the aircraft renderer's models (live, loadFleet,
//                        add, remove, destroy, setPose), or null without a
//                        primitive collection
//   trails.create({ color, width }) → Trail | null, createHead({ id,
//     positions(), color, width }), removeHead(head)
//   engine, destroy()

import * as Cesium from 'cesium';
import { createAircraftCesiumRenderer } from '../../aircraft/render/cesium.js';
import { MODEL_HEADING_OFFSET_DEG } from '../../flights/policy.js';
import {
  LAYER_ID,
  LOCAL_ADSB_COLOR,
  LOCAL_ADSB_UAT_RING_COLOR,
} from '../policy.js';

/** Markers (and the UAT ring) are not drawn past this camera distance (m). */
export const LOCAL_ADSB_DISPLAY_DISTANCE_M = 2_000_000;

/**
 * Registry factory (src/app/layers/renderers.js): `(engine, options)`.
 * @param {object|null} engine The Cesium globe engine (null in unit tests).
 * @param {{ viewer: object, loadModel?: Function, createTrail?: Function }} options
 *   `loadModel`: the glTF loader (test seam); `createTrail`: the trail
 *   renderer (data/trailRenderer createTrail; no trail without it).
 */
export function createLocalAdsbCesiumRenderer(
  engine,
  { viewer, loadModel, createTrail = null } = {},
) {
  const color = Cesium.Color.fromCssColorString(LOCAL_ADSB_COLOR);
  const uatRingColor = Cesium.Color.fromCssColorString(
    LOCAL_ADSB_UAT_RING_COLOR,
  );
  let dataSource = null;
  let modelCollection = null;
  let aircraft = null;

  const view = {
    get camera() {
      return viewer?.camera;
    },
    get scene() {
      return viewer?.scene;
    },
    get surfaceOwner() {
      return viewer;
    },
    horizon: () => aircraft.view.horizon(),
    frustumTester: () => aircraft.view.frustumTester(),
    requestRender: () => viewer?.scene?.requestRender?.(),
    on(event, listener) {
      if (event !== 'preRender') return null;
      return viewer?.scene?.preRender?.addEventListener
        ? viewer.scene.preRender.addEventListener(listener)
        : null;
    },
  };

  const uatRing = (visible) =>
    new Cesium.PointGraphics({
      pixelSize: 24,
      color: Cesium.Color.TRANSPARENT,
      outlineColor: uatRingColor,
      outlineWidth: 1.5,
      scaleByDistance: new Cesium.NearFarScalar(1000, 3.0, 8_000_000, 0.5),
      show: new Cesium.CallbackProperty(() => visible(), false),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
        0,
        LOCAL_ADSB_DISPLAY_DISTANCE_M,
      ),
    });

  const markers = {
    add(spec) {
      return dataSource.entities.add({
        id: spec.id,
        position: new Cesium.CallbackProperty(() => spec.position(), false),
        billboard: {
          image: spec.image,
          width: 20,
          height: 20,
          scale: 1,
          color,
          sizeInMeters: false,
          scaleByDistance: new Cesium.NearFarScalar(1000, 3.0, 8_000_000, 0.5),
          alignedAxis: Cesium.Cartesian3.ZERO,
          rotation: new Cesium.CallbackProperty(() => spec.rotation(), false),
          show: new Cesium.CallbackProperty(() => spec.show(), false),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
            0,
            LOCAL_ADSB_DISPLAY_DISTANCE_M,
          ),
        },
      });
    },
    remove(handle) {
      dataSource?.entities.remove(handle);
    },
    setImage(handle, image) {
      if (handle?.billboard) handle.billboard.image = image;
    },
    setScale(handle, scale) {
      if (handle?.billboard) handle.billboard.scale = scale;
    },
    hasRing: (handle) => Boolean(handle?.point),
    setRing(handle, on, visible) {
      handle.point = on ? uatRing(visible) : undefined;
    },
  };

  const trails = {
    create: ({ color: css, width }) =>
      typeof createTrail === 'function' && viewer?.entities
        ? createTrail(viewer, { color: css, width })
        : null,
    // Live head: last heard fix → the extrapolated marker, every frame.
    createHead({ id, positions, width }) {
      return viewer.entities.add({
        // 'gev-trail' namespace: claimed by the trail pick owner so a click
        // on the head segment never reads as empty space.
        id,
        polyline: {
          positions: new Cesium.CallbackProperty(() => positions(), false),
          width,
          material: color.withAlpha(0.9),
          depthFailMaterial: color.withAlpha(0.45),
          arcType: Cesium.ArcType.GEODESIC,
        },
      });
    },
    removeHead(head) {
      if (head && viewer && !viewer.isDestroyed?.()) {
        try {
          viewer.entities.remove(head);
        } catch {
          /* torn down */
        }
      }
    },
  };

  const renderer = {
    kind: 'cesium',
    get engine() {
      return aircraft?.engine ?? engine;
    },
    view,
    markers,
    trails,
    /** The aircraft renderer's models, or null (no primitive collection). */
    models: null,
    /** The model tint (the layer's magenta). */
    modelColor: color,
    attach() {
      dataSource = new Cesium.CustomDataSource(LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      if (viewer.scene?.primitives) {
        modelCollection = new Cesium.PrimitiveCollection();
        viewer.scene.primitives.add(modelCollection);
      }
      aircraft = createAircraftCesiumRenderer({
        viewer,
        engine,
        spriteLayer: null,
        headingOffsetDeg: MODEL_HEADING_OFFSET_DEG,
        adopt: { modelCollection },
        ...(loadModel ? { loadModel } : {}),
      });
      if (modelCollection) renderer.models = aircraft.models;
    },
    setVisible(visible) {
      if (dataSource) dataSource.show = visible;
    },
    /** The data source, for the context slot's metadata. */
    get dataSource() {
      return dataSource;
    },
    // Removing the model collection destroys it and the models left in it.
    detach() {
      if (
        modelCollection &&
        !viewer.isDestroyed?.() &&
        !modelCollection.isDestroyed()
      )
        viewer.scene.primitives.remove(modelCollection);
      modelCollection = null;
      if (viewer && dataSource) viewer.dataSources.remove(dataSource, true);
      dataSource = null;
      renderer.models = null;
    },
    destroy() {
      aircraft?.destroy();
      aircraft = null;
    },
  };
  return renderer;
}
