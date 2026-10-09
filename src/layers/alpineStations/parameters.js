/**
 * What the layer can encode, and how each reading reads.
 *
 * Network-neutral on purpose: a station record carries canonical fields and
 * units (see `./records.js`), so a view is defined once and every adapter
 * feeds it. Adding a network must never mean adding a band table.
 *
 * Bands are presentation. They are deliberately coarse and they are NOT
 * hazard ratings: snow depth is a measurement, and the only authority on
 * avalanche danger is the operator's own bulletin, which is a separate product
 * this layer does not reproduce.
 */

import { ALPINE_NETWORKS } from './networks.js';

/** Metres per second to kilometres per hour, to one decimal. */
export function msToKmh(ms) {
  return Number.isFinite(ms) ? Math.round(ms * 36) / 10 : null;
}

/** Eight-point compass label for a bearing in degrees. */
export function windCompass(degrees) {
  if (!Number.isFinite(degrees)) return null;
  const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return points[Math.round((((degrees % 360) + 360) % 360) / 45) % 8];
}

/**
 * Bands run strongest first so the first match wins, and the quiet end is an
 * open floor rather than `min: 0`.
 *
 * The floor matters for more than tidiness: the automatic snow sensor reports
 * small negatives over bare ground (-1.0 cm measured live), which is a working
 * sensor saying "no snow". A `min: 0` floor would drop it out of the scale and
 * render it identically to a station with no sensor at all.
 */
const WIND_BANDS = Object.freeze([
  Object.freeze({ id: 'storm', min: 75, label: 'Storm', accent: '#ff5c5c' }),
  Object.freeze({ id: 'strong', min: 40, label: 'Strong', accent: '#ffa23f' }),
  Object.freeze({
    id: 'moderate',
    min: 20,
    label: 'Moderate',
    accent: '#ffe066',
  }),
  Object.freeze({ id: 'light', min: 5, label: 'Light', accent: '#8ed081' }),
  Object.freeze({
    id: 'calm',
    min: -Infinity,
    label: 'Calm',
    accent: '#6b8f9e',
  }),
]);

const TEMPERATURE_BANDS = Object.freeze([
  Object.freeze({ id: 'hot', min: 30, label: 'Hot', accent: '#ff4d4d' }),
  Object.freeze({ id: 'warm', min: 20, label: 'Warm', accent: '#ffa23f' }),
  Object.freeze({ id: 'mild', min: 10, label: 'Mild', accent: '#8ed081' }),
  Object.freeze({ id: 'cool', min: 0, label: 'Cool', accent: '#63c7d6' }),
  Object.freeze({
    id: 'freezing',
    min: -10,
    label: 'Freezing',
    accent: '#5b8dd9',
  }),
  Object.freeze({
    id: 'severe',
    min: -Infinity,
    label: 'Severe frost',
    accent: '#9b7fe0',
  }),
]);

const PRECIPITATION_BANDS = Object.freeze([
  Object.freeze({ id: 'heavy', min: 5, label: 'Heavy', accent: '#b06bd6' }),
  Object.freeze({
    id: 'moderate',
    min: 2,
    label: 'Moderate',
    accent: '#4d7ee8',
  }),
  Object.freeze({ id: 'light', min: 0.5, label: 'Light', accent: '#63c7d6' }),
  Object.freeze({ id: 'trace', min: 0.1, label: 'Trace', accent: '#8fb8c4' }),
  Object.freeze({
    id: 'dry',
    min: -Infinity,
    label: 'Dry',
    accent: '#6b8f9e',
  }),
]);

const SNOW_BANDS = Object.freeze([
  Object.freeze({ id: 'deep', min: 200, label: 'Deep', accent: '#ffffff' }),
  Object.freeze({
    id: 'substantial',
    min: 100,
    label: 'Substantial',
    accent: '#cfe8ff',
  }),
  Object.freeze({
    id: 'moderate',
    min: 50,
    label: 'Moderate',
    accent: '#8fc7f0',
  }),
  Object.freeze({
    id: 'shallow',
    min: 10,
    label: 'Shallow',
    accent: '#5b9bd5',
  }),
  Object.freeze({ id: 'trace', min: 1, label: 'Trace', accent: '#7f9bb0' }),
  Object.freeze({
    id: 'bare',
    min: -Infinity,
    label: 'Bare',
    accent: '#6b8f9e',
  }),
]);

const PRESSURE_BANDS = Object.freeze([
  Object.freeze({ id: 'high', min: 1025, label: 'High', accent: '#ff8f4d' }),
  Object.freeze({
    id: 'above',
    min: 1015,
    label: 'Above average',
    accent: '#ffe066',
  }),
  Object.freeze({
    id: 'average',
    min: 1005,
    label: 'Average',
    accent: '#8fb8c4',
  }),
  Object.freeze({
    id: 'below',
    min: 995,
    label: 'Below average',
    accent: '#5b8dd9',
  }),
  Object.freeze({
    id: 'low',
    min: -Infinity,
    label: 'Low',
    accent: '#9b7fe0',
  }),
]);

/**
 * The parameter views, in chip order.
 *
 * `neutral` names the band that means "nothing remarkable", which is what
 * marker SIZE is measured against. For wind, rain and snow the quiet point is
 * the bottom of the scale, so size simply grows with the reading; for
 * temperature and pressure it sits mid-scale, so both a hard frost and a heat
 * wave draw large while a mild day draws small. Colour carries the direction,
 * size the distance from ordinary.
 *
 * `derive` exists because the stored field is not always the presented one:
 * wind is stored in m/s, as all three networks publish it, and read in km/h.
 */
export const STATION_PARAMETER_VIEWS = Object.freeze({
  wind: Object.freeze({
    id: 'wind',
    label: 'Wind',
    chipLabel: 'WIND',
    field: 'windSpeedMs',
    derive: msToKmh,
    unit: 'km/h',
    neutral: 'calm',
    bands: WIND_BANDS,
  }),
  temperature: Object.freeze({
    id: 'temperature',
    label: 'Temperature',
    chipLabel: 'TEMP',
    field: 'airTempC',
    derive: null,
    unit: '°C',
    neutral: 'mild',
    bands: TEMPERATURE_BANDS,
  }),
  snow: Object.freeze({
    id: 'snow',
    label: 'Snow depth',
    chipLabel: 'SNOW',
    field: 'snowDepthCm',
    derive: null,
    unit: 'cm',
    neutral: 'bare',
    bands: SNOW_BANDS,
  }),
  precipitation: Object.freeze({
    id: 'precipitation',
    label: 'Precipitation',
    chipLabel: 'RAIN',
    field: 'precipMm',
    derive: null,
    unit: 'mm/10min',
    neutral: 'dry',
    bands: PRECIPITATION_BANDS,
  }),
  pressure: Object.freeze({
    id: 'pressure',
    label: 'Pressure (QFF)',
    chipLabel: 'PRES',
    field: 'pressureQffHpa',
    derive: null,
    unit: 'hPa',
    neutral: 'average',
    bands: PRESSURE_BANDS,
  }),
});

/** Ids in presentation order, which is also the chip order. */
export const STATION_PARAMETER_IDS = Object.freeze(
  Object.keys(STATION_PARAMETER_VIEWS),
);

/** The view a fresh layer, and any request that omits the option, resolves to. */
export const DEFAULT_PARAMETER_ID = 'wind';

/**
 * Resolve a view id, falling back rather than throwing.
 *
 * The id reaches this from a chip, a share link and a voice action, so an
 * unknown value is ordinary input: it has to degrade to the default instead of
 * leaving the layer unable to draw anything.
 */
export function parameterView(parameterId) {
  return (
    STATION_PARAMETER_VIEWS[parameterId] ||
    STATION_PARAMETER_VIEWS[DEFAULT_PARAMETER_ID]
  );
}

/** The presented value for a station under one view, or null when absent. */
export function parameterValue(station, view) {
  const raw = station?.[view.field];
  if (!Number.isFinite(raw)) return null;
  return view.derive ? view.derive(raw) : raw;
}

/** The band a presented value falls in, or null when there is no value. */
export function parameterBand(value, view) {
  if (!Number.isFinite(value)) return null;
  return view.bands.find((band) => value >= band.min) ?? null;
}

/**
 * Distance from the view's neutral band, as 0..1.
 *
 * Marker size reads this, so a view whose quiet point is mid-scale grows in
 * both directions from it while a view whose quiet point is the floor only
 * grows upward.
 */
export function parameterProminence(value, view) {
  if (!Number.isFinite(value)) return 0;
  const bands = view.bands;
  const index = bands.findIndex((band) => value >= band.min);
  if (index < 0) return 0;
  const neutral = bands.findIndex((band) => band.id === view.neutral);
  if (neutral < 0) return 0;
  const span = Math.max(neutral, bands.length - 1 - neutral) || 1;
  return Math.min(1, Math.abs(neutral - index) / span);
}

/** A reading's text with its unit, for a card line or a marker label. */
export function formatParameter(value, view) {
  if (!Number.isFinite(value)) return null;
  const decimals = view.id === 'precipitation' ? 1 : view.id === 'wind' ? 0 : 1;
  const rounded =
    view.id === 'snow' || view.id === 'pressure'
      ? String(Math.round(value))
      : value.toFixed(decimals);
  return `${rounded} ${view.unit}`;
}

/**
 * Cycles of the publishing cadence a reading may lag before it stops counting
 * as current.
 *
 * Staleness is not hypothetical: one SwissMetNet station was last seen seven
 * days back while otherwise reporting normally, and without a cutoff it
 * rendered as a healthy reading. Six cycles absorbs an ordinarily late station;
 * the floor keeps the fastest networks from being called stale over a single
 * missed publication.
 */
export const STALE_AFTER_CYCLES = 6;
export const MIN_STALE_AFTER_MS = 90 * 60 * 1000;

/** How old a reading from this network may be and still count as current. */
export function staleAfterMs(network) {
  const cadence = Number.isFinite(network?.cadenceMinutes)
    ? network.cadenceMinutes
    : 10;
  return Math.max(MIN_STALE_AFTER_MS, cadence * STALE_AFTER_CYCLES * 60 * 1000);
}

/** Legend entries for a view, quietest first, as the rail card renders them. */
export function parameterLegend(view) {
  return [...view.bands]
    .reverse()
    .map((band) => ({ label: band.label, color: band.accent }));
}

/** Parameter ids no configured network publishes, so the picker can say so. */
export function unsupportedParameterIds(networks = ALPINE_NETWORKS) {
  const supported = new Set(networks.flatMap((network) => network.parameters));
  return STATION_PARAMETER_IDS.filter((id) => !supported.has(id));
}
