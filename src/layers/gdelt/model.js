import * as Cesium from 'cesium';

export const GDELT_OVERLAY_SOURCE_ID = 'gdelt-events';
export const GDELT_OVERLAY_COHORT_LIMIT = 40;
export const GDELT_OVERLAY_COLLISION_CAPACITY = 100;

// Unified tactical news marker color (neutral cyan)
export const GDELT_MARKER_COLOR = Cesium.Color.fromCssColorString('#00e5ff');

export function createGdeltOverlayEntry({ id, position, name }) {
  return {
    id,
    position,
    label: name.length > 36 ? `${name.slice(0, 36)}…` : name,
    sublabel: 'Headline (unverified)',
    accent: GDELT_MARKER_COLOR.toCssColorString(),
    icon: '📰',
  };
}

export function selectGdeltOverlayCohort(entries) {
  return entries.slice(0, GDELT_OVERLAY_COHORT_LIMIT);
}

export function mapAnalystRecord(record, index) {
  return {
    index,
    id: record.id || `gdelt-${index}`,
    type: 'unverified_headline',
    headline: record.name,
    verified: false,
    url: record.url,
    domain: record.domain,
    lat: record.lat,
    lon: record.lon,
    time: record.time,
  };
}
