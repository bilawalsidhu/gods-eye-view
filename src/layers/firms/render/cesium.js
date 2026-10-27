import * as Cesium from 'cesium';
import {
  worldToWindowCoordinates,
  horizonOccluder,
} from '../../../data/render/cesiumProjection.js';

export const FIRMS_LEFT_CLICK = Cesium.ScreenSpaceEventType.LEFT_CLICK;
export const projectFirmsWindow = worldToWindowCoordinates;
export const firmsHorizonOccluder = horizonOccluder;

/** Own the native ground rectangles, translucent sprites and their scene. */
export function createFirmsCesiumRenderer(
  engine,
  { viewer, id, services, screenSpaceEventHandlerFactory } = {},
) {
  if (!viewer?.dataSources)
    throw new TypeError('FIRMS requires a native viewer');
  const dataSource = new Cesium.CustomDataSource(id);
  dataSource.show = false;
  viewer.dataSources.add(dataSource);
  let sprites = null,
    visible = false,
    destroyed = false;
  const spriteServices = services.sprites;
  function removeSprites() {
    if (!sprites) return;
    spriteServices.unregisterSpriteCollection?.('firms', sprites);
    if (!viewer.scene?.isDestroyed?.()) {
      try {
        viewer.scene?.primitives?.remove(sprites);
      } catch {
        /* scene already removed it */
      }
    }
    sprites = null;
  }
  return {
    kind: 'cesium',
    view: viewer,
    dataSource,
    clickType: FIRMS_LEFT_CLICK,
    project(position, result) {
      return projectFirmsWindow(viewer.scene, position, result);
    },
    viewRectangle(result) {
      return viewer.camera.computeViewRectangle(
        viewer.scene?.globe?.ellipsoid,
        result,
      );
    },
    horizon() {
      const camera = viewer.camera?.positionWC
        ? viewer.camera
        : viewer.scene?.camera;
      return camera?.positionWC ? horizonOccluder(camera) : null;
    },
    createInputHandler() {
      return screenSpaceEventHandlerFactory
        ? screenSpaceEventHandlerFactory(viewer)
        : new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    },
    pick(position) {
      return viewer.scene.pick(position);
    },
    setVisible(show) {
      if (destroyed) return;
      visible = show !== false;
      dataSource.show = visible;
      if (sprites) sprites.show = visible;
    },
    clearCells() {
      if (!destroyed) dataSource.entities.removeAll();
    },
    addCell({ west, south, east, north, color, position, properties }) {
      if (destroyed) return null;
      return dataSource.entities.add({
        rectangle: {
          coordinates: Cesium.Rectangle.fromDegrees(west, south, east, north),
          material: new Cesium.ColorMaterialProperty(
            new Cesium.Color(color.red, color.green, color.blue, color.alpha),
          ),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
        position,
        properties,
      });
    },
    ensureSprites() {
      if (destroyed) return null;
      if (!sprites) {
        sprites = new Cesium.BillboardCollection({
          scene: viewer.scene,
          blendOption: Cesium.BlendOption.TRANSLUCENT,
        });
        sprites.show = visible;
        viewer.scene.primitives.add(sprites);
        spriteServices.registerSpriteCollection('firms', sprites);
        spriteServices.restoreSpriteOrder(viewer);
      }
      return sprites;
    },
    addSprite(description) {
      if (destroyed) return null;
      return sprites.add({
        ...description,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    },
    removeSprites,
    onEnable() {
      if (!destroyed)
        spriteServices.restoreSpriteOrderOnEnable('firms', viewer);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      removeSprites();
      viewer.dataSources.remove(dataSource, true);
    },
  };
}
