/**
 * Tools that answer questions from God's Eye View data, independent of the
 * surface that exposes them. See docs/TOOLS.md.
 */

import {
  aircraftInArea,
  findAircraft,
  getAircraftInfo,
  getAircraftTrack,
} from './queries/aviation.js';
import { getWeatherMap, getWind } from './queries/atmosphere.js';
import { findSubmarineCables } from './queries/cables.js';
import {
  getHudCaption,
  militaryAwareness,
  situationBrief,
} from './queries/brief.js';
import {
  findMilitaryInstallations,
  getCyclones,
  getFirePerimeters,
  getMapFeatures,
  getRegionalBrief,
  getTerrainHeight,
  getWeather,
} from './queries/environment.js';
import { getBhoteKoshiFlood } from './queries/events.js';
import { getActiveFires, getEarthquakes } from './queries/hazards.js';
import { getRecentImagery } from './queries/imagery.js';
import { findInfrastructure } from './queries/infrastructure.js';
import {
  findVessel,
  getVesselTrack,
  vesselsInArea,
} from './queries/maritime.js';
import {
  getBikeShare,
  getTrafficFlow,
  getTransitVehicles,
} from './queries/mobility.js';
import { placesNearby, planRoute, searchPlaces } from './queries/places.js';
import { panelRequest } from './queries/panelRequest.js';
import { showInGodsEyeView } from './queries/share.js';
import { findAlprCameras } from './queries/surveillance.js';
import {
  findCctvCameras,
  findRadioStations,
  getCctvSnapshot,
} from './queries/media.js';
import {
  getRecentLaunches,
  nextSatellitePass,
  satellitesOverhead,
} from './queries/space.js';

export {
  defineTool,
  composeCatalog,
  ToolError,
  TOOL_ERROR_CODES,
} from './catalog.js';
export {
  AREA_SCHEMA,
  resolveArea,
  areaCenter,
  areaContains,
  distanceKm,
} from './area.js';
export { LIMIT_SCHEMA, DEFAULT_LIMIT, MAX_LIMIT, capRows } from './results.js';
export { toFunctionOutput, toFunctionTools } from './functions.js';
export {
  SURFACES,
  TOOL_SURFACES,
  catalogForSurface,
  toolsForSurface,
} from './surfaces.js';
export {
  createGeocodePlaceService,
  createPlaceSearchService,
  createRouteService,
  placeFromGeocodeResult,
} from './places.js';

/** Every query Core defines, in a stable order. */
export const coreTools = Object.freeze([
  getEarthquakes,
  getActiveFires,
  getRecentLaunches,
  aircraftInArea,
  findAircraft,
  getAircraftTrack,
  getAircraftInfo,
  vesselsInArea,
  findVessel,
  getVesselTrack,
  nextSatellitePass,
  satellitesOverhead,
  findCctvCameras,
  getCctvSnapshot,
  findAlprCameras,
  findRadioStations,
  searchPlaces,
  placesNearby,
  planRoute,
  getBikeShare,
  getTransitVehicles,
  getTrafficFlow,
  getWeather,
  getWeatherMap,
  getWind,
  getRecentImagery,
  findSubmarineCables,
  findInfrastructure,
  getBhoteKoshiFlood,
  getRegionalBrief,
  getCyclones,
  getFirePerimeters,
  getTerrainHeight,
  findMilitaryInstallations,
  getMapFeatures,
  situationBrief,
  militaryAwareness,
  getHudCaption,
  showInGodsEyeView,
  panelRequest,
]);
