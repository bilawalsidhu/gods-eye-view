import * as Cesium from 'cesium';
import { stationAccent } from './cards.js';

export { OCEAN_STATION_OVERLAY_SOURCE_ID } from './cards.js';

/**
 * Cesium Color for a station point based on wave height / sea state.
 */
export function stationColor(station) {
  const hex = stationAccent(station);
  return Cesium.Color.fromCssColorString(hex);
}

/**
 * Map raw entity properties or station record to a JSON-safe analyst record
 * for voice queries (pure, no Cesium types).
 */
export function mapAnalystRecord(raw, index = 0) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const text = (v) => {
    const t = String(v ?? '').trim();
    return t || null;
  };
  return {
    id: text(raw?.id) || `STN-${String(index).padStart(4, '0')}`,
    lat: num(raw?.lat),
    lon: num(raw?.lon),
    waveHeightM: num(raw?.waveHeightM),
    wavePeriodSec: num(raw?.wavePeriodSec),
    waterTempC: num(raw?.waterTempC),
    airTempC: num(raw?.airTempC),
    windSpeedMps: num(raw?.windSpeedMps),
    windDirDeg: num(raw?.windDirDeg),
    pressureHpa: num(raw?.pressureHpa),
    timeMs: num(raw?.timeMs),
  };
}
