import { createSpatialWellSource } from './spatialSource.js';

export const RAINFOLK_WELL_DATA_ORIGIN = 'https://data.rainfolk.org';
export const RAINFOLK_WELL_RELEASE =
  'e6dc61db1500b491671cf094602e2257814c5507e99618d717fbb4f6082d8291';

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
