// Which engine draws which layer: the layer renderer registry and the layer
// availability API built on it.
//
// A renderer factory `(engine, options) => renderer` draws one layer on one
// engine kind (`render/cesium.js`, `render/navara.js` of a layer), or on
// every kind (its `render/display.js`, registered for each). Cesium
// layers without a render/cesium.js draw themselves: they are registered as
// CESIUM_BUILTIN. Cesium entries are registered here, statically (main
// chunk); Navara factories are registered by the Navara mode after its
// import() (src/app/navaraMode.js).
//
// ## Layer availability (stable API, used by the layer list)
//
//   import { createLayerAvailability } from './app/layers/renderers.js';
//   const availability = createLayerAvailability(engine.kind);
//   availability.engine              // 'cesium' | 'navara'
//   availability.isAvailable(id)     // can this engine show layer `id`?
//   availability.available()         // [{ id, name }] in catalog order
//   availability.unavailable()       // [{ id, name }] the catalog leaves out
//
// The object is frozen; available() and unavailable() return fresh arrays.
// It reads the registry when called, so a Navara factory registered later
// (after the Navara mode loads) shows up. `name` is the layer's display name
// (src/app/layers/directory.js). The layer list takes it as its
// `availability` provider (`{ engine, unavailable() }` is the part it reads).

import { APPLICATION_LAYER_DIRECTORY } from './directory.js';
import { createFlightsDisplay } from '../../layers/flights/render/display.js';
import { createMilitaryDisplay } from '../../layers/military/render/display.js';
import { createLocalAdsbDisplay } from '../../layers/localAdsb/render/display.js';
import { createSatellitesDisplay } from '../../layers/satellites/render/display.js';
import { createVesselsDisplay } from '../../layers/vessels/render/display.js';
import { createLaunchesDisplay } from '../../layers/launches/render/display.js';
import { createOsmPlacesDisplay } from '../../layers/osmPlaces/render/display.js';
import { createAlprDisplay } from '../../layers/alpr/render/display.js';
import { createBikeshareDisplay } from '../../layers/bikeshare/render/display.js';
import { createRadioDisplay } from '../../layers/radio/render/display.js';
import { createTransitDisplay } from '../../layers/transit/render/display.js';
import { createCctvDisplay } from '../../layers/cctv/render/display.js';
import { createEarthquakesDisplay } from '../../layers/earthquakes/render/display.js';
import { createAirQualityDisplay } from '../../layers/airQuality/render/display.js';
import { createGnssDisplay } from '../../layers/gnss/render/display.js';
import { createPerimetersDisplay } from '../../layers/perimeters/render/display.js';
import { createDroneAirspaceDisplay } from '../../layers/droneAirspace/render/display.js';
import { createFirmsDisplay } from '../../layers/firms/render/display.js';
import { createGhostMapsDisplay } from '../../layers/ghostMaps/render/display.js';
import { createCyclonesDisplay } from '../../layers/cyclones/render/display.js';
import { createCablesDisplay } from '../../layers/submarineCables/render/display.js';
import { createInfrastructureDisplay } from '../../layers/infrastructure/render/display.js';
import { createInstallationsDisplay } from '../../layers/installations/render/display.js';
import { createAwarenessDisplay } from '../../layers/awareness/render/display.js';
import { createStreetLevelDisplay } from '../../layers/streetLevel/render/display.js';
import { createTrafficDisplay } from '../../layers/traffic/render/display.js';
import { createDirectionsDisplay } from '../../layers/directions/render/display.js';
import { createRecentImageryDisplay } from '../../layers/recentImagery/render/display.js';

const ENGINE_KINDS = new Set(['cesium', 'navara']);

/** The layer draws itself on Cesium (no separate renderer yet). */
export const CESIUM_BUILTIN = Object.freeze({ builtin: 'cesium' });

const isFactory = (value) =>
  typeof value === 'function' || value === CESIUM_BUILTIN;

/** A registry of layer renderers per engine kind. */
export function createRendererRegistry() {
  const byEngine = new Map();
  const entries = (engineKind) => byEngine.get(engineKind) ?? new Map();
  return {
    /** Adds `{ [layerId]: factory }` for an engine kind; one per layer. */
    register(engineKind, factories) {
      if (typeof engineKind !== 'string' || !engineKind)
        throw new TypeError('registerLayerRenderers needs an engine kind');
      let map = byEngine.get(engineKind);
      if (!map) byEngine.set(engineKind, (map = new Map()));
      for (const [layerId, factory] of Object.entries(factories ?? {})) {
        if (!isFactory(factory))
          throw new TypeError(
            `Layer renderer for ${layerId} on ${engineKind} is not a factory`,
          );
        if (map.has(layerId))
          throw new Error(
            `Layer ${layerId} already has a renderer on ${engineKind}`,
          );
        map.set(layerId, factory);
      }
    },
    /**
     * The renderer of a layer on `engine` (factory(engine, options)), or null
     * when the engine has none or the layer still draws itself (Cesium).
     */
    rendererFor(layerId, engine, options = {}) {
      const factory = entries(engine?.kind).get(layerId);
      return typeof factory === 'function' ? factory(engine, options) : null;
    },
    layerAvailableOn: (layerId, engineKind) => entries(engineKind).has(layerId),
    availableIds: (engineKind) => [...entries(engineKind).keys()],
  };
}

const defaultRegistry = createRendererRegistry();

/** Registers layer renderers on the application's registry. */
export const registerLayerRenderers = (engineKind, factories) =>
  defaultRegistry.register(engineKind, factories);
/** The application registry's renderer of a layer on an engine, or null. */
export const rendererFor = (layerId, engine, options) =>
  defaultRegistry.rendererFor(layerId, engine, options);
/** Whether the application can show a layer on an engine kind. */
export const layerAvailableOn = (layerId, engineKind) =>
  defaultRegistry.layerAvailableOn(layerId, engineKind);

/** Cesium renderers extracted from their layers (render/cesium.js). */
export const CESIUM_LAYER_RENDERERS = Object.freeze({
  earthquakes: createEarthquakesDisplay,
  'air-quality': createAirQualityDisplay,
  'gnss-integrity': createGnssDisplay,
  'fire-perimeters': createPerimetersDisplay,
  'drone-airspace': createDroneAirspaceDisplay,
  'osm-places': createOsmPlacesDisplay,
  'alpr-cameras': createAlprDisplay,
  bikeshare: createBikeshareDisplay,
  radio: createRadioDisplay,
  transit: createTransitDisplay,
  'local-firms': createFirmsDisplay,
  's2-ghostmaps': createGhostMapsDisplay,
  'weather-cyclones': createCyclonesDisplay,
  'telegeography-submarine-cables': createCablesDisplay,
  'local-datacenters': createInfrastructureDisplay,
  'local-dams': createInfrastructureDisplay,
  'rocket-launches': createLaunchesDisplay,
  satellites: createSatellitesDisplay,
  flights: createFlightsDisplay,
  military: createMilitaryDisplay,
  'local-adsb': createLocalAdsbDisplay,
  'ais-live-vessels': createVesselsDisplay,
  cctv: createCctvDisplay,
  'military-installations': createInstallationsDisplay,
  'military-awareness': createAwarenessDisplay,
  'street-level': createStreetLevelDisplay,
  traffic: createTrafficDisplay,
  directions: createDirectionsDisplay,
  'recent-imagery': createRecentImageryDisplay,
});

// The other application layers still draw themselves on Cesium.
registerLayerRenderers(
  'cesium',
  Object.fromEntries(
    APPLICATION_LAYER_DIRECTORY.map(({ id }) => [
      id,
      CESIUM_LAYER_RENDERERS[id] ?? CESIUM_BUILTIN,
    ]),
  ),
);

/**
 * @typedef {object} LayerAvailability
 * @property {'cesium' | 'navara'} engine
 * @property {(layerId: string) => boolean} isAvailable
 * @property {() => { id: string, name: string }[]} available
 * @property {() => { id: string, name: string }[]} unavailable
 */

/**
 * The layers an engine kind can show (stable API; see the module comment).
 * @param {'cesium' | 'navara'} engineKind
 * @param {{ registry?: object, directory?: { id: string, name: string }[] }} [options]
 *   Test seams: the registry and the layer directory.
 * @returns {LayerAvailability}
 */
export function createLayerAvailability(
  engineKind,
  { registry = defaultRegistry, directory = APPLICATION_LAYER_DIRECTORY } = {},
) {
  if (!ENGINE_KINDS.has(engineKind))
    throw new TypeError(`Unknown engine kind for layers: ${engineKind}`);
  const isAvailable = (layerId) =>
    registry.layerAvailableOn(layerId, engineKind);
  const rows = (wanted) =>
    directory
      .filter(({ id }) => isAvailable(id) === wanted)
      .map(({ id, name }) => ({ id, name }));
  return Object.freeze({
    engine: engineKind,
    isAvailable,
    available: () => rows(true),
    unavailable: () => rows(false),
  });
}
