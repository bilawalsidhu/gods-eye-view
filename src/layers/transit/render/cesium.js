import * as Cesium from 'cesium';
import * as geo from '../../../geo/index.js';
import {
  cameraPoseSignature,
  perspectiveProjectedRotation,
} from '../../../data/iconOrientation.js';
import {
  claimCameraSensitivity,
  releaseCameraSensitivity,
} from '../../../data/cameraSensitivity.js';
import { createContactTrailRenderer } from '../../../data/render/cesiumContactTrailRenderer.js';
import { CAMERA_PERCENTAGE_CHANGED } from '../policy.js';

/** Native resource owner; feed/playback/selection policy stays in the layer. */
export function createTransitCesiumRenderer({ state, services, engine }) {
  let viewer = null;
  const banks = [];
  const removers = new Set();
  const terrainPoint = new Cesium.Cartographic();
  const occluder = new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84);
  const sphere = new Cesium.BoundingSphere(undefined, 5);
  const cameraPosition = geo.cartesian3.create();
  const own = (remove) => {
    const release = () => {
      if (removers.delete(release)) remove();
    };
    removers.add(release);
    return release;
  };
  return {
    attach(host) {
      viewer = host;
    },
    get ready() {
      return Boolean(viewer);
    },
    createMarkers() {
      try {
        for (const id of ['transit', 'transit-motion']) {
          const collection = new Cesium.BillboardCollection({
            blendOption: Cesium.BlendOption.TRANSLUCENT,
          });
          banks.push({ id, collection });
          viewer.scene.primitives.add(collection);
          services.sprites.registerSpriteCollection(id, collection);
          collection.show = false;
        }
        return banks.map(({ collection }) => collection);
      } catch (error) {
        this.destroy();
        throw error;
      }
    },
    restoreOrder: () => services.sprites.restoreSpriteOrder(viewer),
    cameraCartographic: () => viewer?.camera?.positionCartographic,
    viewRectangle: () =>
      viewer?.camera?.computeViewRectangle?.(viewer.scene.globe?.ellipsoid),
    cameraSignature: () =>
      viewer?.scene?.camera ? cameraPoseSignature(viewer.scene.camera) : null,
    rotation: (position, course, previous) =>
      perspectiveProjectedRotation(viewer.scene, position, course, previous),
    visibilityTester() {
      const camera = viewer?.camera;
      if (!camera) return null;
      const position =
        camera.positionWC ||
        geo.ellipsoid.WGS84.cartographicToCartesian(
          camera.positionCartographic,
          cameraPosition,
        );
      occluder.cameraPosition = position;
      const frustum = camera.frustum?.computeCullingVolume(
        position,
        camera.directionWC,
        camera.upWC,
      );
      const planes = frustum?.planes;
      return {
        hasFrustum: Boolean(frustum),
        test(point) {
          sphere.center = point;
          let inFrustum = true;
          if (planes) {
            for (const p of planes) {
              if (
                p.x * point.x + p.y * point.y + p.z * point.z + p.w <
                -sphere.radius
              ) {
                inFrustum = false;
                break;
              }
            }
          } else if (frustum)
            inFrustum =
              frustum.computeVisibility(sphere) !== Cesium.Intersect.OUTSIDE;
          return { horizon: occluder.isPointVisible(point), inFrustum };
        },
      };
    },
    claimCamera() {
      claimCameraSensitivity(
        engine ?? viewer?.camera,
        'transit',
        CAMERA_PERCENTAGE_CHANGED,
      );
    },
    releaseCamera() {
      releaseCameraSensitivity(engine ?? viewer?.camera, 'transit');
    },
    onCameraChanged: (fn) => own(viewer.camera.changed.addEventListener(fn)),
    onPreRender: (fn) => own(viewer.scene.preRender.addEventListener(fn)),
    onPostRender: (fn) => own(viewer.scene.postRender.addEventListener(fn)),
    terrainHeight(lat, lon) {
      const globe = viewer?.scene?.globe;
      if (globe?.show !== true) return undefined;
      Cesium.Cartographic.fromDegrees(lon, lat, 0, terrainPoint);
      const rendered = globe.getHeight?.(terrainPoint);
      return viewer?.terrainProvider instanceof Cesium.EllipsoidTerrainProvider
        ? 0
        : rendered;
    },
    sampleMeshFloorCells: (points, options) =>
      services.mesh?.sampleMeshFloorCells?.(viewer?.scene, points, options),
    addCredit(feed) {
      if (viewer)
        services.credits.registerDynamicCredit(
          viewer,
          services.credits.transitFeedCredit(feed),
        );
    },
    createTrailRenderer: () => createContactTrailRenderer(viewer.scene),
    bindClick(listener, pointerFree) {
      const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      handler.setInputAction((click) => {
        if (!pointerFree()) return;
        const scene = viewer.scene;
        const position = Cesium.Cartesian2.clone(click.position);
        const style = state._stylePreset;
        const stage = scene.postProcessStages?.getStageByName?.(
          `godsEyeView_${style}`,
        );
        if (
          stage?.enabled &&
          (style === 'thermal' || style === 'surveillance')
        ) {
          const intensity = stage.uniforms.intensity;
          const canvas = scene.canvas,
            w = canvas.clientWidth,
            h = canvas.clientHeight;
          let u = position.x / w,
            v = 1 - position.y / h;
          if (style === 'surveillance') {
            const x = u * 2 - 1,
              y = v * 2 - 1,
              r2 = x * x + y * y;
            const d = 1 + r2 * intensity * 0.25 + r2 * r2 * intensity * 0.075;
            u = (x * d + 1) / 2;
            v = (y * d + 1) / 2;
          }
          const grid = 1 + (stage.uniforms.pixelation - 1) * intensity;
          u +=
            ((Math.floor((u * canvas.width) / grid) * grid) / canvas.width -
              u) *
            intensity;
          v +=
            ((Math.floor((v * canvas.height) / grid) * grid) / canvas.height -
              v) *
            intensity;
          position.x = u * w;
          position.y = (1 - v) * h;
        }
        const picked = scene.pick(position);
        listener({
          id: typeof picked?.id === 'string' ? picked.id : null,
          primitiveId:
            typeof picked?.primitive?.id === 'string'
              ? picked.primitive.id
              : null,
          x: position.x,
          y: position.y,
          collection:
            picked?.primitive?._billboardCollection === state._animatedMarkers
              ? 'animated'
              : picked?.primitive?._billboardCollection === state._markers
                ? 'stationary'
                : null,
        });
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      const remove = own(() => handler.destroy());
      return {
        destroy: remove,
        getInputAction: (type) => handler.getInputAction(type),
      };
    },
    frameProbe() {
      return {
        canvas: viewer.scene.canvas,
        gl: viewer.scene.context._gl,
        uploads: banks.map(({ collection }) => ({
          target: collection,
          method: 'update',
        })),
      };
    },
    destroy() {
      for (const remove of [...removers]) remove();
      this.releaseCamera();
      for (const { id, collection } of banks.splice(0)) {
        services.sprites.unregisterSpriteCollection(id, collection);
        viewer?.scene?.primitives?.remove(collection);
        if (!collection.isDestroyed()) collection.destroy();
      }
      viewer = null;
    },
  };
}
