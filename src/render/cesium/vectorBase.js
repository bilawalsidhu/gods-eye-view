/**
 * @module render/cesium/vectorBase
 * @description `vectorBase` on Cesium: an imagery provider over the vector
 * base painter (`src/render/vectorBase/`), each Web Mercator tile painted
 * from the style at 256 px.
 */
import * as Cesium from 'cesium';
import { paintVectorTile } from '../vectorBase/index.js';

/** The tile size vector base tiles are painted at, pixels. */
export const VECTOR_TILE_PX = 256;

/** The deepest level painted; deeper, Cesium draws this level's tiles. */
export const VECTOR_MAX_LEVEL = 20;

/**
 * A Cesium imagery provider painting a loaded style's tiles.
 * @param {Awaited<ReturnType<typeof import('../vectorBase/index.js').loadVectorStyle>>} style
 */
export function vectorBaseProvider(style) {
  const tilingScheme = new Cesium.WebMercatorTilingScheme();
  return {
    tilingScheme,
    tileWidth: VECTOR_TILE_PX,
    tileHeight: VECTOR_TILE_PX,
    minimumLevel: 0,
    maximumLevel: VECTOR_MAX_LEVEL,
    rectangle: tilingScheme.rectangle,
    credit: undefined,
    errorEvent: new Cesium.Event(),
    hasAlphaChannel: false,
    tileDiscardPolicy: undefined,
    proxy: undefined,
    getTileCredits: () => undefined,
    pickFeatures: () => undefined,
    requestImage: (x, y, level) =>
      paintVectorTile(style, level, x, y, { size: VECTOR_TILE_PX }),
  };
}

/** A TileJSON attribution (markup) as plain text. */
export function attributionText(html) {
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&copy;/gi, '©')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
