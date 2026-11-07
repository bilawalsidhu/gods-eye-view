/**
 * @module render/cesium/unbound
 * @description What to load, once, before handing the Cesium-free
 * layers a Cesium viewer with no renderer bound: the factories
 * that build a camera, credits, effects, draw and query port over such a
 * viewer when code first asks for one (`rendererOf.js`).
 */
import './camera.js';
import './effects.js';
import './query.js';
