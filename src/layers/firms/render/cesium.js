import * as Cesium from 'cesium';
import {
  worldToWindowCoordinates,
  horizonOccluder,
} from '../../../data/render/cesiumProjection.js';
import { createHeatImagery } from '../heatImagery.js';

// Cesium ScreenSpaceEventType.LEFT_CLICK; available before the SDK loads.
export const FIRMS_LEFT_CLICK = 2;
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
  const fadeColor = new Cesium.Color();
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
    /**
     * The far-zoom heatmap draped on this globe: on the active map stack's
     * imagery host (`imageryHost()`), else on the viewer's imagery layers.
     */
    createHeatImagery(imageryHost) {
      return createHeatImagery({
        cesium: Cesium,
        getHost: () =>
          imageryHost?.() ?? {
            collection: viewer.imageryLayers ?? null,
            kind: 'globe',
          },
      });
    },
    /** The hand-off fade: every marker at `alpha`, shown while `show`. */
    fadeSprites(alpha, show) {
      if (destroyed || !sprites) return;
      sprites.show = show;
      const color = Cesium.Color.WHITE.withAlpha(alpha, fadeColor);
      for (let i = 0; i < sprites.length; i += 1) sprites.get(i).color = color;
    },
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
