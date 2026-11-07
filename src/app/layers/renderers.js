// How each application layer draws on each engine: the layer manifest, and
// the layer availability API built on it.
//
// ## The manifest
//
// One entry per layer of the directory (src/app/layers/directory.js), in
// its order, of one of three kinds:
//
// - `display(name, needs, backends)`: the layer's render/display.js, the
//   same factory `(engine, options) => renderer` on every engine, drawn
//   through the contract primitives in `needs` (docs/GLOBE-PRIMITIVES.md).
//   The factory is the export `name` of ./displays.js, one chunk loaded
//   through import() on every engine kind, outside the Cesium-mode main
//   chunk (but for the displays a layer package also imports as its
//   default); the entry's `display` is its loader. `backends` is the
//   display's engine-specific option, keyed by engine kind: an import()
//   loader of `{ option: value }` merged into the display's options on that
//   engine (Global Context's pulses on Navara).
// - `drawsItself(needs)`: no renderer; the layer draws itself through the
//   contract primitives in `needs` (Wildlife Sightings).
// - `perEngine({ [kind]: loader | DRAWS_ITSELF })`: a layer with no display
//   yet. On each engine kind listed it either draws itself (DRAWS_ITSELF,
//   the open map overlays) or has an engine-specific renderer, an import()
//   loader of its factory. It shows only on the kinds listed.
//
// Every import() here is resolved by `loadLayerRenderers(kind)`, which the
// page awaits before it builds an engine's catalog (src/standalone/
// application.js), so a Cesium page fetches its displays and none of the
// Navara renderers.
// `rendererFor(id, engine, options)` then answers synchronously: the
// layer's renderer on that engine, or null when it draws itself or the
// engine cannot show it.
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
// A layer is available on an engine kind when that engine has every
// primitive its display (or its own drawing) needs, or, without one, when
// its entry lists that kind. The object is frozen; available() and
// unavailable() return fresh arrays. `name` is the layer's display name
// (src/app/layers/directory.js). The layer list takes it as its
// `availability` provider (`{ engine, unavailable() }` is the part it reads).

import { ENGINE_KINDS } from '../../globe/contract.js';
import { APPLICATION_LAYER_DIRECTORY } from './directory.js';

/**
 * The contract's drawing primitives (docs/GLOBE-PRIMITIVES.md). They are
 * required members of every engine (src/globe/contract.js), so every
 * engine kind has them all.
 */
export const CONTRACT_PRIMITIVES = Object.freeze([
  'movers',
  'lines',
  'ground',
  'imagery',
  'meshes',
]);

/** The primitives an engine kind draws with: all of them, on every kind. */
const primitivesOf = (engineKind) =>
  ENGINE_KINDS.includes(engineKind) ? CONTRACT_PRIMITIVES : [];

/** In a `perEngine` entry: the layer draws itself on that engine kind. */
export const DRAWS_ITSELF = Object.freeze({ drawsItself: true });

const checkNeeds = (needs) => {
  if (
    !Array.isArray(needs) ||
    !needs.length ||
    !needs.every((name) => CONTRACT_PRIMITIVES.includes(name))
  )
    throw new TypeError(`Not contract primitives: ${needs}`);
  return Object.freeze([...needs]);
};

const checkLoaders = (loaders, allowDrawsItself) => {
  for (const [kind, loader] of Object.entries(loaders)) {
    if (!ENGINE_KINDS.includes(kind))
      throw new TypeError(`Unknown engine kind for layers: ${kind}`);
    if (
      typeof loader !== 'function' &&
      !(allowDrawsItself && loader === DRAWS_ITSELF)
    )
      throw new TypeError(`Not a loader for ${kind}: ${loader}`);
  }
  return Object.freeze({ ...loaders });
};

/** A layer drawn by its display on every engine (see the module comment). */
function display(name, needs, backends = {}) {
  if (typeof name !== 'string')
    throw new TypeError('A layer display is named by its export');
  return Object.freeze({
    display: async () => {
      const factory = (await displays())[name];
      if (typeof factory !== 'function')
        throw new TypeError(`No layer display ${name} in ./displays.js`);
      return factory;
    },
    needs: checkNeeds(needs),
    backends: checkLoaders(backends, false),
  });
}

/** A layer that draws itself through the contract (no renderer). */
const drawsItself = (needs) => Object.freeze({ needs: checkNeeds(needs) });

/** A layer without a display: its drawing per engine kind. */
const perEngine = (engines) =>
  Object.freeze({ engines: checkLoaders(engines, true) });

/** Navara's own view and classes, for the renderers that still use them. */
const navaraNative = (engine) => engine.extensions.navara;

// Wind streamlines retain their engine backends.
const cesiumWindFlow = async () => {
  const { createWindCesiumFlow } =
    await import('../../layers/wind/render/cesiumFlow.js');
  return { flow: createWindCesiumFlow };
};
const navaraWindFlow = async () => {
  const [{ createWindNavaraFlow }, { createWindFlowMesh }] = await Promise.all([
    import('../../layers/wind/render/navaraFlow.js'),
    import('../../globe/navara/windFlowMesh.js'),
  ]);
  return {
    flow: (engine) =>
      createWindNavaraFlow(engine, navaraNative(engine), createWindFlowMesh),
  };
};

// The layers' displays (./displays.js), one chunk.
const displays = () => import('./displays.js');

/** How every application layer draws, by id, in directory order. */
export const LAYER_MANIFEST = Object.freeze({
  'bhote-koshi-2026': display('createBhoteKoshiDisplay', [
    'imagery',
    'ground',
    'movers',
  ]),
  'bhote-koshi-locator': display('createBhoteKoshiLocatorDisplay', [
    'ground',
    'movers',
  ]),
  // The aircraft family.
  flights: display('createFlightsDisplay', ['movers', 'lines']),
  military: display('createMilitaryDisplay', ['movers', 'lines']),
  'local-adsb': display('createLocalAdsbDisplay', ['movers', 'lines']),
  earthquakes: display('createEarthquakesDisplay', ['ground']),
  'air-quality': display('createAirQualityDisplay', ['ground']),
  'fire-perimeters': display('createPerimetersDisplay', ['ground']),
  'gnss-integrity': display('createGnssDisplay', ['ground']),
  's2-ghostmaps': display('createGhostMapsDisplay', ['movers', 'ground']),
  'drone-airspace': display('createDroneAirspaceDisplay', ['ground']),
  // Draws itself through the globe contract (engine.movers, engine.lines).
  'wildlife-sightings': drawsItself(['movers', 'lines']),
  'alpr-cameras': display('createAlprDisplay', ['movers']),
  'street-level': display('createStreetLevelDisplay', ['movers', 'ground']),
  satellites: display('createSatellitesDisplay', ['movers', 'lines']),
  'rocket-launches': display('createLaunchesDisplay', ['movers', 'lines']),
  traffic: display('createTrafficDisplay', ['movers', 'ground']),
  cctv: display('createCctvDisplay', ['movers', 'lines', 'meshes']),
  radio: display('createRadioDisplay', ['movers']),
  transit: display('createTransitDisplay', ['movers', 'lines']),
  bikeshare: display('createBikeshareDisplay', ['movers']),
  directions: display('createDirectionsDisplay', ['movers', 'ground']),
  'recent-imagery': display('createRecentImageryDisplay', [
    'ground',
    'imagery',
  ]),
  'osm-places': display('createOsmPlacesDisplay', ['movers']),
  'ais-live-vessels': display('createVesselsDisplay', ['movers', 'lines']),
  'military-installations': display('createInstallationsDisplay', [
    'movers',
    'ground',
  ]),
  'military-awareness': display('createAwarenessDisplay', ['lines', 'ground']),
  // The wind field and the weather rasters on engine.imagery; the wind's
  // streamlines are each engine's backend (Cesium's wind renderer, Navara's
  // flow mesh).
  wind: display('createWindDisplay', ['imagery'], {
    cesium: cesiumWindFlow,
    navara: navaraWindFlow,
  }),
  'weather-radar': display('createWeatherDisplay', ['imagery']),
  'weather-satellite': display('createWeatherDisplay', ['imagery']),
  'weather-lightning': display('createWeatherDisplay', ['imagery']),
  'weather-cyclones': display('createCyclonesDisplay', ['movers', 'ground']),
  // The open map overlays drape themselves: Cesium imagery on the viewer,
  // engine.maps.addOverlay on Navara (src/data/osmOverlays.js).
  'sea-marks': perEngine({ cesium: DRAWS_ITSELF, navara: DRAWS_ITSELF }),
  'ski-pistes': perEngine({ cesium: DRAWS_ITSELF, navara: DRAWS_ITSELF }),
  'local-datacenters': display('createInfrastructureDisplay', [
    'movers',
    'lines',
    'ground',
  ]),
  'local-dams': display('createInfrastructureDisplay', [
    'movers',
    'lines',
    'ground',
  ]),
  'telegeography-submarine-cables': display('createCablesDisplay', [
    'movers',
    'lines',
    'ground',
  ]),
  'local-firms': display('createFirmsDisplay', ['movers', 'ground', 'imagery']),
});

/** The manifest entry of a layer, or null. */
const entryOf = (manifest, layerId) =>
  Object.hasOwn(manifest, layerId) ? manifest[layerId] : null;

/** Whether `entry` shows on `engineKind` (see the module comment). */
const entryAvailableOn = (entry, engineKind) => {
  if (!entry) return false;
  if (entry.needs) {
    const primitives = primitivesOf(engineKind);
    return entry.needs.every((name) => primitives.includes(name));
  }
  return Object.hasOwn(entry.engines, engineKind);
};

/** The engine-specific import() loader of a layer on an engine kind, or null. */
const loaderOf = (entry, engineKind) => {
  const loader = entry.backends?.[engineKind] ?? entry.engines?.[engineKind];
  return typeof loader === 'function' ? loader : null;
};

/** Whether a layer has an import() to load on an engine kind. */
const loadsOn = (entry, engineKind) =>
  entryAvailableOn(entry, engineKind) &&
  Boolean(entry.display || loaderOf(entry, engineKind));

/**
 * What a layer's import()s resolve to on an engine kind: its display with
 * the backend's options (`{ display, options }`), or the engine-specific
 * factory.
 */
const loadEntry = async (entry, engineKind) => {
  const loader = loaderOf(entry, engineKind);
  if (!entry.display) return loader();
  const [factory, options] = await Promise.all([
    entry.display(),
    loader ? loader() : {},
  ]);
  return { display: factory, options };
};

// What loadLayerRenderers resolved: engine kind → layer id → value
// (loadEntry's).
const loaded = new Map();
const loading = new Map();

/**
 * Loads every import() the manifest has for `engineKind` (the displays and
 * that engine's renderers and backends), once per page: concurrent calls
 * share the load, and after a failure the next call loads what is still
 * missing.
 * @param {string} engineKind One of ENGINE_KINDS.
 * @returns {Promise<void>}
 */
export function loadLayerRenderers(engineKind) {
  if (!ENGINE_KINDS.includes(engineKind))
    throw new TypeError(`Unknown engine kind for layers: ${engineKind}`);
  if (loading.has(engineKind)) return loading.get(engineKind);
  if (!loaded.has(engineKind)) loaded.set(engineKind, new Map());
  const done = loaded.get(engineKind);
  const load = Promise.all(
    Object.entries(LAYER_MANIFEST).map(async ([id, entry]) => {
      if (loadsOn(entry, engineKind) && !done.has(id))
        done.set(id, await loadEntry(entry, engineKind));
    }),
  ).then(
    () => {
      loading.delete(engineKind);
    },
    (error) => {
      loading.delete(engineKind);
      throw error;
    },
  );
  loading.set(engineKind, load);
  return load;
}

// Renderers of the engine kinds a test brings (a stand-in engine of its
// own kind): layer id → factory. The application's kinds use the manifest.
const standIns = new Map();

/**
 * Test seam: renderer factories `{ [layerId]: (engine, options) => renderer }`
 * for an engine kind outside the application's (ENGINE_KINDS).
 */
export function registerLayerRenderers(engineKind, factories) {
  if (typeof engineKind !== 'string' || !engineKind)
    throw new TypeError('registerLayerRenderers needs an engine kind');
  if (ENGINE_KINDS.includes(engineKind))
    throw new Error(`The layer manifest draws ${engineKind}`);
  const map = standIns.get(engineKind) ?? new Map();
  standIns.set(engineKind, map);
  for (const [layerId, factory] of Object.entries(factories ?? {})) {
    if (typeof factory !== 'function')
      throw new TypeError(
        `Layer renderer for ${layerId} on ${engineKind} is not a factory`,
      );
    if (map.has(layerId))
      throw new Error(
        `Layer ${layerId} already has a renderer on ${engineKind}`,
      );
    map.set(layerId, factory);
  }
}

/**
 * The renderer of a layer on `engine` (its display or engine-specific
 * renderer, built now), or null when the layer draws itself there or the
 * engine cannot show it. Throws when that engine's import()s are not
 * loaded yet (loadLayerRenderers).
 */
export function rendererFor(layerId, engine, options = {}) {
  const engineKind = engine?.kind;
  const standIn = standIns.get(engineKind)?.get(layerId);
  if (standIn) return standIn(engine, options);
  const entry = entryOf(LAYER_MANIFEST, layerId);
  if (!loadsOn(entry, engineKind)) return null;
  const value = loaded.get(engineKind)?.get(layerId);
  if (value === undefined)
    throw new Error(
      `Layer ${layerId} on ${engineKind}: its renderer is not loaded (loadLayerRenderers)`,
    );
  if (entry.display)
    return value.display(engine, { ...options, ...value.options });
  return value(engine, options);
}

/** Whether the application can show a layer on an engine kind. */
export const layerAvailableOn = (layerId, engineKind) =>
  entryAvailableOn(entryOf(LAYER_MANIFEST, layerId), engineKind);

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
 * @param {{ manifest?: object, directory?: { id: string, name: string }[] }} [options]
 *   Test seams: the manifest (some of LAYER_MANIFEST's entries) and the
 *   layer directory.
 * @returns {LayerAvailability}
 */
export function createLayerAvailability(
  engineKind,
  { manifest = LAYER_MANIFEST, directory = APPLICATION_LAYER_DIRECTORY } = {},
) {
  if (!ENGINE_KINDS.includes(engineKind))
    throw new TypeError(`Unknown engine kind for layers: ${engineKind}`);
  const isAvailable = (layerId) =>
    entryAvailableOn(entryOf(manifest, layerId), engineKind);
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
