/**
 * @module render/cesium/plugin
 * @description The Cesium renderer plugin made with options, for an
 * application that hands it something of its own: `cameraController`, the
 * shared camera controller's factory, which then drives Cesium's camera
 * and takes the user's input in place of Cesium's own controls
 * (`controlledCamera.js`). Without options it is the default plugin the
 * application scene loads (`application.js`).
 */
export { createCesiumRendererPlugin } from './appRenderer.js';
