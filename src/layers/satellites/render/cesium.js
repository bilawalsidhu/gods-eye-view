// Satellite drawing and native follow, extracted unchanged from the layer.
import * as Cesium from 'cesium';
import { isPointerFree } from '../../../data/inputOwnership.js';

export function createSatellitesCesiumRenderer(engine, { viewer } = {}) {
  return {
    kind: 'cesium',
    engine,
    view: viewer,
    createPoints() {
      const points = new Cesium.PointPrimitiveCollection();
      viewer.scene.primitives.add(points);
      return points;
    },
    removePoints(points) {
      viewer?.scene.primitives.remove(points);
    },
    onFrame: (listener) => viewer?.scene.preRender.addEventListener(listener),
    project: (position, result) =>
      Cesium.SceneTransforms.worldToWindowCoordinates(
        viewer.scene,
        position,
        result,
      ),
    createOrbit({ positions, width, color }) {
      const primitive = new Cesium.Primitive({
        geometryInstances: new Cesium.GeometryInstance({
          geometry: new Cesium.PolylineGeometry({
            positions,
            width,
            vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
          }),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(
              color.withAlpha(0.6),
            ),
            depthFailColor: Cesium.ColorGeometryInstanceAttribute.fromColor(
              color.withAlpha(0.35),
            ),
          },
        }),
        appearance: new Cesium.PolylineColorAppearance({ translucent: true }),
        depthFailAppearance: new Cesium.PolylineColorAppearance({
          translucent: true,
        }),
        asynchronous: false,
        allowPicking: false,
      });
      viewer.scene.primitives.add(primitive);
      return primitive;
    },
    commitOrbit() {},
    removeOrbit: (primitive) => viewer?.scene.primitives.remove(primitive),
    createTracked({ position, viewFrom }) {
      return viewer.entities.add({
        position: new Cesium.CallbackProperty(position, false),
        viewFrom,
        point: {
          pixelSize: 14,
          color: Cesium.Color.YELLOW,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    },
    removeTracked: (entity) => viewer?.entities.remove(entity),
    follow: {
      start: (entity) => {
        viewer.trackedEntity = entity;
      },
      release: () => {
        if (viewer) viewer.trackedEntity = undefined;
      },
      current: () => viewer?.trackedEntity,
      onChanged: (listener) =>
        viewer.trackedEntityChanged.addEventListener(listener),
    },
    listenClick(listener, { enabled = () => true } = {}) {
      const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      handler.setInputAction((click) => {
        if (!isPointerFree()) return;
        if (!enabled()) return;
        listener({
          picked: viewer.scene.pick(click.position),
          position: click.position,
        });
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      return { destroy: () => handler.destroy() };
    },
    pickedNorad: (picked) => Number(picked?.primitive?.id),
    isTrackedPick: (picked, entity) => Boolean(entity && picked?.id === entity),
    destroy() {},
  };
}
