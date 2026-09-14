/** Registered layer id; also its share-link identity. */
export const LAYER_ID = 'precipitation';

/**
 * GeoMet steps hourly and reruns GDPS twice a day, so a shorter poll cannot
 * surface a newer frame — it would only re-download the visible globe against
 * origins that forbid caching. The radar inlay refreshes on the same tick.
 */
export const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Tile level where 1 km radar starts out-resolving a 15 km model field. Cesium
 * owns the handover through the inlay's minimumTerrainLevel, so this is a
 * threshold rather than a state machine: no camera listener runs.
 */
export const INLAY_HANDOVER_LEVEL = 6;

/** The only hosts this layer ever contacts. */
export const GEOMET_ORIGIN = 'https://geo.weather.gc.ca';
export const NOWCOAST_ORIGIN = 'https://nowcoast.noaa.gov';

/**
 * The MRMS mosaic is densest over the lower 48; this box hugs that rather than
 * the service's full advertised extent. Alaska, Hawaii, the Caribbean and Guam
 * are also in the mosaic but sit far outside any single rectangle, so they read
 * the model tier instead.
 */
const CONUS_DEGREES = Object.freeze([-125, 24, -66.5, 50]);

/**
 * Precedence stack, painted in order — later entries sit above earlier ones.
 *
 * The model is continuous at every zoom and the radar inlay lies on top of it
 * inside its own footprint. An earlier revision punched a matching cutout in
 * the model so only one source could ever paint a pixel; in use that was the
 * worse trade, because the cutout's straight edges read as precipitation being
 * sliced away wherever they crossed populated coast (its 24°N edge runs just
 * south of Miami) and it left holes anywhere radar was silent. Letting the
 * model carry underneath costs a modelled field showing through a radar-clear
 * area — mild, and the row already says the base layer is a model.
 */
export const PRECIPITATION_TIERS = Object.freeze([
  Object.freeze({
    id: 'gdps-global',
    role: 'primary',
    label: 'ECCC GDPS',
    origin: GEOMET_ORIGIN,
    service: `${GEOMET_ORIGIN}/geomet`,
    wmsLayer: 'GDPS_15km_PrecipRate',
    frameKey: `${GEOMET_ORIGIN}/geomet|GDPS_15km_PrecipRate`,
    // A model field valid now, never an observation of now. getStats() reports
    // the run and the resulting forecast lead so the row cannot imply otherwise.
    forecast: true,
    // Light enough to read the basemap underneath: this is context laid over
    // terrain, not a replacement for it.
    alpha: 0.5,
    rectangleDegrees: null,
    edgeFadeDegrees: 0,
    minimumTerrainLevel: undefined,
    maximumTerrainLevel: undefined,
  }),
  Object.freeze({
    id: 'mrms-conus',
    role: 'inlay',
    label: 'NOAA MRMS',
    inlayLabel: 'US RADAR',
    origin: NOWCOAST_ORIGIN,
    service: `${NOWCOAST_ORIGIN}/geoserver/observations/weather_radar/ows`,
    wmsLayer: 'base_reflectivity_mosaic',
    frameKey: `${NOWCOAST_ORIGIN}/geoserver/observations/weather_radar/ows|base_reflectivity_mosaic`,
    forecast: false,
    alpha: 0.72,
    rectangleDegrees: CONUS_DEGREES,
    // Dissolve into the model over the outer edge of the footprint instead of
    // ending on a straight line. Cesium evaluates layer alpha per tile, so the
    // ramp is tile-quantised — fine at the zooms where the inlay is visible.
    edgeFadeDegrees: 2.5,
    minimumTerrainLevel: INLAY_HANDOVER_LEVEL,
    maximumTerrainLevel: undefined,
  }),
]);
