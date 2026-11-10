/**
 * @module render/cesium/application
 * @description The Cesium adapter's side of the application scene
 * (`src/app/scene.js`), its composition root: the default renderer plugin,
 * the viewer behind a renderer it made, the photoreal base tileset the scene
 * loads into that viewer, and the viewer hooks the scene hands the
 * application (stale command trimming, inline panel rendering, whether an
 * entity is the viewer's own, the zoom-out guard). The scene imports this module and no other
 * part of the adapter (`src/render/noCesiumOutsideRender.test.mjs`).
 */
import * as Cesium from 'cesium';
import { cesiumRenderer, cesiumViewerOf } from './appRenderer.js';
import { loadPhotorealisticTileset } from './google3d.js';
import { keepPanelRendering } from './panelRendering.js';
import { trimStaleSceneCommands } from './sceneCommandRelease.js';
import { installZoomOutGuard } from './zoomOutGuard.js';

export { cesiumRenderer, cesiumViewerOf };

/**
 * Load Google Photorealistic 3D Tiles for the application, by the best route
 * the credentials allow (`google3d.js`).
 * @param {{googleApiKey?: string, googleTokens?: object|null, cesiumToken?: string}} credentials
 * @returns {Promise<{tileset: object|null, route: string, errors: Error[]}>}
 */
export const loadApplicationPhotoreal = (credentials) =>
  loadPhotorealisticTileset(Cesium, credentials);

/** Draw the loaded photoreal tileset in `viewer`. */
export function showApplicationPhotoreal(viewer, tileset) {
  viewer.scene.primitives.add(tileset);
}

/**
 * Release the photoreal tileset: out of `viewer`, which destroys it, or
 * destroyed by itself when the viewer never held it.
 */
export function releaseApplicationPhotoreal(viewer, tileset) {
  if (tileset && !tileset.isDestroyed()) {
    if (!viewer.scene.primitives.remove(tileset)) tileset.destroy();
  }
}

/**
 * What the application scene hands the application about its viewer.
 * @param {object} viewer
 */
export function applicationViewerHooks(viewer) {
  return {
    // Drops the draw commands the scene keeps after it stops drawing them;
    // run after a drawn frame (see sceneCommandRelease.js).
    trimStaleCommands: () => trimStaleSceneCommands(viewer.scene),
    // Keeps the globe drawing in an inline panel whose host stops animation
    // frames (embed mode, src/app/embed.js).
    keepPanelRendering: (options) => keepPanelRendering(viewer, options),
    // Whether an entity is one of the viewer's own (Cockpit asks whether
    // the aircraft it flies still draws).
    viewerDrawsEntity: (entity) => viewer.entities.contains(entity),
    // Keeps outward user zooms bounded and the Earth framed; returns its
    // disposer (see zoomOutGuard.js).
    installZoomOutGuard: (options) => installZoomOutGuard(viewer, options),
  };
}
