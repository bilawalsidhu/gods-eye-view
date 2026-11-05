import { createPerimetersCesiumRenderer } from '../../layers/perimeters/render/cesium.js';
import { createDroneAirspaceCesiumRenderer } from '../../layers/droneAirspace/index.js';
import { createOsmPlacesCesiumRenderer } from '../../layers/osmPlaces/index.js';
import { createGnssCesiumRenderer } from '../../layers/gnss/render/cesium.js';
import { createAirQualityCesiumRenderer } from '../../layers/airQuality/render/cesium.js';
import { createFirmsCesiumRenderer } from '../../layers/firms/render/cesium.js';
import { createEarthquakesCesiumRenderer } from '../../layers/earthquakes/render/cesium.js';
import { createLaunchesCesiumRenderer } from '../../layers/launches/render/cesium.js';
// Which engine draws which layer: the layer renderer registry and the layer
// availability API built on it.
//
// A renderer factory `(engine, options) => renderer` draws one layer on one
// engine kind (`render/cesium.js`, `render/navara.js` of a layer). Cesium
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
import { createFlightsCesiumRenderer } from '../../layers/flights/render/cesium.js';
import { createMilitaryCesiumRenderer } from '../../layers/military/render/cesium.js';
import { createLocalAdsbCesiumRenderer } from '../../layers/localAdsb/render/cesium.js';
import { createSatellitesCesiumRenderer } from '../../layers/satellites/render/cesium.js';
import { createVesselsCesiumRenderer } from '../../layers/vessels/render/cesium.js';

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
  earthquakes: createEarthquakesCesiumRenderer,
  'air-quality': (_engine, options) => createAirQualityCesiumRenderer(options),
  'gnss-integrity': (_engine, options) => createGnssCesiumRenderer(options),
  'fire-perimeters': (_engine, options) =>
    createPerimetersCesiumRenderer(options),
  'drone-airspace': (_engine, options) =>
    createDroneAirspaceCesiumRenderer(options),
  'osm-places': (_engine, options) => createOsmPlacesCesiumRenderer(options),
  'local-firms': createFirmsCesiumRenderer,
  'rocket-launches': createLaunchesCesiumRenderer,
  satellites: createSatellitesCesiumRenderer,
  flights: createFlightsCesiumRenderer,
  military: createMilitaryCesiumRenderer,
  'local-adsb': createLocalAdsbCesiumRenderer,
  'ais-live-vessels': createVesselsCesiumRenderer,
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
