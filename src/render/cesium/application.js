/**
 * @module render/cesium/application
 * @description The Cesium adapter's side of the application scene
 * (`src/app/scene.js`), its composition root: the default renderer plugin.
 * Everything else the application needs of this renderer comes with each
 * renderer the plugin makes (`appRenderer.js`). The scene imports this
 * module, when it is given no renderer of its own, and no other part of the
 * adapter (`src/render/noCesiumOutsideRender.test.mjs`).
 */
export { cesiumRenderer } from './appRenderer.js';
