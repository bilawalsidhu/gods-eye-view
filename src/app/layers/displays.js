// Every layer's display (render/display.js): one chunk, which the layer
// manifest (./renderers.js) loads through import() on every engine kind,
// before an engine's catalog is built. Every start loads them all, so they
// share one request and one compression context.

export { createFlightsDisplay } from '../../layers/flights/render/display.js';
export { createMilitaryDisplay } from '../../layers/military/render/display.js';
export { createLocalAdsbDisplay } from '../../layers/localAdsb/render/display.js';
export { createVesselsDisplay } from '../../layers/vessels/render/display.js';
export { createSatellitesDisplay } from '../../layers/satellites/render/display.js';
export { createLaunchesDisplay } from '../../layers/launches/render/display.js';
export { createAlprDisplay } from '../../layers/alpr/render/display.js';
export { createBikeshareDisplay } from '../../layers/bikeshare/render/display.js';
export { createOsmPlacesDisplay } from '../../layers/osmPlaces/render/display.js';
export { createRadioDisplay } from '../../layers/radio/render/display.js';
export { createTransitDisplay } from '../../layers/transit/render/display.js';
export { createCctvDisplay } from '../../layers/cctv/render/display.js';
export { createEarthquakesDisplay } from '../../layers/earthquakes/render/display.js';
export { createAirQualityDisplay } from '../../layers/airQuality/render/display.js';
export { createPerimetersDisplay } from '../../layers/perimeters/render/display.js';
export { createGnssDisplay } from '../../layers/gnss/render/display.js';
export { createGhostMapsDisplay } from '../../layers/ghostMaps/render/display.js';
export { createDroneAirspaceDisplay } from '../../layers/droneAirspace/render/display.js';
export { createCyclonesDisplay } from '../../layers/cyclones/render/display.js';
export { createCablesDisplay } from '../../layers/submarineCables/render/display.js';
export { createInstallationsDisplay } from '../../layers/installations/render/display.js';
export { createAwarenessDisplay } from '../../layers/awareness/render/display.js';
export { createInfrastructureDisplay } from '../../layers/infrastructure/render/display.js';
export { createStreetLevelDisplay } from '../../layers/streetLevel/render/display.js';
export { createTrafficDisplay } from '../../layers/traffic/render/display.js';
export { createDirectionsDisplay } from '../../layers/directions/render/display.js';
export { createFirmsDisplay } from '../../layers/firms/render/display.js';
export { createRecentImageryDisplay } from '../../layers/recentImagery/render/display.js';
export { createWeatherDisplay } from '../../layers/weather/render/display.js';
export { createWindDisplay } from '../../layers/wind/render/display.js';
export {
  createBhoteKoshiDisplay,
  createBhoteKoshiLocatorDisplay,
} from '../../layers/bhoteKoshi/render/display.js';
