import { createSpatialWellSource } from './spatialSource.js';

export const RAINFOLK_WELL_DATA_ORIGIN = 'https://data.rainfolk.org';
export const RAINFOLK_WELL_RELEASE =
  '8fa0f2843ef51c51f07da74644f9f5a2cf56c45563dc12f48dfaaca5e6aa6fe2';

/** Published immutable historical records; changing release is explicit host configuration. */
export function createRainfolkWellSource({
  release = RAINFOLK_WELL_RELEASE,
  fetchImpl = globalThis.fetch,
  onCatalog,
} = {}) {
  if (typeof release !== 'string' || !/^[a-f0-9]{64}$/.test(release))
    throw new TypeError('Invalid Rainfolk well release');
  return createSpatialWellSource({
    base: `${RAINFOLK_WELL_DATA_ORIGIN}/usgwd/${release}/`,
    allowedDataOrigins: [RAINFOLK_WELL_DATA_ORIGIN],
    expectedIndexSha256: release,
    // i18n-ignore -- Provider brand.
    label: 'Rainfolk',
    fetchImpl,
    onCatalog,
  });
}
