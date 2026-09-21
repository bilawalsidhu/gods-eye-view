/** Rendered-site ceiling per response; the true count travels separately. */
export const WQ_SITE_CAP = 600;

/** Measurement ceiling for one site's result query. */
export const WQ_RESULT_CAP = 400;

export const WQ_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * Water samples are episodic, not hourly: a monitoring site is visited weeks or
 * months apart, so a short TTL would spend the upstream's budget re-fetching
 * bytes that cannot have changed. These are deliberately far longer than the
 * Overpass-backed caches; do not align them without changing the sampling
 * assumption too.
 */
export const WQ_MEMORY_TTL_MS = 6 * 60 * 60_000;

export const WQ_STALE_MS = 7 * 24 * 60 * 60_000;

export const WQ_MAX_CACHE_ENTRIES = 120;

/** Default trailing window for "sites sampled since"; the client may narrow it. */
export const WQ_DEFAULT_WINDOW_YEARS = 5;

export const WQ_MAX_WINDOW_YEARS = 25;

export const WQ_UPSTREAM = 'https://www.waterqualitydata.us';

export const WQ_UPSTREAM_TIMEOUT_MS = 25_000;

/**
 * Analyte families, keyed by the identifiers this API accepts. The values are
 * Water Quality Portal `characteristicType` vocabulary entries and are never
 * built from client input — an unlisted family is rejected rather than
 * forwarded, so no caller can shape the upstream query.
 *
 * A family is a LIST because the upstream vocabulary is not one-to-one: Cape
 * Fear PFAS sites index under `PFAS,Perfluorinated Alkyl Substance` and return
 * nothing for `Organics, PFAS`, so querying a single value silently loses
 * sites. The upstream unions repeated `characteristicType` parameters.
 */
export const WQ_CHARACTERISTIC_TYPES = Object.freeze({
  pfas: Object.freeze([
    'PFAS,Perfluorinated Alkyl Substance',
    'Organics, PFAS',
    'PFOA, Perfluorooctanoic Acid',
    'PFOS, Perfluorooctane Sulfonate',
  ]),
  nutrient: Object.freeze(['Nutrient']),
  metals: Object.freeze(['Inorganics, Minor, Metals']),
  microbio: Object.freeze(['Microbiological']),
  radiochem: Object.freeze(['Radiochemical']),
});
