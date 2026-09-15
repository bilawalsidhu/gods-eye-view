/**
 * @file The Xweather layers this app is willing to draw, and what each one is.
 *
 * One source of truth for three consumers that must never disagree: the
 * `/api/xweather` proxy derives its allowlist from here (a layer name arriving
 * from the browser is checked against it, never proxied on trust), the
 * weather layer builds its tier table from it, and the Weather panel
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

/** Fields are laid over terrain, so they yield enough of it to stay legible. */
const FIELD_ALPHA = 0.55;

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
      cadence: '2 min',
      alpha: 0.68,
      defaultOn: true,
    },
    {
      code: 'l',
      layer: 'lightning-flash',
      group: OVERLAY,
      label: 'Lightning',
      detail: 'Cloud-to-ground and intracloud flashes',
      cadence: '5 min',
    },
    {
      code: 'a',
      layer: 'alerts',
      group: OVERLAY,
      label: 'Warnings',
      detail: 'Active alerts: US, Canada, Europe, Australia, Japan, Korea',
      cadence: '2 min',
    },
    {
      code: 'd',
      layer: 'wind-dir',
      group: OVERLAY,
      label: 'Wind arrows',
      detail: 'Surface wind direction',
      cadence: '30 min',
    },
    {
      code: 'i',
      layer: 'fpressure-msl-isobars',
      group: OVERLAY,
      label: 'Isobars',
      detail: 'Forecast sea-level pressure',
      cadence: '1-6 hr',
    },
    {
      code: 'n',
      layer: 'surface-analysis',
      group: OVERLAY,
      label: 'Fronts',
      detail: 'Frontal and pressure analysis',
      cadence: '12 hr',
      coverage: 'North America',
    },

    // ── tropical cyclones: four composable pieces of one storm ───────────
    {
      code: 'c',
      layer: 'tropical-cyclones',
      group: OVERLAY,
      label: 'Cyclones',
      detail: 'Active storms with a five-day forecast',
      cadence: '1-6 hr',
    },
    {
      code: 'k',
      layer: 'tropical-cyclones-track-lines',
      group: OVERLAY,
      label: 'Cyclone tracks',
      detail: 'Where each storm has already been',
      cadence: '1-6 hr',
    },
    {
      code: 'p',
      layer: 'tropical-cyclones-position-icons',
      group: OVERLAY,
      label: 'Cyclone positions',
      detail: 'Current centre and intensity',
      cadence: '1-6 hr',
    },
    {
      code: 'e',
      layer: 'tropical-cyclones-forecast-error-cones',
      group: OVERLAY,
      label: 'Cyclone cone',
      detail: 'Forecast track uncertainty',
      cadence: '1-6 hr',
    },

    // ── United States only ───────────────────────────────────────────────
    {
      code: 's',
      layer: 'stormcells',
      group: OVERLAY,
      label: 'Storm cells',
      detail: 'Cell tracks with rotation and hail signatures',
      cadence: '3 min',
      usOnly: true,
    },
    {
      code: 'o',
      layer: 'stormreports',
      group: OVERLAY,
      label: 'Storm reports',
      detail: 'Tornado, hail, wind and flood reports, last 24 hours',
      cadence: '15 min',
      usOnly: true,
    },
    {
      code: 'v',
      layer: 'convective',
      group: OVERLAY,
      label: 'Severe outlook',
      detail: 'SPC convective outlook',
      cadence: 'As issued',
      usOnly: true,
    },
    {
      code: 'g',
      layer: 'drought-monitor',
      group: OVERLAY,
      label: 'Drought',
      detail: 'Drought severity',
      cadence: 'Weekly',
      usOnly: true,
    },
    {
      code: 'b',
      layer: 'river-observations',
      group: OVERLAY,
      label: 'River gauges',
      detail: 'NOAA flood and low-flow thresholds',
      cadence: 'Hourly',
      usOnly: true,
    },

    // ── continuous fields, one at a time ─────────────────────────────────
    {
      code: 't',
      layer: 'temperatures',
      group: FIELD,
      label: 'Temperature',
      detail: 'Surface air temperature',
      cadence: '1 hr',
    },
    {
      code: 'f',
      layer: 'feels-like',
      group: FIELD,
      label: 'Feels like',
      detail: 'Apparent temperature',
      cadence: '1 hr',
    },
    {
      code: 'w',
      layer: 'dew-points',
      group: FIELD,
      label: 'Dew point',
      detail: 'Moisture in the surface air',
      cadence: '1 hr',
    },
    {
      code: 'h',
      layer: 'humidity',
      group: FIELD,
      label: 'Humidity',
      detail: 'Relative humidity',
      cadence: '1 hr',
    },
    {
      code: 'x',
      layer: 'heat-index',
      group: FIELD,
      label: 'Heat index',
      // Empty below about 27C, so it reads as the summer hemisphere only.
      detail: 'Apparent heat where it is hot',
      cadence: '1 hr',
    },
    {
      code: 'z',
      layer: 'wind-chill',
      group: FIELD,
      label: 'Wind chill',
      // The winter-hemisphere counterpart to heat index; between them the
      // globe is never blank, which is why both are offered.
      detail: 'Apparent cold where it is cold',
      cadence: '1 hr',
    },
    {
      code: 'u',
      layer: 'wind-speeds',
      group: FIELD,
      label: 'Wind speed',
      detail: 'Surface wind speed',
      cadence: '1 hr',
    },
    {
      code: 'j',
      layer: 'wind-gusts',
      group: FIELD,
      label: 'Wind gusts',
      detail: 'Surface gusts',
      cadence: '1 hr',
    },
    {
      code: 'q',
      layer: 'air-quality-index-categories',
      group: FIELD,
      label: 'Air quality',
      detail: 'AQI banded good to hazardous',
      cadence: '12 hr',
    },
    {
      code: 'm',
      layer: 'sst',
      group: FIELD,
      label: 'Sea surface temp',
      detail: 'Ocean surface temperature',
      cadence: 'Daily',
    },
    {
      code: 'y',
      layer: 'maritime-wave-heights',
      group: FIELD,
      label: 'Wave height',
      detail: 'Primary wave height',
      cadence: '6 hr',
    },
    {
      code: '2',
      layer: 'maritime-currents',
      group: FIELD,
      label: 'Ocean currents',
      detail: 'Surface current speed',
      cadence: '6 hr',
    },
    {
      code: '3',
      layer: 'snow-depth',
      group: FIELD,
      label: 'Snow depth',
      detail: 'Estimated depth on the ground',
      cadence: 'Daily',
    },
    {
      code: '4',
      layer: 'fqpf-accum',
      group: FIELD,
      label: 'Precip forecast',
      detail: 'Forecast accumulation',
      cadence: '1-6 hr',
      forecast: true,
    },
    {
      code: '5',
      layer: 'fjet-stream',
      group: FIELD,
      label: 'Jet stream',
      detail: 'Forecast winds at 250 mb',
      cadence: '1-6 hr',
      forecast: true,
    },
  ].map((entry) =>
    Object.freeze({
      rung: entry.group === FIELD ? FIELD_RUNG : OVERLAY_RUNG,
      alpha: entry.group === FIELD ? FIELD_ALPHA : 0.72,
      usOnly: false,
      defaultOn: false,
      forecast: false,
      coverage: null,
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
export function layerByName(layer) {
  return BY_LAYER.get(String(layer ?? '')) || null;
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
