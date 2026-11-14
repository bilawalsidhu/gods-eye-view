/** The statewide traffic feed is separate from curated and worldwide webcams. */
export function cameraCategory(camera) {
  return camera?.sourceKind === '511pa-public-camera' ||
    String(camera?.id || '').startsWith('511pa-')
    ? 'penndot'
    : 'general';
}

/** Missing category settings preserve the reusable layer's complete catalog. */
export function cameraIsEnabled(camera, categories) {
  return categories?.[cameraCategory(camera)] !== false;
}

/** Counts describe registered sources, independent of either category toggle. */
export function cameraCategoryCounts(records) {
  const counts = { general: 0, penndot: 0 };
  for (const { camera } of records) counts[cameraCategory(camera)]++;
  return counts;
}
