/** Semantic candidate operations supplied to search and annotation selection. */
export const FEATURE_SOURCE_METHODS = Object.freeze([
  'getAdministrativeAreas',
  'getAreaGeometry',
  'getNeighborhoodAreas',
  'getStreetAreas',
  'getStreetLines',
  'getFootprints',
  'getEnclosingAreas',
  'getMonuments',
  'getFocusFootprints',
]);

export function requireFeatureSource(source) {
  for (const method of FEATURE_SOURCE_METHODS) {
    if (typeof source?.[method] !== 'function')
      throw new TypeError('Missing feature operation: ' + method);
  }
  return source;
}
