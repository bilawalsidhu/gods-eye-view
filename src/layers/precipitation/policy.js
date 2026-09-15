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
 * The rest of the NEXRAD network, which `nexrad-n0q` carries and the CONUS-only
 * layer did not: Alaska, Hawaii and Puerto Rico. None of them can share a
 * rectangle with the lower 48 or with each other, which is what kept them out
 * until a tier could hold a cover.
 *
 * Generous boxes on purpose. Radar range is a disc around each site and these
 * are far sparser networks than the lower 48 — Alaska has eight radars for a
 * region the size of western Europe — so most of each box is out of range. An
 * out-of-range tile is transparent and the model underneath shows through,
 * which is the same thing that happens on a clear day.
 */
const ALASKA_DEGREES = Object.freeze([-168, 51, -130, 72]);
const HAWAII_DEGREES = Object.freeze([-161, 18, -154, 23]);
const PUERTO_RICO_DEGREES = Object.freeze([-68, 16.5, -64, 19.5]);

/** Everywhere the US radar composite reaches, coarsest region first. */
const RADAR_DEGREES = Object.freeze([
  CONUS_DEGREES,
  ALASKA_DEGREES,
  HAWAII_DEGREES,
  PUERTO_RICO_DEGREES,
]);

/**
 * Where RDPS actually has data.
 *
 * Its advertised bounding box is the whole northern hemisphere, which is the
 * envelope of a rotated grid rather than its domain — believing it would put
 * empty tiles over most of the planet. The real footprint was mapped by
 * probing `RDPS_10km_AirTemp_2m`, a field that is never blank where the model
 * runs: a cap centred on North America that reaches the equator over the
 * Americas, crosses the Atlantic into northern Europe above about 42N, goes
 * circumpolar above 75N, and comes back down the far side over the Bering
 * Sea. Southern Europe and the Mediterranean are outside it; so are Africa,
 * Asia south of the Arctic, and everything below the equator.
 *
 * Four rectangles, deliberately disjoint — two placements of one tier
 * overlapping would composite their alpha twice and read as a bright patch.
 */
const RDPS_DEGREES = Object.freeze([
  Object.freeze([-180, 5, -38, 75]), // the Americas
  Object.freeze([-38, 42, 45, 75]), // North Atlantic into northern Europe
  Object.freeze([-180, 75, 180, 90]), // the circumpolar cap
  Object.freeze([118, 42, 180, 75]), // Bering Sea and the Russian far east
]);

/**
 * Exactly the globe RDPS does not cover, so the two models tile the planet
 * between them without ever painting the same point twice.
 *
 * Two semi-transparent models of the same phenomenon stacked on one another
 * would composite to a stronger field inside the finer one's domain than
 * outside it, drawing a seam along the domain edge that says nothing about the
 * weather. Deriving the complement instead keeps the rule the layer already
 * holds: one source paints any point.
 */
const GDPS_DETAIL_DEGREES = Object.freeze([
  Object.freeze([-180, -90, 180, 5]), // everything below the RDPS cap
  Object.freeze([-38, 5, 180, 42]), // Africa, southern Europe, Asia, Oceania
  Object.freeze([45, 42, 118, 75]), // central Asia, between the two lobes
]);

/**
 * Precedence stack, painted in order — later entries sit above earlier ones.
 *
 * Two rules, and they are not the same rule.
 *
 * The models partition the planet: exactly one of them paints any point, with
 * the regional model taking its domain and the global model the complement.
 * Two models of one phenomenon must never stack, because they would composite
 * to a stronger field inside the finer domain than outside it and draw a seam
 * that says nothing about the weather.
 *
 * Observations lie on top, at most one deep. Here a model does show through
 * wherever the observation is transparent — and that is a real cost, because
 * these services draw "no data" and "no precipitation" identically, so a
 * radar's observed-dry becomes the model's predicted-wet. It is paid because
 * the alternative does not scale: cutting every observed footprint out of the
 * models exactly costs 29 imagery layers at this size and cannot express a
 * satellite disc at all. Cesium allows one cutout per layer, so the one cutout
 * available goes where it buys the most — the lower 48, by far the densest
 * radar coverage and the most-looked-at ground on the map.
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
    // The same alpha as every other model placement. These covers are
    // exclusive, so a difference here could not read as a finer source — only
    // as a brightness step along an invisible domain edge.
    alpha: 0.42,
    // Everywhere the regional model does not reach. The model keeps drawing as
    // the camera descends rather than leaving the view blank: a coarse field
    // beats none, and the linear palette keeps its cells near the native 15 km
    // rather than 42 km.
    rectanglesDegrees: GDPS_DETAIL_DEGREES,
    // None needed: the radar footprint sits inside the RDPS domain, which this
    // cover already excludes.
    cutoutRectangleDegrees: null,
    refreshMs: MODEL_REFRESH_MS,
    maxTileLevel: MODEL_REQUEST_CEILING,
    minimumTerrainLevel: INLAY_HANDOVER_LEVEL,
    maximumTerrainLevel: undefined,
  }),
  Object.freeze({
    id: 'rdps-regional',
    role: 'detail',
    // Above the global model and below radar: 10 km where it reaches, and it
    // reaches a great deal of ground radar never will — the Canadian north,
    // the north Atlantic, Scandinavia, the Arctic.
    rung: 2,
    kind: 'wms',
    label: 'ECCC RDPS',
    origin: GEOMET_ORIGIN,
    service: `${GEOMET_ORIGIN}/geomet`,
    wmsLayer: 'RDPS_10km_PrecipRate',
    // The same continuous ramp the global model uses; the classed default
    // would collapse a 10 km field into the same flat plateaus.
    wmsStyle: 'PRECIPPRTMMH-LINEAR',
    frameMode: 'dimension',
    capsKey: `${GEOMET_ORIGIN}/geomet|RDPS_10km_PrecipRate`,
    forecast: true,
    alpha: 0.42,
    rectanglesDegrees: RDPS_DEGREES,
    // Radar owns the lower 48, and it sits well inside the first rectangle of
    // this cover. The other three do not reach it, so one cutout serves.
    cutoutRectangleDegrees: CONUS_DEGREES,
    refreshMs: MODEL_REFRESH_MS,
    // Unlike the global model, RDPS answers with real data past level 12 — but
    // a 10 km field has nothing left to say by then, so it stops where the
    // global model does and Cesium magnifies from there.
    maxTileLevel: MODEL_REQUEST_CEILING,
    minimumTerrainLevel: INLAY_HANDOVER_LEVEL,
    maximumTerrainLevel: undefined,
  }),
  Object.freeze({
    id: 'nexrad-us',
    role: 'inlay',
    rung: 4,
    kind: 'wms',
    label: 'IEM NEXRAD',
    inlayLabel: 'US RADAR',
    origin: IEM_ORIGIN,
    service: `${IEM_ORIGIN}/cgi-bin/wms/nexrad/n0q.cgi`,
    // IEM's composite of NWS WSR-88D level III base reflectivity. It applies
    // far less quality-control masking than the MRMS mosaic, so it does not
    // punch squares out of live cells — at the cost of carrying more ground
    // clutter and anomalous propagation.
    //
    // `nexrad-n0q` rather than `nexrad-n0q-conus`: byte-for-byte the same
    // composite over the lower 48, and it also answers over Alaska, Hawaii and
    // Puerto Rico, which the CONUS layer returns empty for. Neither name is
    // advertised in the service's capabilities — only the `-900913` and
    // per-region variants are — so both were confirmed by fetching tiles.
    wmsLayer: 'nexrad-n0q',
    wmsStyle: null,
    // No time dimension is advertised at all: the service always serves the
    // current composite, and the row says LIVE rather than claiming a step.
    frameMode: 'live',
    capsKey: `${IEM_ORIGIN}/cgi-bin/wms/nexrad/n0q.cgi|nexrad-n0q`,
    forecast: false,
    alpha: 0.68,
    rectanglesDegrees: RADAR_DEGREES,
    cutoutRectangleDegrees: null,
    refreshMs: RADAR_REFRESH_MS,
    maxTileLevel: RADAR_DETAIL_CEILING,
    minimumTerrainLevel: INLAY_HANDOVER_LEVEL,
    maximumTerrainLevel: undefined,
  }),
]);
