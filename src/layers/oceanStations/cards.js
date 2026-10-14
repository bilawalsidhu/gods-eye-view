/** Card model for one selected ocean observation station. Pure — no Cesium types. */

export const OCEAN_STATION_OVERLAY_SOURCE_ID = 'ocean-stations';

export function stationAccent(station) {
  if (Number.isFinite(station?.waveHeightM)) {
    if (station.waveHeightM >= 4.0) return '#ff7a00';
    if (station.waveHeightM >= 2.5) return '#ffd600';
  }
  return '#00d4ff';
}

function ndbcStationLink(stationId) {
  if (!stationId || typeof stationId !== 'string') return null;
  const safeId = stationId.trim();
  if (!/^[a-zA-Z0-9_-]{1,16}$/.test(safeId)) return null;
  return `https://www.ndbc.noaa.gov/station_page.php?station=${encodeURIComponent(safeId)}`;
}

/**
 * Build the overlay-host card entry for one selected ocean station.
 * @param {Object} station - Normalized station record.
 * @param {number} _nowMs - Current epoch milliseconds.
 * @param {{ link?: ?string }} [extras]
 * @returns {Object} World-overlay entry without `position`.
 */
export function buildOceanStationCard(station, _nowMs, { link = null } = {}) {
  const resolvedLink = link ?? ndbcStationLink(station?.id);
  const facts = [];

  if (Number.isFinite(station?.waveHeightM)) {
    const ft = (station.waveHeightM * 3.28084).toFixed(1);
    const period = Number.isFinite(station?.wavePeriodSec)
      ? ` · ${station.wavePeriodSec}s period`
      : '';
    facts.push(
      `Waves: ${station.waveHeightM.toFixed(1)} m (${ft} ft)${period}`,
    );
  }

  const temps = [];
  if (Number.isFinite(station?.waterTempC)) {
    const f = ((station.waterTempC * 9) / 5 + 32).toFixed(1);
    temps.push(`Sea: ${station.waterTempC.toFixed(1)}°C (${f}°F)`);
  }
  if (Number.isFinite(station?.airTempC)) {
    const f = ((station.airTempC * 9) / 5 + 32).toFixed(1);
    temps.push(`Air: ${station.airTempC.toFixed(1)}°C (${f}°F)`);
  }
  if (temps.length) facts.push(temps.join(' · '));

  const wind = [];
  if (Number.isFinite(station?.windSpeedMps)) {
    const kts = (station.windSpeedMps * 1.94384).toFixed(1);
    const dir = Number.isFinite(station?.windDirDeg)
      ? ` @ ${Math.round(station.windDirDeg)}°`
      : '';
    wind.push(
      `Wind: ${kts} kts (${station.windSpeedMps.toFixed(1)} m/s)${dir}`,
    );
  }
  if (Number.isFinite(station?.windGustMps)) {
    const gustKts = (station.windGustMps * 1.94384).toFixed(1);
    wind.push(`gusts ${gustKts} kts`);
  }
  if (wind.length) facts.push(wind.join(' · '));

  if (Number.isFinite(station?.pressureHpa)) {
    const tendency = Number.isFinite(station?.pressureTendencyHpa)
      ? ` (${station.pressureTendencyHpa > 0 ? '+' : ''}${station.pressureTendencyHpa.toFixed(1)})`
      : '';
    facts.push(`Pressure: ${station.pressureHpa.toFixed(1)} hPa${tendency}`);
  }

  if (station?.timeIso) {
    const formatted = station.timeIso.slice(0, 16).replace('T', ' ');
    facts.push(`Observed: ${formatted} UTC`);
  }

  const details = [...facts];
  if (resolvedLink) {
    details.push('NOAA NDBC ↗ · click card to open');
  }

  const title = `OCEAN STATION · ${station?.id || 'Unknown'}`;
  return {
    id: `ocean-station-card:${station?.id}`,
    selected: true,
    interactive: Boolean(resolvedLink),
    ...(resolvedLink
      ? { accessibilityLabel: `Open Station ${station?.id} on NOAA NDBC` }
      : undefined),
    title,
    details,
    accent: stationAccent(station),
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
    link: resolvedLink,
  };
}
