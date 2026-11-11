// Display factories by layer id, with engine-specific wind flow backends.
function display(name, backends = {}) {
  return Object.freeze({
    display: async () => (await displays())[name],
    backends,
  });
}

// Wind streamlines retain their engine backends.
const cesiumWindFlow = async () => {
  const { createWindCesiumFlow } =
    await import('../../globe/cesium/windFlow.js');
  return { flow: createWindCesiumFlow };
};
const navaraWindFlow = async () => {
  const [{ createWindNavaraFlow }, { createWindFlowMesh }] = await Promise.all([
    import('../../globe/navara/windFlow.js'),
    import('../../globe/navara/windFlowMesh.js'),
  ]);
  return {
    flow: (engine) =>
      createWindNavaraFlow(
        engine,
        engine.extensions.navara,
        createWindFlowMesh,
      ),
  };
};

const cesiumWeatherFrames = async () => {
  const { createWeatherFrameRendering } =
    await import('../../globe/cesium/weatherFrames.js');
  return { frameRendering: createWeatherFrameRendering };
};

// The layers' displays (./displays.js), one chunk.
const displays = () => import('./displays.js');

export const LAYER_MANIFEST = Object.freeze({
  'bhote-koshi-2026': display('createBhoteKoshiDisplay'),
  'bhote-koshi-locator': display('createBhoteKoshiLocatorDisplay'),
  // The aircraft family.
  flights: display('createFlightsDisplay'),
  military: display('createMilitaryDisplay'),
  'local-adsb': display('createLocalAdsbDisplay'),
  earthquakes: display('createEarthquakesDisplay'),
  'air-quality': display('createAirQualityDisplay'),
  'fire-perimeters': display('createPerimetersDisplay'),
  'gnss-integrity': display('createGnssDisplay'),
  's2-ghostmaps': display('createGhostMapsDisplay'),
  shipwrecks: Object.freeze({}),
  'drone-airspace': display('createDroneAirspaceDisplay'),
  news: Object.freeze({}),
  // Draws itself through the globe contract (engine.movers, engine.lines).
  'wildlife-sightings': Object.freeze({}),
  'alpr-cameras': display('createAlprDisplay'),
  'street-level': display('createStreetLevelDisplay'),
  satellites: display('createSatellitesDisplay'),
  'rocket-launches': display('createLaunchesDisplay'),
  traffic: display('createTrafficDisplay'),
  cctv: display('createCctvDisplay'),
  radio: display('createRadioDisplay'),
  transit: display('createTransitDisplay'),
  bikeshare: display('createBikeshareDisplay'),
  directions: display('createDirectionsDisplay'),
  'recent-imagery': display('createRecentImageryDisplay'),
  'osm-places': display('createOsmPlacesDisplay'),
  'ais-live-vessels': display('createVesselsDisplay'),
  'military-installations': display('createInstallationsDisplay'),
  'military-awareness': display('createAwarenessDisplay'),
  // The wind field and the weather rasters on engine.imagery; the wind's
  // streamlines are each engine's backend (Cesium's wind renderer, Navara's
  // flow mesh).
  wind: display('createWindDisplay', {
    cesium: cesiumWindFlow,
    navara: navaraWindFlow,
  }),
  'weather-radar': display('createWeatherDisplay', {
    cesium: cesiumWeatherFrames,
  }),
  'weather-satellite': display('createWeatherDisplay', {
    cesium: cesiumWeatherFrames,
  }),
  'weather-lightning': display('createWeatherDisplay', {
    cesium: cesiumWeatherFrames,
  }),
  'weather-cyclones': display('createCyclonesDisplay'),
  // The open map overlays draw through imagery, or the optional native
  // maps.addOverlay path (src/data/osmOverlays.js).
  'sea-marks': Object.freeze({}),
  'ski-pistes': Object.freeze({}),
  'local-datacenters': display('createInfrastructureDisplay'),
  'local-dams': display('createInfrastructureDisplay'),
  'telegeography-submarine-cables': display('createCablesDisplay'),
  'local-firms': display('createFirmsDisplay'),
});

const loaded = new Map();
const loading = new Map();

/** Load the displays and wind backend once per engine kind. */
export function loadLayerRenderers(engineKind) {
  if (loading.has(engineKind)) return loading.get(engineKind);
  if (!loaded.has(engineKind)) loaded.set(engineKind, new Map());
  const done = loaded.get(engineKind);
  const load = Promise.all(
    Object.entries(LAYER_MANIFEST).map(async ([id, entry]) => {
      if (!entry.display || done.has(id)) return;
      const [factory, options] = await Promise.all([
        entry.display(),
        entry.backends[engineKind]?.() ?? {},
      ]);
      done.set(id, { factory, options });
    }),
  ).finally(() => loading.delete(engineKind));
  loading.set(engineKind, load);
  return load;
}

/** Build a loaded display, or return null for a layer that draws itself. */
export function rendererFor(layerId, engine, options = {}) {
  const entry =
    Object.hasOwn(LAYER_MANIFEST, layerId) && LAYER_MANIFEST[layerId];
  if (!entry?.display) return null;
  if (!engine) return null;
  const engineKind = engine.kind;
  const value = loaded.get(engineKind)?.get(layerId);
  if (!value)
    throw new Error(
      `Layer ${layerId} on ${engineKind}: its renderer is not loaded (loadLayerRenderers)`,
    );
  return value.factory(engine, { ...options, ...value.options });
}
