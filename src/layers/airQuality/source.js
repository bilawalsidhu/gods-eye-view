/**
 * The portable air-quality source (package.json `./layers/air-quality/source`):
 * the provider composition, without importing Cesium or the layer UI. Every
 * provider is a station network; the layer rates each station from its
 * concentrations (the US AQI it computes, or a pollutant's bands). The rows
 * a provider returns, and what each needs to be rated on the US AQI (its
 * averaging period, a PM NowCast's hourly rows), are described at
 * `createAirQualitySource`.
 *
 * The rating rules are exported too, for a server that answers the OpenAQ
 * route from its own copy of the readings: `aqiStations` folds a station's
 * rows into one reading for the US AQI view, as the bundled server does, and
 * `interpretHourly` rates one hourly reading on its pollutant's bands.
 */
export {
  createAirQualitySource,
  createAirQualitySnapshotSource,
  createDefaultAirQualityProviders,
} from './providers.js';
export { aqiStations } from './usAqi.js';
export { interpretHourly } from './interpretation.js';
