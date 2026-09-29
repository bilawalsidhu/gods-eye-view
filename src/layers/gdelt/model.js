import * as Cesium from 'cesium';

export const GDELT_OVERLAY_SOURCE_ID = 'gdelt-events';
export const GDELT_OVERLAY_COHORT_LIMIT = 40;
export const GDELT_OVERLAY_COLLISION_CAPACITY = 100;

/**
 * Tactical color assignment based on sentiment/tone:
 * - Negative (tone < -3): Crimson Red (Conflict / Crisis / Disaster)
 * - Moderate (-3 <= tone < 2): Amber / Gold (Developing / High Activity)
 * - Positive/Neutral (tone >= 2): Electric Cyan (Agreements / Diplomacy)
 */
export function toneColor(tone) {
  if (tone < -3.0) {
    return Cesium.Color.fromCssColorString('#ff3355'); // Crimson
  }
  if (tone < 2.0) {
    return Cesium.Color.fromCssColorString('#ffaa00'); // Amber
  }
  return Cesium.Color.fromCssColorString('#00f0ff'); // Electric Cyan
}

export function createGdeltOverlayEntry({
  id,
  position,
  name,
  count,
  tone,
  accent,
}) {
  return {
    id,
    position,
    label: name.length > 32 ? `${name.slice(0, 32)}…` : name,
    sublabel: `${count} reports · Tone ${tone > 0 ? `+${tone.toFixed(1)}` : tone.toFixed(1)}`,
    accent,
    icon: '📡',
  };
}

export function selectGdeltOverlayCohort(entries) {
  return entries.slice(0, GDELT_OVERLAY_COHORT_LIMIT);
}

export function mapAnalystRecord(record, index) {
  return {
    index,
    id: record.id || `gdelt-${index}`,
    type: 'osint_event',
    headline: record.name,
    count: record.count,
    tone: record.tone,
    url: record.url,
    domain: record.domain,
    lat: record.lat,
    lon: record.lon,
    time: record.time,
  };
}
