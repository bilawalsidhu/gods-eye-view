/**
 * @module sky
 * @description The sky background, Cesium-free: catalogue stars over a
 * soft Milky Way, both in ICRF/J2000, and the precise ICRF-to-fixed rotation
 * the Cesium renderer provides for the rest of the application.
 */

export {
  STAR_CATALOGUE_URL,
  MILKY_WAY_FACE_URLS,
  MILKY_WAY_INTENSITY,
} from './assets.js';
export {
  STAR_VERTEX_FLOATS,
  STAR_LIMIT_MAGNITUDE,
  buildStarVertices,
  raDecToUnitVector,
} from './stars.js';
export { provideIcrfToFixed, icrfToFixedAxes } from './icrf.js';
