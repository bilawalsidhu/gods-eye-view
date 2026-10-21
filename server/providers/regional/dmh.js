import { fetchRegionalJson } from './http.js';
import {
  isRecentDmhObservation,
  regionalDistanceM,
} from '../../../src/data/regionalModel.js';

const FEED_URL = 'https://www.meteorologia.gov.py/emas/data.json';
const CACHE_MS = 3 * 60_000;
const MAX_DISTANCE_M = 50_000;

const text = (value) =>
  typeof value === 'string' ? value.trim().slice(0, 160) : '';
const number = (value, min, max) =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= min &&
  value <= max
    ? value
    : null;
const measurement = (value, unit, min, max) =>
  value?.unidad_medida === unit ? number(value.valor, min, max) : null;

/** Normalize reported station values; portal update time never substitutes for observation time. */
export function normalizeDmhStations(payload) {
  if (
    !payload?.estaciones ||
    typeof payload.estaciones !== 'object' ||
    Array.isArray(payload.estaciones)
  )
    throw new Error('invalid_dmh_snapshot');
  const stations = Object.values(payload.estaciones);
  if (stations.length > 1000) throw new Error('oversized_dmh_catalog');
  return stations.flatMap((station) => {
    const meta = station?.metadatos;
    const observation = station?.ultima_observacion;
    const latitude = number(meta?.latitud, -90, 90);
    const longitude = number(meta?.longitud, -180, 180);
    const stationId =
      text(meta?.codigo) || (Number.isFinite(meta?.id) ? String(meta.id) : '');
    const stationName = text(meta?.nombre);
    const stamp = text(observation?.fecha?.utc);
    // Only explicitly zoned UTC-feed dates are accepted; never assume local time.
    const time = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(stamp)
      ? Date.parse(stamp)
      : NaN;
    if (
      meta?.estado !== 'activo' ||
      latitude === null ||
      longitude === null ||
      !stationId ||
      !stationName ||
      !Number.isFinite(time)
    )
      return [];
    const temperatureC = measurement(
      observation.temperatura_aire,
      '°C',
      -90,
      65,
    );
    const humidityPct = measurement(observation.humedad_relativa, '%', 0, 100);
    const windMps = measurement(observation.velocidad_viento, 'm/s', 0, 150);
    if (temperatureC === null && humidityPct === null && windMps === null)
      return [];
    return [
      {
        source: 'DMH / DINAC',
        sourceUrl: 'https://www.meteorologia.gov.py/emas/',
        stationId,
        stationName,
        latitude,
        longitude,
        observedAt: new Date(time).toISOString(),
        temperatureC,
        humidityPct,
        windKph: windMps === null ? null : Math.round(windMps * 36) / 10,
        windDirectionDeg: measurement(
          observation.direccion_viento,
          '°',
          0,
          360,
        ),
      },
    ];
  });
}

/** One bounded shared feed cache; select the nearest recent station for each requested point. */
export function createDmhObservationSource({
  fetchJson = fetchRegionalJson,
  now = () => Date.now(),
} = {}) {
  let snapshot = null;
  let cachedAt = 0;
  let failedAt = -Infinity;
  let inFlight = null;

  async function readStations() {
    if (snapshot && now() - cachedAt < CACHE_MS) return snapshot;
    if (now() - failedAt < 30_000) throw new Error('dmh_backoff');
    if (!inFlight) {
      inFlight = Promise.resolve()
        .then(() =>
          fetchJson(FEED_URL, {
            timeoutMs: 9000,
            maxBytes: 2 * 1024 * 1024,
            redirect: 'error',
          }),
        )
        .then((payload) => {
          snapshot = normalizeDmhStations(payload);
          cachedAt = now();
          return snapshot;
        })
        .catch((error) => {
          failedAt = now();
          throw error;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  }

  return {
    async getObservation(point) {
      // Paraguay plus a small border margin. Distance still limits each result;
      // a station across the border is explicitly identified, not a point forecast.
      if (
        !Number.isFinite(point?.latitude) ||
        !Number.isFinite(point?.longitude) ||
        point.latitude < -28.3 ||
        point.latitude > -18.7 ||
        point.longitude < -63.2 ||
        point.longitude > -53.7
      )
        return { status: 'outside-coverage', observation: null };
      try {
        const stations = await readStations();
        let nearest = null;
        for (const station of stations) {
          if (!isRecentDmhObservation(station, now())) continue;
          const distanceM = regionalDistanceM(point, station);
          if (
            distanceM > MAX_DISTANCE_M ||
            (nearest && distanceM >= nearest.distanceM)
          )
            continue;
          nearest = { ...station, distanceM };
        }
        return {
          status: nearest ? 'ready' : 'no-recent-station',
          observation: nearest,
        };
      } catch {
        return { status: 'unavailable', observation: null };
      }
    },
  };
}
