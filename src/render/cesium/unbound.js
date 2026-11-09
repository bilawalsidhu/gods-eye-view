/**
 * @module render/cesium/unbound
 * @description What to load, once, before handing the Cesium-free
 * layers a Cesium viewer with no renderer bound: the factories
 * that build a camera, credits, effects, draw, frame, globe, input and query
 * port over such a viewer when code first asks for one, a click's own
 * Cesium picks (`rendererOf.js`), the map engine the map stacks switch
 * through (`src/maps/engine.js`), and the sky's precise ICRF rotation
 * (`src/sky/icrf.js`).
 */
import './camera.js';
import './effects.js';
import './frame.js';
import './globe.js';
import './input.js';
import './mapEngine.js';
import './nativeClick.js';
import './query.js';
import './starrySky.js';
