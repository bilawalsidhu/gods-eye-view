/**
 * @file The Xweather layers this app is willing to draw, and what each one is.
 *
 * One source of truth for three consumers that must never disagree: the
 * `/api/xweather` proxy derives its allowlist from here (a layer name arriving
 * from the browser is checked against it, never proxied on trust), the
 * weather layer builds its spec table from it, and the Weather panel
 * takes its labels and grouping from it.
 *
 * Zero dependencies and Cesium-free so the server, the layer and node:test can
 * all import it.
 *
 * ## Why these layers and not the other eighty
 *
 * Every entry costs one token per tile. That is not true of the whole
 * catalogue, and the published rate card is not a safe guide to which — it was
 * measured. `lightning-strikes` and the `lightning-all` family bill at 10x
 * while `lightning-flash` bills at 1x and covers *more* (intracloud as well as
 * cloud-to-ground); the air-quality pollutant species and the regional index
 * variants bill at 5x while the plain index and its banded form bill at 1x.
 * The surcharged twin is excluded in every case because the cheap one is as
 * good or better, never as a compromise.
 *
 * The satellite imagery layers are excluded for a different reason: they are
 * complete Earth renderings, land and ocean and terrain included, so they
 * duplicate the base map rather than overlaying it. They belong in the map
 * stack, not here.
 *
 * @module data/xweatherCatalogue
 */

import {
  SAMPLED_MAX_TILE_ZOOM,
  SYMBOL_MAX_TILE_ZOOM,
} from './xweatherTiles.js';

/**
 * Continuous fields paint every pixel of every tile — measured at 24-160 KB
 * against an overlay's 116 bytes. Stacking two of them shows only the top one,
 * so the panel allows exactly one at a time and draws it under the overlays.
 */
export const FIELD = 'field';

/** Sparse, mostly transparent, and safe to stack as deep as you like. */
export const OVERLAY = 'overlay';

/** Paint order. Fields sit beneath every overlay; radar sits beneath the rest. */
const FIELD_RUNG = 1;
const RADAR_RUNG = 4;
const OVERLAY_RUNG = 6;

/**
 * How deep each layer is worth asking for.
 *
 * Radar and the continuous fields are sampled rasters and run out of real
 * resolution; the symbol layers are redrawn at every level and do not. See
 * the two constants for the measurements behind each.
 */
const SAMPLED = SAMPLED_MAX_TILE_ZOOM;
const SYMBOLS = SYMBOL_MAX_TILE_ZOOM;

/** Fields are laid over terrain, so they yield enough of it to stay legible. */
const FIELD_ALPHA = 0.55;

/**
 * Where a layer actually has data, for the layers that do not have it
 * everywhere.
 *
 * A layer that draws nothing over Europe because its source stops at the
 * border is indistinguishable, on screen, from one that is broken. So the
 * panel marks it: `tag` goes on the chip where it is read at a glance, `note`
 * goes in the hover text where there is room to be exact.
 *
 * These are measured, not taken from the vendor's description. `null` means
 * global.
 */
const UNITED_STATES = Object.freeze({
  tag: 'US',
  note: 'United States only',
});
const NORTH_AMERICA = Object.freeze({
  tag: 'N.AM',
  note: 'North America only — the contiguous United States, southern Canada and northern Mexico',
});

/**
 * Every drawable layer.
 *
 * `code` is the layer's identity in a share link and is **frozen once
 * shipped** — changing one silently repoints every URL in the wild. Codes are
 * assigned in no particular order for that reason: they are opaque handles,
 * not an encoding of the list's current shape.
 */
export const XWEATHER_LAYERS = Object.freeze(
  [
    // ── observed, sparse: the reason this panel exists ───────────────────
    {
      code: 'r',
      layer: 'radar-global',
      group: OVERLAY,
      rung: RADAR_RUNG,
      label: 'Radar',
      detail: 'Global radar, satellite-filled where no radar reaches',
      cadence: 'every 2 min',
      alpha: 0.68,
      defaultOn: true,
    },
    {
      code: 'l',
      layer: 'lightning-flash',
      maxZoom: SYMBOLS,
      group: OVERLAY,
      label: 'Lightning',
      detail: 'Cloud-to-ground and intracloud flashes',
      cadence: 'every 5 min',
    },
    {
      code: 'a',
      layer: 'alerts',
      maxZoom: SYMBOLS,
      group: OVERLAY,
      label: 'Warnings',
      detail: 'Active alerts: US, Canada, Europe, Australia, Japan, Korea',
      cadence: 'every 2 min',
    },
    {
      code: 'd',
      layer: 'wind-dir',
      maxZoom: SYMBOLS,
      group: OVERLAY,
      label: 'Wind arrows',
      detail: 'Surface wind direction',
      cadence: 'every 30 min',
    },
    {
      code: 'i',
      layer: 'fpressure-msl-isobars',
      maxZoom: SYMBOLS,
      group: OVERLAY,
      label: 'Isobars',
      detail: 'Forecast sea-level pressure',
      cadence: 'every 1-6 hr',
    },

    // ── tropical cyclones: four composable pieces of one storm ───────────
    {
      code: 'c',
      layer: 'tropical-cyclones',
      maxZoom: SYMBOLS,
      group: OVERLAY,
      label: 'Cyclones',
      detail: 'Active storms with a five-day forecast',
      cadence: 'every 1-6 hr',
    },
    {
      code: 'k',
      layer: 'tropical-cyclones-track-lines',
      maxZoom: SYMBOLS,
      group: OVERLAY,
      label: 'Cyclone tracks',
      detail: 'Where each storm has already been',
      cadence: 'every 1-6 hr',
    },
    {
      code: 'p',
      layer: 'tropical-cyclones-position-icons',
      maxZoom: SYMBOLS,
      group: OVERLAY,
      label: 'Cyclone positions',
      detail: 'Current centre and intensity',
      cadence: 'every 1-6 hr',
    },
    {
      code: 'e',
      layer: 'tropical-cyclones-forecast-error-cones',
      maxZoom: SYMBOLS,
      group: OVERLAY,
      label: 'Cyclone cone',
      detail: 'Forecast track uncertainty',
      cadence: 'every 1-6 hr',
    },

    // ── not global: the chip says so, and these sort last so the layers
    //    that work anywhere are the ones reached first ──────────────────
    {
      code: 'n',
      layer: 'surface-analysis',
      maxZoom: SYMBOLS,
      group: OVERLAY,
      label: 'Fronts',
      detail: 'Frontal and pressure analysis',
      cadence: 'every 12 hr',
      coverage: NORTH_AMERICA,
    },
    {
      code: 's',
      layer: 'stormcells',
      maxZoom: SYMBOLS,
      group: OVERLAY,
      label: 'Storm cells',
      detail: 'Cell tracks with rotation and hail signatures',
      cadence: 'every 3 min',
      coverage: UNITED_STATES,
    },
    {
      code: 'o',
      layer: 'stormreports',
      maxZoom: SYMBOLS,
      group: OVERLAY,
      label: 'Storm reports',
      detail: 'Tornado, hail, wind and flood reports, last 24 hours',
      cadence: 'every 15 min',
      coverage: UNITED_STATES,
    },
    {
      code: 'v',
      layer: 'convective',
      maxZoom: SYMBOLS,
      group: OVERLAY,
      label: 'Severe outlook',
      detail: 'SPC convective outlook',
      cadence: 'as issued',
      coverage: UNITED_STATES,
    },
    {
      code: 'g',
      layer: 'drought-monitor',
      maxZoom: SYMBOLS,
      group: OVERLAY,
      label: 'Drought',
      detail: 'Drought severity',
      cadence: 'weekly',
      coverage: UNITED_STATES,
    },
    {
      code: 'b',
      layer: 'river-observations',
      maxZoom: SYMBOLS,
      group: OVERLAY,
      label: 'River gauges',
      detail: 'NOAA flood and low-flow thresholds',
      cadence: 'hourly',
      coverage: UNITED_STATES,
    },

    // ── continuous fields, one at a time ─────────────────────────────────
    {
      code: 't',
      layer: 'temperatures',
      group: FIELD,
      label: 'Temperature',
      detail: 'Surface air temperature',
      cadence: 'every 1 hr',
    },
    {
      code: 'f',
      layer: 'feels-like',
      group: FIELD,
      label: 'Feels like',
      detail: 'Apparent temperature',
      cadence: 'every 1 hr',
    },
    {
      code: 'w',
      layer: 'dew-points',
      group: FIELD,
      label: 'Dew point',
      detail: 'Moisture in the surface air',
      cadence: 'every 1 hr',
    },
    {
      code: 'h',
      layer: 'humidity',
      group: FIELD,
      label: 'Humidity',
      detail: 'Relative humidity',
      cadence: 'every 1 hr',
    },
    {
      code: 'x',
      layer: 'heat-index',
      group: FIELD,
      label: 'Heat index',
      // Empty below about 27C, so it reads as the summer hemisphere only.
      detail: 'Apparent heat where it is hot',
      cadence: 'every 1 hr',
    },
    {
      code: 'z',
      layer: 'wind-chill',
      group: FIELD,
      label: 'Wind chill',
      // The winter-hemisphere counterpart to heat index; between them the
      // globe is never blank, which is why both are offered.
      detail: 'Apparent cold where it is cold',
      cadence: 'every 1 hr',
    },
    {
      code: 'u',
      layer: 'wind-speeds',
      group: FIELD,
      label: 'Wind speed',
      detail: 'Surface wind speed',
      cadence: 'every 1 hr',
    },
    {
      code: 'j',
      layer: 'wind-gusts',
      group: FIELD,
      label: 'Wind gusts',
      detail: 'Surface gusts',
      cadence: 'every 1 hr',
    },
    {
      code: 'q',
      layer: 'air-quality-index-categories',
      group: FIELD,
      label: 'Air quality',
      detail: 'AQI banded good to hazardous',
      cadence: 'every 12 hr',
    },
    {
      code: 'm',
      layer: 'sst',
      group: FIELD,
      label: 'Sea surface temp',
      detail: 'Ocean surface temperature',
      cadence: 'daily',
    },
    {
      code: 'y',
      layer: 'maritime-wave-heights',
      group: FIELD,
      label: 'Wave height',
      detail: 'Primary wave height',
      cadence: 'every 6 hr',
    },
    {
      code: '2',
      layer: 'maritime-currents',
      group: FIELD,
      label: 'Ocean currents',
      detail: 'Surface current speed',
      cadence: 'every 6 hr',
    },
    {
      code: '3',
      layer: 'snow-depth',
      group: FIELD,
      label: 'Snow depth',
      detail: 'Estimated depth on the ground',
      cadence: 'daily',
    },
    {
      code: '4',
      layer: 'fqpf-accum',
      group: FIELD,
      label: 'Precip forecast',
      detail: 'Forecast accumulation',
      cadence: 'every 1-6 hr',
      forecast: true,
    },
    {
      code: '5',
      layer: 'fjet-stream',
      group: FIELD,
      label: 'Jet stream',
      detail: 'Forecast winds at 250 mb',
      cadence: 'every 1-6 hr',
      forecast: true,
    },
  ].map((entry) =>
    Object.freeze({
      rung: entry.group === FIELD ? FIELD_RUNG : OVERLAY_RUNG,
      alpha: entry.group === FIELD ? FIELD_ALPHA : 0.72,
      defaultOn: false,
      forecast: false,
      coverage: null,
      maxZoom: SAMPLED,
      ...entry,
    }),
  ),
);

/** Fast lookup by the layer name the vendor uses. */
const BY_LAYER = new Map(XWEATHER_LAYERS.map((entry) => [entry.layer, entry]));

/** Fast lookup by share-link code. */
const BY_CODE = new Map(XWEATHER_LAYERS.map((entry) => [entry.code, entry]));

/**
 * Is this a layer the proxy is willing to fetch?
 *
 * The browser supplies the layer name, so this is a security boundary and not
 * a convenience: without it the proxy would forward any string to Xweather,
 * including the 10x lightning products this app deliberately excludes.
 *
 * @param {string} layer - Vendor layer name from the request path.
 * @returns {boolean} True when the layer is in the catalogue.
 */
export function isAllowedLayer(layer) {
  return BY_LAYER.has(String(layer ?? ''));
}

/** The catalogue entry for a vendor layer name, or null. */
function layerByName(layer) {
  return BY_LAYER.get(String(layer ?? '')) || null;
}

/**
 * The deepest tile this layer is worth asking for.
 *
 * Falls back to the sampled ceiling for an unknown name so a bad request can
 * never widen what may be fetched; the allowlist has already refused it by the
 * time this is reached.
 *
 * @param {string} layer - Vendor layer name.
 * @returns {number} Zoom ceiling for that layer.
 */
export function layerMaxZoom(layer) {
  return layerByName(layer)?.maxZoom ?? SAMPLED_MAX_TILE_ZOOM;
}

/** The catalogue entry for a share-link code, or null. */
export function layerByCode(code) {
  return BY_CODE.get(String(code ?? '')) || null;
}

/** Codes of the layers drawn before anyone chooses anything. */
export function defaultLayerCodes() {
  return XWEATHER_LAYERS.filter((entry) => entry.defaultOn).map(
    (entry) => entry.code,
  );
}
