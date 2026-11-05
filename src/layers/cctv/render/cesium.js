import * as Cesium from 'cesium';
import * as geo from '../../../geo/index.js';
import { horizonOccluder } from '../../../data/iconOrientation.js';
import { createFrustumVolumePrimitive } from './cesiumViewshed.js';
import {
  bindTrackingClickGesture,
  isTrackingClickGesture,
} from '../../../data/trackingClickGesture.js';
import { createCesiumCctvGizmoRenderer } from './cesiumGizmo.js';
import {
  CAMERA_ICON,
  IDLE_CAMERA_COLOR,
  IDLE_COVERAGE_COLOR,
  PLANE_OUTLINE_COLOR,
} from '../policy.js';

/** Native CCTV resources and scene operations owned by one viewer. */
export function createCctvCesiumRenderer({ services, state }) {
  let viewer = null;
  let billboards = null;
  let activeTileset = null;
  const entities = new Set();
  const volumes = new Set();
  const listeners = new Set();
  const gizmos = new Set();
  const color = (value) => (value ? Cesium.Color.clone(value) : undefined);
  function ownListener(remove) {
    const release = () => {
      if (!listeners.delete(release)) return;
      remove();
    };
    listeners.add(release);
    return release;
  }
  function addEntity(options) {
    const entity = viewer.entities.add(options);
    entities.add(entity);
    return entity;
  }
  function removeEntity(entity) {
    if (!entities.delete(entity)) return;
    if (viewer.entities.getById(entity.id) === entity)
      viewer.entities.remove(entity);
  }
  function tilesReady() {
    if (!activeTileset || activeTileset.isDestroyed?.()) {
      activeTileset = null;
      const primitives = viewer?.scene?.primitives;
      if (primitives && typeof primitives.get === 'function') {
        for (let i = 0; i < primitives.length; i++) {
          const p = primitives.get(i);
          if (p instanceof Cesium.Cesium3DTileset && !p.isDestroyed?.()) {
            activeTileset = p;
            break;
          }
        }
      }
    }
    if (!activeTileset) return true;
    return activeTileset.show !== false && activeTileset.tilesLoaded === true;
  }
  function extractPickedCameraId(picked) {
    if (!picked) return null;

    const entity = picked.id?.properties
      ? picked.id
      : picked.primitive?.id?.properties
        ? picked.primitive.id
        : null;
    const maybeProp = entity?.properties?.cctvCameraId;
    if (maybeProp) {
      const value =
        typeof maybeProp.getValue === 'function'
          ? maybeProp.getValue(Cesium.JulianDate.now())
          : maybeProp;
      const record =
        typeof value === 'string' ? state._recordById.get(value) : null;
      const ownsCoverageEntity = Boolean(
        record?.coverageEntities?.includes(entity),
      );
      const ownsProjectionEntity =
        record?.projection?.planeEntity === entity ||
        state._projectionEntities.some(
          (runtime) =>
            runtime?.cameraId === value && runtime.planeEntity === entity,
        );
      if (record && (ownsCoverageEntity || ownsProjectionEntity)) return value;
    }

    // Camera billboard IDs are intentionally the upstream camera ID, so a
    // sibling may legitimately use the same string. A bare ID match is not
    // ownership proof: require this layer's billboard collection or the exact
    // billboard stored on the record.
    const directId =
      typeof picked.id === 'string'
        ? picked.id
        : typeof picked.primitive?.id === 'string'
          ? picked.primitive.id
          : null;
    const record = directId === null ? null : state._recordById.get(directId);
    if (!record) return null;
    return picked.primitive === billboards ||
      picked.primitive === record.billboard
      ? directId
      : null;
  }
  return {
    extractPickedCameraId,
    attach(owner) {
      if (viewer && viewer !== owner)
        throw new Error('CCTV renderer already has an owner');
      viewer = owner;
      activeTileset = null;
    },
    get ready() {
      return Boolean(viewer && !viewer.isDestroyed?.());
    },
    cameraCartographic: () => viewer?.camera?.positionCartographic,
    following: () => Boolean(viewer?.trackedEntity),
    globeVisible: () => viewer?.scene?.globe?.show,
    tilesReady,
    project: (position, result) =>
      viewer.scene.cartesianToCanvasCoordinates(position, result),
    distance: (position) =>
      geo.cartesian3.distance(viewer.camera.positionWC, position),
    horizonTest() {
      const occluder = horizonOccluder(viewer.camera);
      return (position) => occluder.isPointVisible(position);
    },
    viewport() {
      const canvas = viewer.scene.canvas;
      return {
        width: canvas.clientWidth || canvas.width || 0,
        height: canvas.clientHeight || canvas.height || 0,
      };
    },
    request: () => viewer?.scene?.requestRender?.(),
    pick: (screen) => viewer.scene.pick(screen),
    onMoveEnd: (fn) => ownListener(viewer.camera.moveEnd.addEventListener(fn)),
    onMoveStart: (fn) =>
      ownListener(viewer.camera.moveStart.addEventListener(fn)),
    bindClick(onClick, options = {}) {
      const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      bindTrackingClickGesture(
        handler,
        (event, gesture) => {
          if (isTrackingClickGesture(gesture)) onClick(event);
        },
        options,
      );
      return ownListener(() => handler.destroy());
    },
    createGizmoRenderer() {
      const gizmo = createCesiumCctvGizmoRenderer(viewer);
      gizmos.add(gizmo);
      return gizmo;
    },
    createMarkers() {
      if (billboards) throw new Error('CCTV markers already exist');
      billboards = new Cesium.BillboardCollection();
      viewer.scene.primitives.add(billboards);
      services.sprites.registerSpriteCollection('cctv', billboards);
      return billboards;
    },
    createMarker(camera, position) {
      return billboards.add({
        id: camera.id,
        image: CAMERA_ICON,
        position,
        color: color(IDLE_CAMERA_COLOR),
        width: 24,
        height: 24,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(350, 1.25, 4_000_000, 0.42),
      });
    },
    setMarkersVisible(value) {
      if (billboards) billboards.show = value;
    },
    restoreOrder: () => services.sprites.restoreSpriteOrder(viewer),
    showCredit: () => services.credits?.showOsmCredit?.(viewer, 'cctv'),
    hideCredit: () => services.credits?.hideOsmCredit?.(viewer, 'cctv'),
    sampleMeshFloorCells: (points, options) =>
      services.mesh.sampleMeshFloorCells(viewer?.scene, points, options),
    obstructionRay(origin, direction, exclude, far) {
      if (!viewer?.scene?.pickFromRay) return undefined;
      const hit = viewer.scene.pickFromRay(
        new Cesium.Ray(origin, direction),
        [billboards, ...exclude].filter(Boolean),
      );
      return hit?.position &&
        geo.cartesian3.distance(origin, hit.position) <= far
        ? hit
        : undefined;
    },
    createPlaneMaterial(image) {
      return new Cesium.ImageMaterialProperty({
        image,
        transparent: true,
        color: Cesium.Color.WHITE.withAlpha(0.95),
      });
    },
    createTestPlaneMaterial: () =>
      new Cesium.ColorMaterialProperty(Cesium.Color.WHITE),
    setPlaneImage(runtime, image) {
      runtime.planeMaterial.image = image;
    },
    createPlane(record, runtime, geometry, positions, orientation) {
      return addEntity({
        id: `cctv-${record.camera.id}-plane`,
        properties: { cctvCameraId: record.camera.id },
        show: false,
        position: positions.capCenter,
        orientation: Cesium.Quaternion.clone(orientation),
        plane: {
          plane: new Cesium.Plane(Cesium.Cartesian3.UNIT_Z, 0.0),
          dimensions: new Cesium.Cartesian2(
            geometry.halfW * 2,
            geometry.halfH * 2,
          ),
          material: runtime.planeMaterial,
          outline: true,
          outlineColor: color(PLANE_OUTLINE_COLOR),
        },
      });
    },
    updatePlane(runtime, geometry, positions, orientation) {
      const entity = runtime.planeEntity;
      entity.position = positions.capCenter;
      entity.orientation = Cesium.Quaternion.clone(orientation);
      if (entity.plane)
        entity.plane.dimensions = new Cesium.Cartesian2(
          geometry.halfW * 2,
          geometry.halfH * 2,
        );
    },
    setPlaneVisible(runtime, visible) {
      if (runtime.planeEntity) runtime.planeEntity.show = visible;
    },
    removePlane: (runtime) => removeEntity(runtime.planeEntity),
    createCoverage(cameraId, positions) {
      const created = [];
      try {
        for (const [role, points] of [
          ['ray-tl', [positions.mount, positions.tl]],
          ['ray-tr', [positions.mount, positions.tr]],
          ['ray-br', [positions.mount, positions.br]],
          ['ray-bl', [positions.mount, positions.bl]],
          [
            'cap',
            [
              positions.tl,
              positions.tr,
              positions.br,
              positions.bl,
              positions.tl,
            ],
          ],
        ]) {
          const entity = addEntity({
            id: `cctv-${cameraId}-${role}`,
            properties: { cctvCameraId: cameraId },
            polyline: {
              positions: points,
              width: 1.2,
              material: color(IDLE_COVERAGE_COLOR),
            },
          });
          entity._coverageRole = role === 'cap' ? 'cap' : 'edge';
          created.push(entity);
        }
        return created;
      } catch (error) {
        for (const entity of created) removeEntity(entity);
        throw error;
      }
    },
    updateCoverage(record, positions) {
      const lines = record.coverageEntities;
      if (!lines || lines.length < 5) return;
      for (const [i, role] of ['tl', 'tr', 'br', 'bl'].entries())
        lines[i].polyline.positions = [positions.mount, positions[role]];
      lines[4].polyline.positions = [
        positions.tl,
        positions.tr,
        positions.br,
        positions.bl,
        positions.tl,
      ];
    },
    removeCoverageEntity: removeEntity,
    styleLine(entity, { visible, width, tint, dashed, depthFail }) {
      entity.show = visible;
      if (!entity.polyline) return;
      entity.polyline.width = width;
      entity.polyline.material = dashed
        ? new Cesium.PolylineDashMaterialProperty({ color: color(tint) })
        : color(tint);
      entity.polyline.depthFailMaterial = color(depthFail);
    },
    hideCoverage(record) {
      for (const entity of record.coverageEntities || []) entity.show = false;
    },
    removeCoverage(record) {
      for (const entity of record.coverageEntities || []) removeEntity(entity);
    },
    createVolume(record, tint) {
      const primitive = createFrustumVolumePrimitive(
        record.frustumPositions,
        color(tint),
      );
      primitive._gevViewshed = record.camera.id;
      viewer.scene.primitives.add(primitive);
      volumes.add(primitive);
      return primitive;
    },
    removeVolume(primitive) {
      if (volumes.delete(primitive)) viewer.scene.primitives.remove(primitive);
    },
    focus(record, duration) {
      viewer.camera.flyToBoundingSphere(
        new Cesium.BoundingSphere(
          record.position,
          Math.max(40, record.camera.rangeM * 0.36),
        ),
        {
          offset: new Cesium.HeadingPitchRange(
            geo.math.toRadians(record.camera.headingDeg),
            geo.math.toRadians(-22),
            Math.max(280, record.camera.rangeM * 1.18),
          ),
          duration: Math.max(0.2, duration || 0),
          easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
        },
      );
    },
    destroy() {
      if (!viewer) return;
      services.credits?.hideOsmCredit?.(viewer, 'cctv');
      for (const remove of listeners) remove();
      for (const gizmo of gizmos) gizmo.destroy();
      gizmos.clear();
      for (const entity of entities) removeEntity(entity);
      for (const volume of volumes) viewer.scene.primitives.remove(volume);
      volumes.clear();
      if (billboards) {
        services.sprites.unregisterSpriteCollection?.('cctv', billboards);
        viewer.scene.primitives.remove(billboards);
      }
      viewer = billboards = activeTileset = null;
    },
  };
}

export function bindCctvWorldClickGesture(handler, onClick, options = {}) {
  bindTrackingClickGesture(
    handler,
    (click, gesture) => {
      if (!isTrackingClickGesture(gesture)) return;
      onClick(click);
    },
    options,
  );
}
