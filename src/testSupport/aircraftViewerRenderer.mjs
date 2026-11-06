// An aircraft renderer (src/layers/aircraft/render/contract.js) over a stub
// viewer and the test's own collections, for testing an aircraft layer's
// logic against Cesium-shaped fakes: sprites are what the test's
// billboardCollection.add returns, models load through
// Cesium.Model.fromGltfAsync (which tests stub to control readiness and
// failures) into its modelCollection, the tracked aircraft is an Entity in
// viewer.entities followed through viewer.trackedEntity (with Cesium's one
// exact tracked frame), trails are entity polylines. Not the application's display (render/display.js): that one is
// tested in display.test.mjs.

import * as Cesium from 'cesium';
import { createTrail } from '../data/trailRenderer.js';
import { horizonOccluder } from '../data/iconOrientation.js';
import { engineFromViewer } from '../globe/cesium/engineFromViewer.js';
import { applyTrackedCameraFrame } from '../globe/cesium/follow.js';

const cesiumColor = (color) =>
  color instanceof Cesium.Color
    ? color
    : new Cesium.Color(color.red, color.green, color.blue, color.alpha);

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
 * @param {{ viewer: object, billboardCollection?: object,
 *   modelCollection?: object, engine?: object, headingOffsetDeg?: number }} options
 *   `engine`: what the layer's selection dispatcher binds to (default: the
 *   engine registered for the viewer, if any).
 */
export function aircraftViewerRenderer({
  viewer,
  billboardCollection = null,
  modelCollection = null,
  engine = null,
  headingOffsetDeg = 0,
}) {
  const billboards = billboardCollection;
  const models = modelCollection;
  const scratchHpr = new Cesium.HeadingPitchRoll(0, 0, 0);
  const scratchSphere = new Cesium.BoundingSphere(new Cesium.Cartesian3(), 1.0);
  let cullingVolume = null;
  const inFrustum = (position) => {
    Cesium.Cartesian3.clone(position, scratchSphere.center);
    return (
      cullingVolume.computeVisibility(scratchSphere) !==
      Cesium.Intersect.OUTSIDE
    );
  };
  const scratchSize = {};
  const load = (spec) =>
    Cesium.Model.fromGltfAsync({
      url: spec.url,
      asynchronous: false,
      minimumPixelSize: spec.minimumPixelSize,
      scale: spec.scale,
      color: spec.color,
      colorBlendMode: Cesium.ColorBlendMode.MIX,
      colorBlendAmount: spec.blendAmount,
      id: spec.id,
    });

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
    get surfaceScene() {
      return viewer?.scene;
    },
    frameNumber: () => viewer?.scene?.frameState?.frameNumber ?? -1,
    viewportHeightPx: () => viewer.scene.canvas.clientHeight,
    frustumTester() {
      const camera = viewer.camera;
      cullingVolume = camera.frustum.computeCullingVolume(
        camera.positionWC,
        camera.directionWC,
        camera.upWC,
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
    holdFrames() {},
    closeFrameLatch() {},
    releaseFrames() {},
  };

  const renderer = {
    get engine() {
      return engine ?? engineFromViewer(viewer);
    },
    view,
    fleet: {
      attach() {},
      detach() {},
      attached: () => !!billboards,
      visible: () => !!billboards && billboards.show,
      setVisible(visible) {
        if (billboards) billboards.show = visible;
      },
      add: (spec) => billboards.add(spec),
      remove: (sprite) => billboards.remove(sprite),
      restoreOrder() {},
      restoreOrderOnEnable() {},
    },
    models: {
      live: () => !!models && !models.isDestroyed(),
      setVisible(visible) {
        if (models) models.show = visible;
      },
      loadFleet: load,
      loadTracked: load,
      preload: (url) =>
        Cesium.Model.fromGltfAsync({ url, asynchronous: false }),
      add: (model) => models.add(model),
      remove(model) {
        try {
          models?.remove(model);
        } catch {
          /* gone */
        }
      },
      destroy(model) {
        try {
          model.destroy();
        } catch {
          /* gone */
        }
      },
      setPose(model, position, headingDeg, offsetDeg = headingOffsetDeg) {
        scratchHpr.heading = Cesium.Math.toRadians(
          (headingDeg || 0) + offsetDeg,
        );
        return Cesium.Transforms.headingPitchRollToFixedFrame(
          position,
          scratchHpr,
          Cesium.Ellipsoid.WGS84,
          undefined,
          model.modelMatrix,
        );
      },
    },
    tracked: {
      create: (spec) =>
        viewer.entities.add({
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
            scaleByDistance: cesiumNearFar(spec.scaleByDistance),
            alignedAxis: Cesium.Cartesian3.ZERO,
            disableDepthTestDistance: spec.disableDepthTestDistance,
            rotation: new Cesium.CallbackProperty(() => spec.rotation(), false),
          },
        }),
      remove: (handle) => viewer.entities.remove(handle),
      isLive: (handle) => !!viewer?.entities?.contains?.(handle),
      setImage(handle, image) {
        if (handle?.billboard) handle.billboard.image = image;
      },
      setViewFrom(handle, offset) {
        handle.viewFrom = new Cesium.Cartesian3(offset.x, offset.y, offset.z);
      },
      billboardSize(handle) {
        const billboard = handle?.billboard;
        if (!billboard) return null;
        const time = viewer.clock?.currentTime;
        scratchSize.width = billboard.width?.getValue(time);
        scratchSize.height = billboard.height?.getValue(time);
        scratchSize.scale = billboard.scale?.getValue(time);
        scratchSize.scaleByDistance = billboard.scaleByDistance?.getValue(time);
        return scratchSize;
      },
    },
    follow: {
      // The one exact tracked frame, as Cesium's engine follow applies it.
      start(handle) {
        viewer.camera?.cancelFlight?.();
        viewer.trackedEntity = handle;
        return applyTrackedCameraFrame(viewer, handle, handle.viewFrom) || null;
      },
      refocus: (handle) => renderer.follow.start(handle),
      release() {
        if (viewer) viewer.trackedEntity = undefined;
      },
      isFollowing: (handle) => !!viewer && viewer.trackedEntity === handle,
      current: () => viewer?.trackedEntity,
      onChanged: (listener) =>
        viewer.trackedEntityChanged?.addEventListener(listener) ?? (() => {}),
    },
    trails: {
      create: ({ color, width }) => createTrail(viewer, { color, width }),
      createHead({ id, show, positions, color, width }) {
        if (!viewer?.entities) return null;
        return viewer.entities.add({
          id,
          show,
          polyline: {
            positions: new Cesium.CallbackProperty(() => positions(), false),
            width,
            material: Cesium.Color.fromCssColorString(color).withAlpha(0.9),
          },
        });
      },
      removeHead(head) {
        try {
          if (head) viewer?.entities?.remove(head);
        } catch {
          /* already gone */
        }
      },
    },
    surfaceExclusions: ({ sprites = [], models: modelHandles = [] }) =>
      [...sprites, ...modelHandles].filter(Boolean),
    destroy() {},
  };
  return renderer;
}
