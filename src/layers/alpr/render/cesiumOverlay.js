import * as Cesium from 'cesium';
import { createAlprOverlayCore } from '../overlay.js';

/** Per-layer presentation on a caller-owned overlay; Cesium remains the fallback. */
export function createAlprOverlay({
  state,
  native,
  services,
  onSurfaceChange = () => {},
}) {
  const scene = () => native.viewer.scene;
  const location = (record) =>
    Cesium.Cartographic.fromDegrees(record.longitude, record.latitude);

  /** Swap a marker between its native look and a faint canvas pick target. */
  function canvasOwned(entity, owned) {
    const visible = !owned;
    const billboard = entity.billboard;
    // Keep a faint native pick target under the canvas badge so sibling layer
    // handlers recognize ALPR ownership instead of treating the click as empty.
    if (!visible && !entity.gevAlprNativeAppearance) {
      entity.gevAlprNativeAppearance = {
        position: entity.position,
        heightReference: billboard.heightReference,
        scaleByDistance: billboard.scaleByDistance,
        color: billboard.color,
      };
      entity.position = entity.gevAlprCanvasPosition;
      entity.gevAlprPickPosition = entity.position;
      billboard.heightReference = Cesium.HeightReference.NONE;
      billboard.scaleByDistance = undefined;
      billboard.color = Cesium.Color.WHITE.withAlpha(0.01);
    } else if (visible && entity.gevAlprNativeAppearance) {
      const saved = entity.gevAlprNativeAppearance;
      if (entity.position === entity.gevAlprPickPosition)
        entity.position = saved.position;
      billboard.heightReference = saved.heightReference;
      billboard.scaleByDistance = saved.scaleByDistance;
      billboard.color = saved.color;
      entity.gevAlprNativeAppearance = null;
      entity.gevAlprPickPosition = null;
    }
  }

  // Assign only on change: each Entity property write mints a new property
  // and raises definitionChanged.
  function setShown(entity, visible) {
    if (entity.gevAlprShown === visible) return;
    entity.gevAlprShown = visible;
    entity.billboard.show = visible;
    if (entity.polyline) entity.polyline.show = visible;
    if (entity.polygon) entity.polygon.show = visible;
  }

  /** Whether the visible photoreal tiles (or globe) have finished streaming. */
  function surfaceSettled() {
    const { globe, primitives } = scene();
    if (globe?.show) return globe.tilesLoaded !== false;
    for (let i = 0; i < (primitives?.length || 0); i++) {
      const primitive = primitives.get(i);
      if (primitive?.show && primitive.tilesLoaded === false) return false;
    }
    return true;
  }

  return createAlprOverlayCore({
    state,
    services,
    onSurfaceChange,
    engine: {
      marker: (id) => native.dataSource?.entities.getById(id),
      markers: () => native.dataSource.entities.values,
      canvasOwned,
      setShown,
      setDisplayPosition(entity, position) {
        entity.gevAlprDisplayPosition = position;
      },
      placeAnchor(entity, record, height) {
        entity.gevAlprCanvasPosition = Cesium.Cartesian3.fromDegrees(
          record.longitude,
          record.latitude,
          height,
        );
      },
      surfaceSupported: () => scene().sampleHeightSupported,
      // Each sample is a depth render.
      sampleHeight: (record, entity) =>
        scene().sampleHeight(location(record), [entity]),
      terrainHeight: (record) =>
        scene().globe.show
          ? scene().globe.getHeight?.(location(record))
          : undefined,
      surfaceSettled,
      cameraPose: () => ({
        position: native.viewer.camera.positionWC,
        direction: native.viewer.camera.directionWC,
      }),
      cameraPosition: () => native.viewer.camera.positionWC,
      projector: ({ occluder }) => ({
        horizonVisible: (point) => !occluder || occluder.isPointVisible(point),
        project: (point) =>
          Cesium.SceneTransforms.worldToWindowCoordinates(scene(), point),
      }),
      cullOffscreenWedges: false,
      createId: () => Cesium.createGuid(),
    },
  });
}
