/**
 * Layer and source names as the page shows them.
 *
 * Layer ids, English module names (`layer.name`) and declared source names
 * stay English in layer state, share links and AI tool output; these helpers
 * translate them only at a presentation boundary. The layer panel, the HUD
 * and the voice card name a layer the same way through them.
 *
 * Pure: imports only i18n, no DOM.
 * @module ui/layerNames
 */
import { msg, t, translateKnown } from '../i18n/index.js';

/** English module names (`layer.name`) by layer id. */
export const LAYER_NAME_KEYS = Object.freeze({
  flights: msg('Live Flights'),
  military: msg('Military Flights'),
  earthquakes: msg('Earthquakes (24h)'),
  satellites: msg('Satellites'),
  'rocket-launches': msg('Space Missions (30d)'),
  traffic: msg('Street Traffic'),
  cctv: msg('CCTV'),
  radio: msg('Radio'),
  bikeshare: msg('Bikeshare'),
  'ais-live-vessels': msg('Live AIS Vessels'),
  'military-installations': msg('Mapped Installations'),
  'military-awareness': msg('Global Context'),
  'local-datacenters': msg('Datacenters'),
  'local-dams': msg('Dams'),
  'telegeography-submarine-cables': msg('Submarine Cables'),
  'local-firms': msg('FIRMS Active Fires'),
  'local-adsb': msg('Local ADS-B'),
  transit: msg('Transit'),
  'recent-imagery': msg('Recent Imagery'),
  'fire-perimeters': msg('Fire Perimeters'),
  'gnss-integrity': msg('GNSS Integrity'),
  wind: msg('Wind'),
  'weather-radar': msg('Rain radar'),
  'weather-satellite': msg('Satellite clouds'),
  'weather-lightning': msg('Lightning density'),
  'weather-cyclones': msg('Cyclone advisories'),
  'air-quality': msg('Air quality'),
  directions: msg('Directions'),
  'alpr-cameras': msg('ALPR Cameras'),
  'bom-radar': msg('AU rain radar'),
});

/** The layer panel's own English names, where they differ from the module's. */
export const PANEL_LABEL_KEYS = Object.freeze({
  'ais-live-vessels': msg('Live Vessels'),
  bikeshare: msg('Bike Share'),
  cctv: msg('Cameras'),
  'street-level': msg('Street Level'),
  'alpr-cameras': msg('Mapped ALPR Cameras'),
  'local-datacenters': msg('Data Centers'),
  'local-firms': msg('Active Fires'),
});

// Looked up by the English text, so a surface that holds `layer.name` keeps
// its English data and only the shown text translates.
const MODULE_NAME_KEYS = new Map(
  [...Object.values(LAYER_NAME_KEYS), ...Object.values(PANEL_LABEL_KEYS)].map(
    (key) => [key, key],
  ),
);

/**
 * Translate a layer's English module name for display; any other text
 * (a provider name, an unknown layer) is returned unchanged.
 * @param {string} name English `layer.name`.
 * @returns {string}
 */
export function localizeLayerName(name) {
  const key = MODULE_NAME_KEYS.get(String(name ?? '').trim());
  return key ? t(key) : name;
}

/**
 * A layer id's module name in the active language, or null for an id this
 * module does not know.
 * @param {string} id Layer id, e.g. `earthquakes`.
 * @returns {string|null}
 */
export function layerNameForId(id) {
  const key = Object.hasOwn(LAYER_NAME_KEYS, id)
    ? LAYER_NAME_KEYS[id]
    : Object.hasOwn(PANEL_LABEL_KEYS, id)
      ? PANEL_LABEL_KEYS[id]
      : null;
  return key ? t(key) : null;
}

/**
 * A layer as shown: its English module name or its id, whichever is known,
 * in the active language; otherwise the text as given.
 * @param {string} [name] English `layer.name`, or an id when the layer had none.
 * @param {string} [id] Layer id.
 * @returns {string}
 */
export function shownLayerName(name, id) {
  const text = String(name ?? '').trim();
  if (text && MODULE_NAME_KEYS.has(text)) return t(MODULE_NAME_KEYS.get(text));
  return layerNameForId(id || text) || text || String(id ?? '');
}

// Layer-declared source names. Provider names (USGS, CelesTrak, GTFS-RT…)
// are not listed and pass through unchanged unless the catalog knows them.
const SOURCE_LABEL_KEYS = new Map(
  [
    msg('Flights'),
    msg('Military aircraft'),
    msg('Vessels'),
    msg('CCTV + Street View fallback'),
    msg('OpenStreetMap + optional Google Maps Places'),
    msg('GFS / ECMWF IFS · FORECAST'),
    msg('NOAA nowCOAST · OBSERVED'),
    msg('NASA FIRMS · LIVE'),
    msg('OSM routing'),
    msg('Mapped camera locations'),
    msg('OpenStreetMap · community mapped'),
  ].map((key) => [key, key]),
);

/**
 * A layer's declared source name as shown.
 * @param {string} source English source name, e.g. `Flights` or `OpenSky`.
 * @returns {string}
 */
export function sourceLabel(source) {
  if (typeof source !== 'string') return source;
  if (source === 'Local') return t('Local', { context: 'data source' });
  const key = SOURCE_LABEL_KEYS.get(source);
  if (key) return t(key);
  // A layer with several providers joins their names ("Mapillary · Google
  // Street View"); a name with a translation shows it.
  return source.includes(' · ')
    ? source.split(' · ').map(translateKnown).join(' · ')
    : translateKnown(source);
}
