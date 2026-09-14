/** Registered layer id; also its share-link identity. */
export const LAYER_ID = 'precipitation';

/**
 * GeoMet steps hourly and reruns GDPS twice a day, so a shorter poll cannot
 * surface a newer frame — it would only re-download the visible globe against
 * origins that forbid caching. The radar inlay refreshes on the same tick.
 */
export const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Tile level past which the model stops being drawn.
 *
 * GeoMet renders GDPS in roughly 42 km blocks on the ground whatever pixel size
 * is requested, so the field reads as visible squares once the camera drops
 * below about 6,000 km — which is exactly where level 4 first appears. Past
 * here the radar inlay carries the detail. Requesting deeper is pointless too:
 * the model is never drawn there, and GeoMet answers a bbox under roughly 20 km
 * with an empty tile.
 */
export const MODEL_DETAIL_CEILING = 3;

/**
 * Tile level where the radar inlay takes over, derived so the two bands cannot
 * overlap: exactly one tier is drawn at any level. Cesium owns the handover
 * through min/maximumTerrainLevel, so this stays a threshold rather than a
 * state machine and no camera listener runs.
 */
export const INLAY_HANDOVER_LEVEL = MODEL_DETAIL_CEILING + 1;

/** Radar is 1 km; level 11 (~76 m/px) is already far past its resolution. */
export const RADAR_DETAIL_CEILING = 11;

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
    alpha: 0.42,
    rectangleDegrees: null,
    // Stop requesting tiles GeoMet answers empty; Cesium upsamples instead.
    maxTileLevel: MODEL_DETAIL_CEILING,
    minimumTerrainLevel: undefined,
    maximumTerrainLevel: MODEL_DETAIL_CEILING,
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
    alpha: 0.68,
    rectangleDegrees: CONUS_DEGREES,
    maxTileLevel: RADAR_DETAIL_CEILING,
    // The footprint ends on a straight boundary. Cesium exposes no per-pixel or
    // per-tile alpha for imagery layers, so there is nothing to feather with;
    // the continuous model underneath is what keeps the edge from reading as a
    // hole. See the ownership test pinning alpha to a number.
    minimumTerrainLevel: INLAY_HANDOVER_LEVEL,
    maximumTerrainLevel: undefined,
  }),
]);
