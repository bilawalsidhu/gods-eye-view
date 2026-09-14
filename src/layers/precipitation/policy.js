/** Registered layer id; also its share-link identity. */
export const LAYER_ID = 'precipitation';

/**
 * GeoMet steps hourly and reruns GDPS twice a day, so a shorter poll cannot
 * surface a newer model frame — it would only re-download the visible globe
 * against an origin that forbids caching.
 */
export const MODEL_REFRESH_MS = 60 * 60 * 1000;

/**
 * Radar turns over every few minutes, so it must not inherit the model's hourly
 * tick: each tier carries its own cadence and the layer polls at the shortest.
 */
export const RADAR_REFRESH_MS = 5 * 60 * 1000;

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

/**
 * Deepest level GeoMet still answers with data. Below roughly a 20 km bbox —
 * level 10 and under — it returns a transparent tile, so the detail placement
 * requests no deeper than this and Cesium magnifies past it.
 */
export const MODEL_REQUEST_CEILING = 8;

/**
 * Provider branch a tier dispatches to.
 *
 * Everything reachable by WMS is `wms`. `xyz` exists for a service that
 * publishes tiles and no WMS endpoint at all, which needs a different Cesium
 * provider and a different way of discovering its current frame.
 */
export const TIER_KINDS = Object.freeze(['wms', 'xyz']);

/**
 * How a tier learns which frame to draw.
 *
 * `dimension` reads the server's own default step out of GetCapabilities and
 * pins it into every tile request. `live` is for a service that publishes no
 * time dimension at all and always answers with the current composite — there
 * is nothing to read, and the row says LIVE rather than inventing a stamp.
 */
export const FRAME_MODES = Object.freeze(['dimension', 'live']);

/** The only hosts this layer ever contacts. */
export const GEOMET_ORIGIN = 'https://geo.weather.gc.ca';
export const IEM_ORIGIN = 'https://mesonet.agron.iastate.edu';

/**
 * The NEXRAD composite is densest over the lower 48; this box hugs that rather
 * than the service's full advertised extent. Alaska, Hawaii, the Caribbean and
 * Guam are also in the composite but sit far outside any single rectangle, so
 * they read the model tier instead.
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
    // Paint order. Coarser sources sit beneath finer ones; a tier re-applying
    // on its own cadence is reinserted at its rung, never on top of the stack.
    rung: 1,
    kind: 'wms',
    label: 'ECCC GDPS',
    origin: GEOMET_ORIGIN,
    service: `${GEOMET_ORIGIN}/geomet`,
    wmsLayer: 'GDPS_15km_PrecipRate',
    // GeoMet's default palette buckets the field into eight classes, so
    // neighbouring 15 km cells of similar value merge into one flat plateau and
    // the field reads as ~42 km squares. The linear ramp renders 714 distinct
    // colours over the same extent and the apparent structure drops to ~18 km,
    // which is the native grid.
    wmsStyle: 'PRECIPPRTMMH-LINEAR',
    frameMode: 'dimension',
    // Dedupe key for the capabilities read. Placements resolving to the same
    // key cost one request between them.
    capsKey: `${GEOMET_ORIGIN}/geomet|GDPS_15km_PrecipRate`,
    // A model field valid now, never an observation of now. getStats() reports
    // the run and the resulting forecast lead so the row cannot imply otherwise.
    forecast: true,
    // Light enough to read the basemap underneath: this is context laid over
    // terrain, not a replacement for it.
    alpha: 0.42,
    rectanglesDegrees: null,
    cutoutRectangleDegrees: null,
    refreshMs: MODEL_REFRESH_MS,
    maxTileLevel: MODEL_DETAIL_CEILING,
    minimumTerrainLevel: undefined,
    maximumTerrainLevel: MODEL_DETAIL_CEILING,
  }),
  Object.freeze({
    id: 'gdps-detail',
    role: 'detail',
    rung: 1,
    kind: 'wms',
    label: 'ECCC GDPS',
    origin: GEOMET_ORIGIN,
    service: `${GEOMET_ORIGIN}/geomet`,
    wmsLayer: 'GDPS_15km_PrecipRate',
    wmsStyle: 'PRECIPPRTMMH-LINEAR',
    frameMode: 'dimension',
    // Same service and layer as the wide placement, so one capabilities read
    // covers both.
    capsKey: `${GEOMET_ORIGIN}/geomet|GDPS_15km_PrecipRate`,
    forecast: true,
    alpha: 0.42,
    rectanglesDegrees: null,
    // Yield only where radar actually replaces it. Everywhere else the model
    // keeps drawing as the camera descends: a coarse field beats none, and the
    // linear palette keeps its cells near the native 15 km rather than 42 km.
    cutoutRectangleDegrees: CONUS_DEGREES,
    refreshMs: MODEL_REFRESH_MS,
    maxTileLevel: MODEL_REQUEST_CEILING,
    minimumTerrainLevel: INLAY_HANDOVER_LEVEL,
    maximumTerrainLevel: undefined,
  }),
  Object.freeze({
    id: 'nexrad-conus',
    role: 'inlay',
    rung: 4,
    kind: 'wms',
    label: 'IEM NEXRAD',
    inlayLabel: 'US RADAR',
    origin: IEM_ORIGIN,
    service: `${IEM_ORIGIN}/cgi-bin/wms/nexrad/n0q.cgi`,
    // IEM's CONUS composite of NWS WSR-88D level III base reflectivity. It
    // applies far less quality-control masking than the MRMS mosaic, so it does
    // not punch squares out of live cells — at the cost of carrying more ground
    // clutter and anomalous propagation.
    wmsLayer: 'nexrad-n0q-conus',
    wmsStyle: null,
    // No time dimension is advertised at all: the service always serves the
    // current composite, and the row says LIVE rather than claiming a step.
    frameMode: 'live',
    capsKey: `${IEM_ORIGIN}/cgi-bin/wms/nexrad/n0q.cgi|nexrad-n0q-conus`,
    forecast: false,
    alpha: 0.68,
    rectanglesDegrees: Object.freeze([CONUS_DEGREES]),
    cutoutRectangleDegrees: null,
    refreshMs: RADAR_REFRESH_MS,
    maxTileLevel: RADAR_DETAIL_CEILING,
    minimumTerrainLevel: INLAY_HANDOVER_LEVEL,
    maximumTerrainLevel: undefined,
  }),
]);
