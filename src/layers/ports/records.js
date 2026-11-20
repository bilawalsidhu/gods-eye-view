/**
 * NGA Pub 150 records mirrored by US DOE/NETL. This module is also imported
 * by the server, so keep it independent of browser globals and UI/i18n.
 */
export const WPI_REFERENCE_URL = 'https://msi.nga.mil/Publications/WPI';
export const WPI_MIRROR_URL =
  'https://arcgis.netl.doe.gov/server/rest/services/Hosted/CCS_EJ_SJ_Data/FeatureServer/17';

export const PORT_FACILITIES = Object.freeze([
  Object.freeze({ id: 'container', key: 'fac_container', label: 'Container' }),
  Object.freeze({ id: 'solid-bulk', key: 'fac_solidbulk', label: 'Solid bulk' }),
  Object.freeze({ id: 'oil', key: 'fac_oilterm', label: 'Oil terminal' }),
  Object.freeze({ id: 'lng', key: 'fac_lngterm', label: 'LNG terminal' }),
]);

const TEXT_MAX = 140;
const UNAVAILABLE = 'Unavailable';

/** Yes / No / unknown are distinct; only explicit affirmative means Yes. */
export function wpiAffirmative(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'yes' || normalized === 'y' || normalized === 'true')
    return true;
  if (normalized === 'no' || normalized === 'n' || normalized === 'false')
    return false;
  return null;
}

function clean(value, maxLength = TEXT_MAX) {
  if (typeof value !== 'string') return null;
  const result = value
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .trim()
    .slice(0, maxLength);
  return result || null;
}

function availableNumber(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value >= min && value <= max ? value : null;
}

/**
 * WPI lists a port, not necessarily a separately identified terminal. Never
 * fill commercial fields from the name, facility flags or nearby port data.
 */
export function unknownPortCommercial() {
  return {
    operator: null,
    ownership: null,
    annualThroughput: null,
    handlingCapacity: null,
    operationalStatus: null,
    expansion: null,
  };
}

/** Normalize one WGS84 GeoJSON feature from the NETL WPI ArcGIS layer. */
export function normalizeWpiFeature(feature) {
  const props = feature?.properties;
  const coordinates = feature?.geometry?.coordinates;
  if (
    feature?.geometry?.type !== 'Point' ||
    !props ||
    !Array.isArray(coordinates) ||
    coordinates.length < 2
  )
    return null;
  const lon = availableNumber(coordinates[0], -180, 180);
  const lat = availableNumber(coordinates[1], -90, 90);
  const number = props.wpinumber;
  if (
    lat === null ||
    lon === null ||
    !Number.isSafeInteger(number) ||
    number <= 0
  )
    return null;
  const name = clean(props.main_port_name) || clean(props.regionname);
  if (!name) return null;
  const facilities = Object.fromEntries(
    PORT_FACILITIES.map(({ id, key }) => [id, wpiAffirmative(props[key])]),
  );
  return {
    id: `wpi:${number}`,
    wpiNumber: number,
    name,
    alternateName: clean(props.alternate_name),
    country: clean(props.wpi_cc, 60),
    unlocode: clean(props.unlocode, 20),
    lat,
    lon,
    facilities,
    harborSize: clean(props.harbor_size_code, 60),
    harborType: clean(props.harbor_type_code, 60),
    channelDepthM: availableNumber(props.channel_depth, 0, 1000),
    cargoPierDepthM: availableNumber(props.cargo_pier_depth, 0, 1000),
    // No WPI flag states whether the port is presently operating.
    commercial: unknownPortCommercial(),
    source: 'NGA WPI (DOE NETL mirror)',
    sourceUrl: WPI_REFERENCE_URL,
  };
}

/** Preserve stable WPI identities and reject inconsistent duplicate features. */
export function normalizeWpiFeatures(features) {
  if (!Array.isArray(features)) return null;
  const byId = new Map();
  for (const feature of features) {
    const port = normalizeWpiFeature(feature);
    if (!port) continue;
    if (byId.has(port.id)) return null;
    byId.set(port.id, port);
  }
  return [...byId.values()];
}

export function visibleWpiPort(port, { country = '', facility = 'all' } = {}) {
  if (country && port.country !== country) return false;
  if (facility === 'all') return true;
  if (!PORT_FACILITIES.some((row) => row.id === facility)) return false;
  return port.facilities?.[facility] === true;
}

export function portProfileLines(port) {
  const shown = (value) => value || UNAVAILABLE;
  const facility = PORT_FACILITIES.map(({ id, label }) => {
    const value = port.facilities?.[id];
    return `${label}: ${value === true ? 'Yes' : value === false ? 'No' : 'Unknown'}`;
  });
  return [
    `WPI: ${port.wpiNumber}`,
    `Country: ${shown(port.country)}`,
    `UN/LOCODE: ${shown(port.unlocode)}`,
    ...facility,
    `Operator: ${UNAVAILABLE}`,
    `Ownership: ${UNAVAILABLE}`,
    `Annual throughput: ${UNAVAILABLE}`,
    `Handling capacity: ${UNAVAILABLE}`,
    `Operational status: ${UNAVAILABLE} (WPI listing is not current operation)`,
    `Expansion: ${UNAVAILABLE}`,
    'Reference: NGA World Port Index / DOE NETL mirror',
  ];
}
