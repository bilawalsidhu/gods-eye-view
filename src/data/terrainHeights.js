import { createTerrainHeights } from '../services/terrainHeights.js';
import { applicationServices } from '../services/application.js';
const terrainHeights = createTerrainHeights({
  source: applicationServices.terrain,
});
export const {
  cachedEllipsoidalGround,
  cachedRealEllipsoidalGround,
  resolveEllipsoidalGround,
} = terrainHeights;
