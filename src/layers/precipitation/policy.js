/** Registered layer id; also its share-link identity. */
export const LAYER_ID = 'precipitation';

/**
 * GeoMet steps hourly and reruns GDPS twice a day, so a shorter poll cannot
 * surface a newer frame — it would only re-download the visible globe against
 * origins that forbid caching. The radar inlay refreshes on the same tick.
 */
export const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Tile level where a 15 km model field stops out-resolving 1 km radar. Cesium
 * owns the handover through the layers' min/maximumTerrainLevel, so this is a
 * threshold rather than a state machine: no camera listener runs.
 */
export const INLAY_HANDOVER_LEVEL = 6;

/** The only hosts this layer ever contacts. */
export const GEOMET_ORIGIN = 'https://geo.weather.gc.ca';
export const NOWCOAST_ORIGIN = 'https://nowcoast.noaa.gov';

/**
 * The MRMS mosaic is densest over the lower 48; this box hugs that rather than
 * the service's full advertised extent. Alaska, Hawaii, the Caribbean and Guam
 * are also in the mosaic but sit far outside any single rectangle, so they keep
 * the model tier instead of opening ocean-sized holes in it.
 */
const CONUS_DEGREES = Object.freeze([-125, 24, -66.5, 50]);

const GDPS = {
  origin: GEOMET_ORIGIN,
  service: `${GEOMET_ORIGIN}/geomet`,
  wmsLayer: 'GDPS_15km_PrecipRate',
  label: 'ECCC GDPS',
  // A model field valid now, never an observation of now. getStats() reports
  // the run and the resulting forecast lead so the row cannot imply otherwise.
  forecast: true,
  alpha: 0.72,
};

const MRMS = {
  origin: NOWCOAST_ORIGIN,
  service: `${NOWCOAST_ORIGIN}/geoserver/observations/weather_radar/ows`,
  wmsLayer: 'base_reflectivity_mosaic',
  label: 'NOAA MRMS',
  inlayLabel: 'US RADAR',
  forecast: false,
  alpha: 0.85,
};

/**
 * Precedence stack, painted in order — later entries sit above earlier ones.
 *
 * The three placements are chosen so exactly one source paints any pixel at any
 * zoom: the model covers the globe while zoomed out, the model minus a CONUS
 * cutout covers zoomed-in views elsewhere, and radar fills that cutout. Without
 * the cutout, radar's transparent no-echo would let modelled rain show through
 * and read as observed. `frameKey` lets the two model placements share one
 * capabilities request.
 */
export const PRECIPITATION_TIERS = Object.freeze([
  Object.freeze({
    ...GDPS,
    id: 'gdps-wide',
    role: 'primary',
    frameKey: `${GDPS.service}|${GDPS.wmsLayer}`,
    rectangleDegrees: null,
    cutoutRectangleDegrees: null,
    minimumTerrainLevel: undefined,
    maximumTerrainLevel: INLAY_HANDOVER_LEVEL - 1,
  }),
  Object.freeze({
    ...GDPS,
    id: 'gdps-detail',
    role: 'detail',
    frameKey: `${GDPS.service}|${GDPS.wmsLayer}`,
    rectangleDegrees: null,
    cutoutRectangleDegrees: CONUS_DEGREES,
    minimumTerrainLevel: INLAY_HANDOVER_LEVEL,
    maximumTerrainLevel: undefined,
  }),
  Object.freeze({
    ...MRMS,
    id: 'mrms-conus',
    role: 'inlay',
    frameKey: `${MRMS.service}|${MRMS.wmsLayer}`,
    rectangleDegrees: CONUS_DEGREES,
    cutoutRectangleDegrees: null,
    minimumTerrainLevel: INLAY_HANDOVER_LEVEL,
    maximumTerrainLevel: undefined,
  }),
]);
