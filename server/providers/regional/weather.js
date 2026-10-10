import { fetchRegionalJson } from './http.js';
import {
  isNearHongKong,
  normalizeHkoWeather,
  normalizeRegionalWeather,
} from '../../../src/data/regionalModel.js';

const WEATHER_EFFECTS_MAX_RESPONSE_BYTES = 512 * 1024;

/** HKO Open Data current weather report (English). Runtime fetch only. */
export const HKO_RHRREAD_URL =
  'https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=rhrread&lang=en';

async function fetchOpenMeteoWeather(point) {
  const params = new URLSearchParams({
    latitude: point.latitude.toFixed(5),
    longitude: point.longitude.toFixed(5),
    current:
      'temperature_2m,apparent_temperature,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,visibility',
    timezone: 'UTC',
  });
  try {
    const payload = await fetchRegionalJson(
      `https://api.open-meteo.com/v1/forecast?${params}`,
      {
        maxBytes: WEATHER_EFFECTS_MAX_RESPONSE_BYTES,
      },
    );
    return normalizeRegionalWeather(payload);
  } catch {
    return null;
  }
}

async function fetchHkoWeather(point) {
  try {
    const payload = await fetchRegionalJson(HKO_RHRREAD_URL, {
      maxBytes: WEATHER_EFFECTS_MAX_RESPONSE_BYTES,
      redirect: 'error',
    });
    return normalizeHkoWeather(payload, point);
  } catch {
    return null;
  }
}

/**
 * Cockpit Local Info / regional-brief weather. Over or near Hong Kong, prefer
 * the HKO current-weather report; otherwise (and on HKO failure) Open-Meteo.
 */
async function fetchRegionalWeather(point) {
  if (isNearHongKong(point)) {
    const hko = await fetchHkoWeather(point);
    if (hko) return hko;
  }
  return fetchOpenMeteoWeather(point);
}

export { fetchOpenMeteoWeather, fetchHkoWeather, fetchRegionalWeather };
