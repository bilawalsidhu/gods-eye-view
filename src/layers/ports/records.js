/**
 * NGA Pub 150 records mirrored by US DOE/NETL. This module is also imported
 * by the server, so keep it independent of browser globals and UI/i18n:
 * labels are marked with the portable msg() and translated by the layer.
 */
import { msg } from '../../i18n/marker.js';

export const WPI_REFERENCE_URL = 'https://msi.nga.mil/Publications/WPI';
export const WPI_MIRROR_URL =
  'https://arcgis.netl.doe.gov/server/rest/services/Hosted/CCS_EJ_SJ_Data/FeatureServer/17';

export const PORT_FACILITIES = Object.freeze([
  Object.freeze({
    id: 'container',
    key: 'fac_container',
    label: msg('Container'),
  }),
  Object.freeze({
    id: 'solid-bulk',
    key: 'fac_solidbulk',
    label: msg('Solid bulk'),
  }),
  Object.freeze({ id: 'oil', key: 'fac_oilterm', label: msg('Oil terminal') }),
  Object.freeze({ id: 'lng', key: 'fac_lngterm', label: msg('LNG terminal') }),
]);

const WPI_REFERENCE_LINE = msg(
  'Reference: NGA World Port Index / DOE NETL mirror',
);
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

/**
 * Classify one WGS84 GeoJSON feature from the NETL WPI ArcGIS layer. Returns
 * `{ port }` or `{ reason }`; the reason lets the snapshot count skipped rows.
 */
function classifyWpiFeature(feature) {
  const props = feature?.properties;
  const coordinates = feature?.geometry?.coordinates;
  if (
    feature?.geometry?.type !== 'Point' ||
    !props ||
    !Array.isArray(coordinates) ||
    coordinates.length < 2
  )
    return { reason: 'invalidGeometry' };
  const lon = availableNumber(coordinates[0], -180, 180);
  const lat = availableNumber(coordinates[1], -90, 90);
  if (lat === null || lon === null) return { reason: 'invalidGeometry' };
  const number = props.wpinumber;
  // The live layer holds a few fractional numbers (for example 49454.5). The
  // share/pick grammar, the source validator and the card accept integers
  // only, so these rows are skipped and counted rather than coerced.
  if (
    typeof number === 'number' &&
    Number.isFinite(number) &&
    !Number.isInteger(number)
  )
    return { reason: 'fractionalId' };
  if (!Number.isSafeInteger(number) || number <= 0)
    return { reason: 'malformedId' };
  const name = clean(props.main_port_name) || clean(props.regionname);
  if (!name) return { reason: 'missingName' };
  const facilities = Object.fromEntries(
    PORT_FACILITIES.map(({ id, key }) => [id, wpiAffirmative(props[key])]),
  );
  return {
    port: {
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
    },
  };
}

/** Normalize one WGS84 GeoJSON feature; null when the row is unusable. */
export function normalizeWpiFeature(feature) {
  return classifyWpiFeature(feature).port ?? null;
}

/**
 * Per-row default-deny: a bad row is skipped and counted by reason, never
 * allowed to sink the snapshot. A repeated WPI number keeps the first row in
 * source order and counts the rest; fields are never merged. Returns null only
 * when the input is not a feature list.
 */
export function normalizeWpiFeatures(features) {
  if (!Array.isArray(features)) return null;
  const byId = new Map();
  const skipped = {
    total: 0,
    duplicateId: 0,
    fractionalId: 0,
    malformedId: 0,
    invalidGeometry: 0,
    missingName: 0,
  };
  for (const feature of features) {
    const { port, reason } = classifyWpiFeature(feature);
    if (!port) {
      skipped[reason] += 1;
      skipped.total += 1;
    } else if (byId.has(port.id)) {
      skipped.duplicateId += 1;
      skipped.total += 1;
    } else byId.set(port.id, port);
  }
  return { records: [...byId.values()], skipped };
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
    // i18n-ignore: composite WPI data-card field, English like its neighbours
    `Operational status: ${UNAVAILABLE} (WPI listing is not current operation)`,
    `Expansion: ${UNAVAILABLE}`,
    WPI_REFERENCE_LINE,
  ];
}
