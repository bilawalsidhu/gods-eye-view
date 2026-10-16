// The aircraft renderer on Cesium (contract: ./contract.js): the Cesium
// objects the aircraft layers used to build themselves, moved here one for
// one — the fleet BillboardCollection and its sprite-order slot, the model
// PrimitiveCollection and its glTF loads, the tracked Entity (billboard with
// per-frame CallbackProperties, followed through viewer.trackedEntity and
// the one exact tracked frame), the trail entity and its live head
// segment, and the camera/frame reads. Nothing here decides anything: the
// layer's logic decides, this draws.

import * as Cesium from 'cesium';
import { createTrail } from '../../../data/trailRenderer.js';
import {
  registerSpriteCollection,
  restoreSpriteOrder,
  restoreSpriteOrderOnEnable,
} from '../../../data/spriteOrder.js';
import { horizonOccluder } from '../../../data/iconOrientation.js';
import { engineFromViewer } from '../../../globe/cesium/engineFromViewer.js';
import { applyTrackedCameraFrame } from '../../../globe/cesium/follow.js';

// The model shader of the IR boost (owner playtest 2026-08-16): boosted
// models render UNLIT so a side-lit airframe does not go black in FLIR/NVG.
// Assigning a customShader to a ready model is a silent no-op, so the layer
// reloads boosted models and the shader is set at creation. One stateless
// instance, shared.
let unlitShader = null;
const irUnlitShader = () =>
  (unlitShader ??= new Cesium.CustomShader({
    lightingModel: Cesium.LightingModel.UNLIT,
  }));

// A colour from the layer (an Rgba or a Cesium.Color) as a Cesium.Color, for
// the entity properties that keep what they are given. Constants convert
// once.
const cesiumColors = new WeakMap();
function cesiumColor(color) {
  if (color instanceof Cesium.Color) return color;
  let converted = cesiumColors.get(color);
  if (!converted) {
    converted = new Cesium.Color(
      color.red,
      color.green,
      color.blue,
      color.alpha,
    );
    if (Object.isFrozen(color)) cesiumColors.set(color, converted);
  }
  return converted;
}

const cesiumNearFar = (scalar) =>
  scalar instanceof Cesium.NearFarScalar
    ? scalar
    : new Cesium.NearFarScalar(
        scalar.near,
        scalar.nearValue,
        scalar.far,
        scalar.farValue,
      );

/**
 * @param {object} options
 * @param {Cesium.Viewer} options.viewer
 * @param {object} [options.engine] The globe engine (default: the viewer's).
 * @param {string} options.spriteLayer The fleet's slot in data/spriteOrder.
 * @param {number} [options.headingOffsetDeg=0] Model nose vs Cesium heading 0.
 * @param {{ billboardCollection?: object, modelCollection?: object }} [options.adopt]
 *   Test seam: drive existing (fake) collections instead of creating them.
 * @returns {import('./contract.js').AircraftRenderer}
 */
export function createAircraftCesiumRenderer({
  viewer,
  engine = null,
  spriteLayer,
  headingOffsetDeg = 0,
  adopt = null,
}) {
  let billboards = adopt?.billboardCollection ?? null;
  let models = adopt?.modelCollection ?? null;
  const scratchHpr = new Cesium.HeadingPitchRoll(0, 0, 0);
  const scratchSphere = new Cesium.BoundingSphere(new Cesium.Cartesian3(), 1.0);
  // The frame's culling volume and one tester over it (no closure per call).
  let cullingVolume = null;
  const inFrustum = (position) => {
    Cesium.Cartesian3.clone(position, scratchSphere.center);
    return (
      cullingVolume.computeVisibility(scratchSphere) !==
      Cesium.Intersect.OUTSIDE
    );
  };
  const scratchSize = {
    width: undefined,
    height: undefined,
    scale: undefined,
    scaleByDistance: undefined,
  };

  const scene = () => viewer?.scene;
  const camera = () => viewer?.camera;

  const view = {
    get camera() {
      return camera();
    },
    get scene() {
      return scene();
    },
    get surfaceOwner() {
      return viewer;
    },
    get surfaceScene() {
      return viewer?.scene;
    },
    frameNumber: () => viewer?.scene?.frameState?.frameNumber ?? -1,
    viewportHeightPx: () => viewer.scene.canvas.clientHeight,
    // The tester stays valid until the next frustumTester() call.
    frustumTester() {
      const cam = viewer.camera;
      cullingVolume = cam.frustum.computeCullingVolume(
        cam.positionWC,
        cam.directionWC,
        cam.upWC,
      );
      return inFrustum;
    },
    horizon: () => horizonOccluder(viewer.camera),
    worldToWindow: (position, result) =>
      Cesium.SceneTransforms.worldToWindowCoordinates(
        viewer.scene,
        position,
        result,
      ),
    requestRender: () => viewer?.scene?.requestRender?.(),
    on(event, listener) {
      const source =
        event === 'moveEnd'
          ? viewer?.camera?.moveEnd
          : event === 'preRender'
            ? viewer?.scene?.preRender
            : event === 'preUpdate'
              ? viewer?.scene?.preUpdate
              : null;
      return source ? source.addEventListener(listener) : null;
    },
    isDestroyed: () => !viewer || viewer.isDestroyed?.() === true,
    // Evidence capture (qa-focus-evidence): Cesium's own render loop off,
    // then its pending-loop latch closed so manual renders start at once.
    holdFrames() {
      viewer.useDefaultRenderLoop = false;
    },
    closeFrameLatch() {
      if (viewer?._cesiumWidget)
        viewer._cesiumWidget._renderLoopRunning = false;
    },
    releaseFrames() {
      if (viewer) viewer.useDefaultRenderLoop = true;
    },
  };

  const fleet = {
    attach() {
      billboards = new Cesium.BillboardCollection();
      viewer.scene.primitives.add(billboards);
      registerSpriteCollection(spriteLayer, billboards);
      models = new Cesium.PrimitiveCollection();
      viewer.scene.primitives.add(models);
    },
    // `owner`: the viewer the layer's destroy() was given (the same one).
    detach(owner) {
      const host = owner ?? viewer;
      if (billboards) {
        host.scene.primitives.remove(billboards);
        billboards = null;
      }
      if (models) {
        host.scene.primitives.remove(models); // removing destroys it + its models
        models = null;
      }
    },
    attached: () => !!billboards,
    visible: () => !!billboards && billboards.show,
    setVisible(visible) {
      if (billboards) billboards.show = visible;
    },
    add: (spec) => billboards.add(spec),
    remove: (sprite) => billboards.remove(sprite),
    restoreOrder: () => restoreSpriteOrder(viewer),
    restoreOrderOnEnable: () => restoreSpriteOrderOnEnable(spriteLayer, viewer),
  };

  const modelSet = {
    live: () => !!models && !models.isDestroyed(),
    setVisible(visible) {
      if (models) models.show = visible;
    },
    loadFleet: ({
      url,
      minimumPixelSize,
      scale,
      color,
      blendAmount,
      unlit,
      id,
    }) =>
      Cesium.Model.fromGltfAsync({
        url,
        asynchronous: false,
        minimumPixelSize,
        scale,
        color,
        colorBlendMode: Cesium.ColorBlendMode.MIX,
        colorBlendAmount: blendAmount,
        customShader: unlit ? irUnlitShader() : undefined,
        id, // so scene.pick returns the icao for click-to-track
      }),
    loadTracked: ({
      url,
      minimumPixelSize,
      scale,
      color,
      blendAmount,
      unlit,
      id,
    }) =>
      Cesium.Model.fromGltfAsync({
        url,
        asynchronous: false,
        minimumPixelSize,
        scale,
        color,
        colorBlendMode: Cesium.ColorBlendMode.MIX,
        colorBlendAmount: blendAmount,
        customShader: unlit ? irUnlitShader() : undefined,
        // Pick id (H1): clicking the tracked plane's own model must read as
        // that plane, not as empty space.
        id,
      }),
    // Warms Cesium's glTF cache (the retained instance is never drawn).
    preload: (url) =>
      Cesium.Model.fromGltfAsync({
        url,
        asynchronous: false,
      }),
    add: (model) => models.add(model),
    remove(model) {
      if (models && !models.isDestroyed()) {
        try {
          models.remove(model);
        } catch {
          /* gone */
        }
      }
    },
    destroy(model) {
      try {
        model.destroy();
      } catch {
        /* gone */
      }
    },
    /**
     * World transform from a position and a course (pitch/roll 0, ENU frame),
     * written into the model's OWN modelMatrix: Model.modelMatrix is a plain
     * field Cesium clones per frame, so models never share one mutable
     * matrix (a shared scratch stacked every model on the last-written
     * plane: the "flickering like mad" bug).
     */
    setPose(model, position, headingDeg) {
      scratchHpr.heading = Cesium.Math.toRadians(
        (headingDeg || 0) + headingOffsetDeg,
      );
      scratchHpr.pitch = 0;
      scratchHpr.roll = 0;
      return Cesium.Transforms.headingPitchRollToFixedFrame(
        position,
        scratchHpr,
        Cesium.Ellipsoid.WGS84,
        undefined,
        model.modelMatrix,
      );
    },
  };

  const tracked = {
    /**
     * The tracked aircraft as an Entity: a pure billboard (no model or label
     * graphic, so viewer.trackedEntity always has a ready bounding sphere),
     * in the ENU tracking frame the close-range camera guard also uses.
     * Cesium generates its id: an explicit one would throw when a re-init
     * briefly overlaps collections.
     */
    create(spec) {
      return viewer.entities.add({
        position: new Cesium.CallbackProperty(() => spec.position(), false),
        trackingReferenceFrame: Cesium.TrackingReferenceFrame.ENU,
        billboard: {
          image: spec.image,
          width: spec.width,
          height: spec.height,
          scale: spec.scale,
          color: new Cesium.CallbackProperty(
            () => cesiumColor(spec.color()),
            false,
          ),
          sizeInMeters: false,
          scaleByDistance: cesiumNearFar(spec.scaleByDistance),
          alignedAxis: Cesium.Cartesian3.ZERO,
          disableDepthTestDistance: spec.disableDepthTestDistance,
          rotation: new Cesium.CallbackProperty(() => spec.rotation(), false),
        },
      });
    },
    remove(handle) {
      viewer.entities.remove(handle);
    },
    isLive: (handle) => !!viewer?.entities?.contains?.(handle),
    setImage(handle, image) {
      if (handle?.billboard) handle.billboard.image = image;
    },
    setViewFrom(handle, offset) {
      handle.viewFrom = new Cesium.Cartesian3(offset.x, offset.y, offset.z);
    },
    /**
     * The tracked billboard's drawn size inputs, at the viewer's time. The
     * result is reused (read it before the next call).
     */
    billboardSize(handle) {
      const billboard = handle?.billboard;
      if (!billboard) return null;
      const time = viewer.clock.currentTime;
      scratchSize.width = billboard.width?.getValue(time);
      scratchSize.height = billboard.height?.getValue(time);
      scratchSize.scale = billboard.scale?.getValue(time);
      scratchSize.scaleByDistance = billboard.scaleByDistance?.getValue(time);
      return scratchSize;
    },
  };

  const follow = {
    // Cancel any flight first: Cesium applies the entity's viewFrom on the
    // first frame only from an idle camera.
    start(handle) {
      viewer.camera.cancelFlight();
      viewer.trackedEntity = handle;
      return applyTrackedCameraFrame(viewer, handle, handle.viewFrom) || null;
    },
    refocus(handle) {
      viewer.camera.cancelFlight();
      viewer.trackedEntity = handle;
      return applyTrackedCameraFrame(viewer, handle, handle.viewFrom) || null;
    },
    // Releasing trackedEntity leaves the camera where the follow put it.
    release() {
      if (viewer) viewer.trackedEntity = undefined;
    },
    isFollowing: (handle) => !!viewer && viewer.trackedEntity === handle,
    current: () => viewer?.trackedEntity,
    onChanged: (listener) =>
      viewer.trackedEntityChanged.addEventListener(listener),
  };

  const trails = {
    create: ({ color, width }) => createTrail(viewer, { color, width }),
    /**
     * The live head segment: last fix → the dead-reckoned aircraft, updated
     * per frame through a CallbackProperty (entity polylines update cheaply,
     * the trail body rebuilds on setPositions). The 'gev-trail' id namespace
     * is claimed by trailRenderer's pick owner.
     */
    createHead({ id, show, positions, color, width }) {
      if (!viewer) return null;
      return viewer.entities.add({
        id,
        show,
        polyline: {
          positions: new Cesium.CallbackProperty(() => positions(), false),
          width,
          material: Cesium.Color.fromCssColorString(color).withAlpha(0.9),
          // The head never vanishes into the mesh (dimmed when occluded).
          depthFailMaterial:
            Cesium.Color.fromCssColorString(color).withAlpha(0.45),
          arcType: Cesium.ArcType.GEODESIC,
        },
      });
    },
    removeHead(head) {
      if (head && viewer && !viewer.isDestroyed()) {
        try {
          viewer.entities.remove(head);
        } catch {
          /* already gone */
        }
      }
    },
  };

  return {
    kind: 'cesium',
    get engine() {
      return engine ?? engineFromViewer(viewer);
    },
    viewer,
    view,
    fleet,
    models: modelSet,
    tracked,
    follow,
    trails,
    /**
     * Everything a vertical surface probe must not hit: Cesium excludes
     * picked objects, and the layer's billboards and models are its own.
     */
    surfaceExclusions: ({ sprites = [], models: modelHandles = [] }) =>
      [...sprites, ...modelHandles].filter(Boolean),
    destroy() {
      billboards = null;
      models = null;
    },
  };
}
