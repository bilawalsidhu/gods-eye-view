import {
  DEFAULT_REFRESH_MS,
  MIN_REFRESH_MS,
} from '../../data/xweatherTiles.js';
import {
  FIELD,
  OVERLAY,
  XWEATHER_LAYERS,
  defaultLayerCodes,
  layerByCode,
} from '../../data/xweatherCatalogue.js';

/** Registered layer id, and its identity in the layer-state registry. */
export const LAYER_ID = 'weather';

/** Name shown on the layer row. */
export const LAYER_NAME = 'Weather';

/**
 * Same-origin tile route. Credentials never appear here — the vendor puts both
 * halves in the upstream URL path, so `/api/xweather` builds that server-side
 * and this template is all the browser ever sees.
 */
export const tileUrlTemplate = (layer) =>
  `/api/xweather/tile/${layer}/{z}/{x}/{y}.png`;

/** Where the layer asks whether a key is configured, and how often to refresh. */
export const STATUS_URL = '/api/xweather/status';

/** Provider branch a spec dispatches to. Everything here is XYZ tiles. */
export const SPEC_KINDS = Object.freeze(['xyz']);

/**
 * How a spec learns which frame to draw. `live` means the service always
 * serves its current composite and publishes no time to pin.
 */
export const FRAME_MODES = Object.freeze(['live']);

/**
 * Manager tick. Deliberately the floor rather than the refresh cadence: the
 * manager arms one timer at enable and has no re-arm path, so a fast fixed
 * tick plus the gate in `index.js` is the only way to get a cadence that can
 * change at runtime. A tick with nothing due is a clock comparison.
 */
export const LAYER_TICK_MS = MIN_REFRESH_MS;

/** Used until `/status` answers with the configured cadence. */
export const FALLBACK_REFRESH_MS = DEFAULT_REFRESH_MS;

/** Auto-refresh intervals the panel offers, and the share-link code for each. */
export const REFRESH_CHOICES = Object.freeze([
  Object.freeze({ code: 'q', label: '15 min', ms: 15 * 60 * 1000 }),
  Object.freeze({ code: 'h', label: '1 hour', ms: 60 * 60 * 1000 }),
  Object.freeze({ code: 's', label: '6 hours', ms: 6 * 60 * 60 * 1000 }),
  Object.freeze({ code: 'd', label: '24 hours', ms: 24 * 60 * 60 * 1000 }),
]);

/** The interval a fresh install auto-refreshes at, if it ever switches it on. */
export const DEFAULT_REFRESH_CHOICE = 'd';

/**
 * Every drawable spec, derived from the shared catalogue.
 *
 * One spec per Xweather layer, all of them dormant until the Weather panel
 * says otherwise: `index.js` polls and draws only the active set, so a spec
 * sitting here costs nothing. That is the whole economy of the feature —
 * offering a layer is free, enabling one is what spends the quota, because
 * every enabled layer multiplies every camera move.
 *
 * Fields sit at a lower rung than overlays so a temperature field can never
 * bury the lightning drawn over it.
 */
export const WEATHER_LAYER_SPECS = Object.freeze(
  XWEATHER_LAYERS.map((entry) =>
    Object.freeze({
      id: entry.layer,
      code: entry.code,
      group: entry.group,
      defaultOn: entry.defaultOn,
      rung: entry.rung,
      kind: 'xyz',
      label: entry.label,
      detail: entry.detail,
      cadence: entry.cadence,
      coverage: entry.coverage,
      frameMode: 'live',
      // Every spec reads the same status endpoint, so one read serves them all.
      capsKey: STATUS_URL,
      tileUrlTemplate: tileUrlTemplate(entry.layer),
      forecast: entry.forecast,
      alpha: entry.alpha,
      refreshMs: DEFAULT_REFRESH_MS,
      maxTileLevel: entry.maxZoom,
    }),
  ),
);

/** Tier lookup by the id the imagery stack keys on. */
const TIERS_BY_ID = new Map(WEATHER_LAYER_SPECS.map((spec) => [spec.id, spec]));

export function layerSpecById(id) {
  return TIERS_BY_ID.get(String(id ?? '')) || null;
}

/**
 * Selection codec.
 *
 * The selection travels as a string of one-character codes because that is how
 * it is persisted — one packed field in the share link rather than a token per
 * layer. Keeping the same representation here means the panel, the layer and
 * the URL all speak it, with no third form to keep in step.
 */
export function codesToIds(codes) {
  const out = [];
  for (const code of String(codes ?? '')) {
    const entry = layerByCode(code);
    // An unknown code is dropped rather than rejected: a link from a build
    // that offers a layer this one does not should lose that layer, not fail.
    if (entry && !out.includes(entry.layer)) out.push(entry.layer);
  }
  return out;
}

export function idsToCodes(ids) {
  const byId = new Map(WEATHER_LAYER_SPECS.map((spec) => [spec.id, spec.code]));
  return [...new Set(ids ?? [])]
    .map((id) => byId.get(id))
    .filter(Boolean)
    .join('');
}

/** The specs drawn before anyone opens the panel. */
export function defaultActiveIds() {
  return codesToIds(defaultLayerCodes().join(''));
}

/** The same, as the packed string the share link and panel exchange. */
export function defaultActiveCodes() {
  return defaultLayerCodes().join('');
}

export { FIELD, OVERLAY };
