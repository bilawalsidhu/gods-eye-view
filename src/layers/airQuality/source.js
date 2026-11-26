/**
 * The portable air-quality source (package.json `./layers/air-quality/source`):
 * the provider composition, without importing Cesium or the layer UI. Every
 * provider is a station network; the layer rates each station from its
 * concentrations (the US AQI it computes, or a pollutant's bands). The rows
 * a host's provider returns, and what each needs to be rated on the US AQI
 * (its averaging period, a PM NowCast's hourly rows), are described at
 * `createAirQualitySource`.
 */
export {
  createAirQualitySource,
  createAirQualitySnapshotSource,
  createDefaultAirQualityProviders,
} from './providers.js';
