/**
 * CSS colour strings turned into Cesium colours, parsed once each.
 *
 * `Color.fromCssColorString` parses; doing that per entity per update would be the single
 * hottest thing in the render loop. Filled on first use rather than warmed at module load,
 * because eager parsing is a top-level side effect in an imported module.
 *
 * Its own module rather than a copy in each layer, and not in `palette.ts`: the palette is
 * deliberately renderer-free so it can be tested without importing Cesium. One shared cache
 * also means two layers drawing the same hue parse it once between them.
 */

import { Color } from 'cesium';

const CACHE = new Map<string, Color>();

export function cesiumColour(css: string): Color {
  const cached = CACHE.get(css);
  if (cached !== undefined) {
    return cached;
  }
  const made = Color.fromCssColorString(css);
  CACHE.set(css, made);
  return made;
}
