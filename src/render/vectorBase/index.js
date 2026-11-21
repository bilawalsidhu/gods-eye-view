/**
 * @module render/vectorBase
 * @description The vector base painter: a MapLibre style document's vector
 * tiles painted as Web Mercator raster tiles, Cesium-free. The renderer
 * draws `vectorBase` as imagery over `paintVectorTile`.
 */
export { loadVectorStyle, PAINTED_TYPES } from './style.js';
export { paintVectorTile, STYLE_TILE_SIZE } from './paint.js';
export {
  compileExpression,
  compileFilter,
  compileValue,
  parseColor,
  Unsupported,
} from './expressions.js';
