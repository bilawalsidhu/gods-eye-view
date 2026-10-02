import { createDefaultPlaceSearch } from '../search/defaults.js';

// The local server answers these as unconfigured until SEARXNG_URL is set.
const SEARXNG_ENDPOINTS = Object.freeze({
  searxng: '/api/searxng/geocode',
  searxngTextSearch: '/api/searxng/text-search',
});

/** Standalone place search: the default chain plus the local SearXNG routes. */
export function createStandalonePlaceSearch({
  endpoints = {},
  ...options
} = {}) {
  return createDefaultPlaceSearch({
    ...options,
    endpoints: { ...SEARXNG_ENDPOINTS, ...endpoints },
  });
}
