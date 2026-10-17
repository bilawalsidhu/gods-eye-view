import { fetchRegionalJson } from './http.js';
import { normalizeRegionalWeather } from '../../../src/data/regionalModel.js';
import { createSmnWeatherProvider } from './smn.js';

const WEATHER_EFFECTS_MAX_RESPONSE_BYTES = 512 * 1024;

async function fetchRegionalWeather(point) {
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

/** Local Info prefers nearby station observations; effects keep Open-Meteo. */
function createRegionalBriefWeatherProvider({
  smnProvider = createSmnWeatherProvider(),
  modelProvider = fetchRegionalWeather,
} = {}) {
  return async (point, cachedModel = null) => {
    try {
      const observation = await smnProvider(point);
      if (observation) return observation;
    } catch {
      // An optional observation source must not take down the model fallback.
    }
    // The regional cell cache may reuse a model, never a station selection.
    if (
      cachedModel &&
      typeof cachedModel !== 'function' &&
      cachedModel.source !== 'smn'
    )
      return cachedModel;
    // Coalesce model downloads only when no usable SMN record exists.
    const loadModel = async () => {
      const weather = await modelProvider(point);
      return weather
        ? {
            ...weather,
            source: 'open-meteo',
            sourceUrl: 'https://open-meteo.com/',
            kind: 'model',
            timeZone: 'UTC',
          }
        : null;
    };
    return typeof cachedModel === 'function'
      ? cachedModel(loadModel)
      : loadModel();
  };
}

export { fetchRegionalWeather, createRegionalBriefWeatherProvider };
