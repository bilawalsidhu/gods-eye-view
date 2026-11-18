import { sampleWind, windSpeed } from './model.js';
import { sampleScalar } from './fields.js';
import { toLonLatH } from '../../geo/ellipsoid.js';

// The reading stays English: AI tools read it too. Text is marked for i18n
// extraction and translated where the WEATHER card shows it (presentation.js).
const msg = (text) => text;

const DIRECTIONS = [
  msg('N'),
  msg('NNE'),
  msg('NE'),
  msg('ENE'),
  msg('E'),
  msg('ESE'),
  msg('SE'),
  msg('SSE'),
  msg('S'),
  msg('SSW'),
  msg('SW'),
  msg('WSW'),
  msg('W'),
  msg('WNW'),
  msg('NW'),
  msg('NNW'),
];
export const WIND_UNITS = Object.freeze({
  'km/h': 3.6,
  'm/s': 1,
  mph: 2.2369362921,
});

/** Meteorological bearing is where the wind comes FROM, not where it travels. */
export function windFrom(u, v) {
  if (Math.hypot(u, v) < 0.2) return 'Calm';
  const bearing = ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360;
  return DIRECTIONS[Math.round(bearing / 22.5) % 16];
}

export function formatWindSpeed(speed, units = 'km/h') {
  const unit = Object.hasOwn(WIND_UNITS, units) ? units : 'km/h';
  return `${(speed * WIND_UNITS[unit]).toFixed(1)} ${unit}`;
}

/**
 * A deliberate snapshot at the map center; does not own pointer input. The
 * center is where `view.query` (a renderer query port) meets the ellipsoid
 * under the middle of `view.canvas`, unless `position` (ECEF) is given.
 */
export function inspectWindAtCenter(
  snapshot,
  { query, canvas } = {},
  { units, overlay, model, validTime, status, position } = {},
) {
  const point =
    position ||
    (canvas &&
      query?.pickEllipsoid(canvas.clientWidth / 2, canvas.clientHeight / 2));
  const location = point && snapshot?.u && snapshot?.v && toLonLatH(point);
  if (!location)
    return {
      coordinates: msg('No surface reading'),
      wind: msg('Aim the map center at Earth'),
      model,
      validTime,
      status,
      explanation: msg(
        'A location reading needs a loaded forecast and the Earth at the center of the view.',
      ),
    };
  const { lon, lat } = location;
  const vector = sampleWind(
    { ...snapshot.grid, u: snapshot.u, v: snapshot.v },
    lon,
    lat,
  );
  const speed = windSpeed(vector.u, vector.v);
  const from = windFrom(vector.u, vector.v);
  const scalar = ['temperature', 'pressure'].includes(overlay)
    ? sampleScalar(snapshot, lon, lat, overlay)
    : null;
  return {
    position: point,
    speed,
    from,
    units,
    coordinates: `${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'} · ${Math.abs(lon).toFixed(2)}°${lon < 0 ? 'W' : 'E'}`,
    wind: `${formatWindSpeed(speed, units)}${from === 'Calm' ? ' · calm' : ` from ${from}`}`,
    scalarKind: overlay,
    scalarLabel:
      overlay === 'speed'
        ? msg('Wind speed')
        : overlay === 'temperature'
          ? msg('Air temperature · 2 m')
          : overlay === 'pressure'
            ? msg('Sea-level pressure')
            : null,
    scalarValue:
      overlay === 'speed'
        ? formatWindSpeed(speed, units)
        : scalar == null
          ? null
          : `${scalar.toFixed(1)} ${overlay === 'temperature' ? '°C' : 'hPa'}`,
    model,
    validTime,
    status,
    explanation: msg(
      'Interpolated model forecast on an approximately 1° grid. Broad weather patterns, not a street-level measurement.',
    ),
  };
}
