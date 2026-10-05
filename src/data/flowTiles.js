import { createFlowTileSource } from '../layers/traffic/flowSource.js';
export { tilesForBounds } from './tomtomTiles.js';
export { decodeFlowTile } from '../layers/traffic/flowDecode.js';
const source = createFlowTileSource();
export const { fetchFlowForBounds, getFlowSessionStats, resetFlowTileCache } =
  source;
