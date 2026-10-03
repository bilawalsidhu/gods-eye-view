import { normalizeFilter } from './filter.js';

/**
 * Share-link and stored parameters: one boolean per registered provider plus
 * the shared imagery filter. The codec in src/data/layerState.js names the
 * same keys, so a provider added later also needs an option there.
 * @param {{providers: Iterable<[string, boolean]>, filter: {pano: string, sinceDays: number}}} input
 */
export function encodeParams({ providers, filter }) {
  const params = {};
  for (const [id, on] of providers) params[id] = on === true;
  params.pano = filter.pano;
  params.sinceDays = filter.sinceDays;
  return params;
}

/**
 * Read parameters back. Unknown providers and malformed values are ignored,
 * so a link written for a build with more providers still applies cleanly.
 * @param {object} params
 * @param {{providerIds: Iterable<string>, filter: {pano: string, sinceDays: number}}} current
 * @returns {{providers: Map<string, boolean>, filter: {pano: string, sinceDays: number}}}
 */
export function decodeParams(params, { providerIds, filter }) {
  const providers = new Map();
  const source = params && typeof params === 'object' ? params : {};
  for (const id of providerIds)
    if (typeof source[id] === 'boolean') providers.set(id, source[id]);
  const next = {};
  if ('pano' in source) next.pano = source.pano;
  if ('sinceDays' in source) next.sinceDays = source.sinceDays;
  return { providers, filter: normalizeFilter(next, filter) };
}
