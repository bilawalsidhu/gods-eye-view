import {
  DEFAULT_REFRESH_MS,
  MAX_TILE_ZOOM,
  MIN_REFRESH_MS,
} from '../../data/xweatherTiles.js';

/** Registered layer id; also its share-link identity. */
export const LAYER_ID = 'precipitation';

/**
 * Same-origin tile route. The credentials never appear here — the vendor puts
 * both halves in the upstream URL path, so `/api/xweather` builds that server
 * side and this template is all the browser ever sees.
 */
export const TILE_URL_TEMPLATE = '/api/xweather/radar/{z}/{x}/{y}.png';

/** Where the layer asks whether a key is configured, and how often to refresh. */
export const STATUS_URL = '/api/xweather/status';

/**
 * Provider branch a tier dispatches to.
 *
 * Only `xyz` now. The WMS branch went with the free model and radar services
 * it existed for; if a WMS source ever returns, the branch returns with it
 * rather than sitting here unused.
 */
export const TIER_KINDS = Object.freeze(['xyz']);

/**
 * How a tier learns which frame to draw. `live` means the service always
 * serves its current composite and publishes no time to pin, so the row says
 * LIVE rather than inventing a stamp.
 */
export const FRAME_MODES = Object.freeze(['live']);

/** The count slot: an imagery layer counts nothing, and this is an observation. */
export const OBSERVED_LABEL = 'LIVE';

/**
 * Manager tick. Deliberately the floor rather than the refresh cadence: the
 * real cadence comes from the server so it can be retuned without a rebuild,
 * and the per-tier gating below decides whether a tick does any work. A tick
 * with nothing due is a clock comparison.
 */
export const LAYER_TICK_MS = MIN_REFRESH_MS;

/** Used until `/status` answers with the configured cadence. */
export const FALLBACK_REFRESH_MS = DEFAULT_REFRESH_MS;

/**
 * One observed source, drawn at every zoom.
 *
 * What was here before was four placements of two forecast models and a
 * regional radar, tiled across the globe by hand-derived rectangle covers so
 * that exactly one of them painted any point. All of that existed to make free
 * sources cover the planet between them, and none of it fixed the thing that
 * actually made the layer wrong: a twice-daily global model is a +3h to +15h
 * forecast, and a forecast half a day old does not agree with live radar about
 * where the rain is.
 *
 * Xweather's `radar-global` is a single observation — ground radar with
 * satellite-derived fill where no radar reaches — so the covers, the cutouts,
 * the partition rule and the capabilities parsing all go with it. The seam
 * that remains is the vendor's: radar and satellite fill do not look alike,
 * and the join shows where a network ends.
 */
export const PRECIPITATION_TIERS = Object.freeze([
  Object.freeze({
    id: 'xweather-radar',
    role: 'primary',
    // Paint order, kept because the imagery stack still orders by it and the
    // map controller's base map must stay underneath.
    rung: 1,
    kind: 'xyz',
    label: 'Vaisala Xweather',
    frameMode: 'live',
    capsKey: STATUS_URL,
    tileUrlTemplate: TILE_URL_TEMPLATE,
    // An observation, never a forecast. Nothing on the row may imply otherwise.
    forecast: false,
    // Heavy enough to read as the subject, light enough to keep the terrain
    // legible underneath — the value the radar inlay used before this.
    alpha: 0.68,
    refreshMs: DEFAULT_REFRESH_MS,
    maxTileLevel: MAX_TILE_ZOOM,
  }),
]);
