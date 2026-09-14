import { applicationServices } from '../services/application.js';
export * from './regionalModel.js';
/** Fetch a bounded regional brief through the same-origin dev/preview proxy. */
export async function fetchRegionalBrief(latitude, longitude, { signal } = {}) {
  if (![latitude, longitude].every(Number.isFinite)) throw new Error('Valid coordinates are required');
  return applicationServices.regional.getBrief(latitude, longitude, { signal });
}
