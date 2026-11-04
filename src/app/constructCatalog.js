import { resolveCatalogSources } from './sourceComposition.js';
import { createWeatherClock } from '../layers/weather/clock.js';
import { createWeatherLayer } from '../layers/weather/index.js';
import { createCyclonesLayer } from '../layers/cyclones/index.js';
import { createWindLayer } from '../layers/wind/index.js';
import { createLayerCatalog } from './catalog.js';
import { createLayerAvailability, rendererFor } from './layers/renderers.js';
import { APPLICATION_LAYER_DIRECTORY } from './layers/directory.js';
import { LAYER_STATE_REGISTRY } from '../data/layerState.js';
import { createMilitaryRegistry } from '../layers/aircraft/classification.js';
import { createApplicationFlights } from './layers/flights.js';
import { createApplicationMilitary } from './layers/militaryFlights.js';
import { createApplicationVessels } from './layers/aisLiveVessels.js';
import { createApplicationCctv } from './layers/cctv.js';
import { createApplicationRadio } from './layers/radio.js';
import { createApplicationTraffic } from './layers/traffic.js';
import { createApplicationBikeshare } from './layers/bikeshare.js';
import { createApplicationDirections } from './layers/directions.js';
import { createApplicationRecentImagery } from './layers/recentImagery.js';
import { createApplicationOsmPlaces } from './layers/osmPlaces.js';
import { createApplicationTransit } from './layers/transit.js';
import { createApplicationInstallations } from './layers/militaryInstallations.js';
import { createApplicationSatellites } from './layers/satellites.js';
import { createApplicationLaunches } from './layers/rocketLaunches.js';
import { createApplicationAlpr } from './layers/alprCameras.js';
import { createApplicationLocalAdsb } from './layers/localAdsb.js';
import { createApplicationAwareness } from './layers/militaryAwareness.js';
import { createApplicationFirms } from './layers/firms.js';
import { createApplicationEarthquakes } from './layers/earthquakes.js';
import { createApplicationAirQuality } from './layers/airQuality.js';
import { createApplicationFirePerimeters } from './layers/perimeters.js';
import { createApplicationGnssIntegrity } from './layers/gnss.js';
import { createApplicationGhostMaps } from './layers/ghostMaps.js';
import { createApplicationDroneAirspace } from './layers/droneAirspace.js';
import { createApplicationCables } from './layers/submarineCables.js';
import { OSM_OVERLAYS, createOsmOverlayLayers } from '../data/osmOverlays.js';
import { createApplicationStreetLevel } from './layers/streetLevel.js';
import { createInfrastructureSessionLayer } from '../layers/infrastructure/index.js';
import { createInfrastructureLayers } from '../data/infrastructure.js';
import { localGeoJsonServices } from './localGeojsonServices.js';
import { createBhoteKoshiEventLayer } from '../data/bhoteKoshiEvent.js';
import { createBhoteKoshiLocatorLayer } from '../data/bhoteKoshiLocator.js';

/**
 * Hardware-local layers are registered like any other but never enter share
 * links or stored layer state: another browser cannot have this receiver.
 */
export const LOCAL_ONLY_LAYER_METADATA = Object.freeze([
  Object.freeze({ id: 'local-adsb', disposition: 'local-only' }),
  // Voice search results belong to this session, like a receiver to this machine.
  Object.freeze({ id: 'osm-places', disposition: 'local-only' }),
]);

/** Serialization metadata for every layer the application catalog constructs. */
export const APPLICATION_LAYER_METADATA = Object.freeze([
  ...LAYER_STATE_REGISTRY,
  ...LOCAL_ONLY_LAYER_METADATA,
]);

/** Construct the current catalog without choosing any source provider.
 * `engineKind` ('cesium' | 'navara'): only the layers that engine can show
 * (src/app/layers/renderers.js) are constructed, in the same order; the
 * catalog keeps the others' metadata (`unavailableMetadata`) and carries
 * the engine's `availability`.
 * Scene engines remain page-owned; layers and classification have this app's lifetime.
 * The manager owns layer destruction, while abort releases classification even if startup fails.
 */
export function createApplicationCatalog({
  surface,
  sources,
  signal,
  metadata = APPLICATION_LAYER_METADATA,
  vesselOptions,
  resolveAsset,
  layerSession,
  nepalBoundaryResolver,
  streetLevelProviders,
  engineKind = 'cesium',
  availability = createLayerAvailability(engineKind),
}) {
  if (!signal?.addEventListener)
    throw new TypeError('An application lifetime signal is required');
  signal.throwIfAborted();
  if (!surface?.groundFloor || !surface?.terrain)
    throw new TypeError('Application surface services are required');

  const sourceComposition = resolveCatalogSources(sources);
  sources = sourceComposition.sources;
  const militaryRegistry =
    layerSession?.militaryRegistry ?? createMilitaryRegistry();
  const weatherClock = layerSession?.weatherClock ?? createWeatherClock();
  if (layerSession && !layerSession.weatherClock) {
    layerSession.weatherClock = weatherClock;
    layerSession.lifetime.signal.addEventListener(
      'abort',
      weatherClock.destroy,
      { once: true },
    );
  }
  const dispose = () => {
    signal.removeEventListener('abort', dispose);
    if (!layerSession) militaryRegistry.dispose();
    if (!layerSession) weatherClock.destroy();
  };
  signal.addEventListener('abort', dispose, { once: true });
  try {
    if (!layerSession?.militaryRegistry) {
      const lifetime = layerSession?.lifetime.signal ?? signal;
      if (sourceComposition.isConfigured('military'))
        militaryRegistry.configureSource(sources.military, {
          signal: lifetime,
        });
      if (layerSession) {
        layerSession.militaryRegistry = militaryRegistry;
        lifetime.addEventListener('abort', militaryRegistry.dispose, {
          once: true,
        });
      }
    }
    // Shared instances (awareness and launches read others) are made once,
    // when the first layer that needs them is built.
    const once = (create) => {
      let value;
      return () => (value ??= create());
    };
    const sessionModel = (id, create) => {
      if (!layerSession) return create();
      const models = (layerSession.models ??= new Map());
      if (!models.has(id)) models.set(id, create());
      return models.get(id);
    };
    const flights = once(() =>
      sessionModel('flights', () =>
        createApplicationFlights({
          surface,
          source: sources.flights,
          militaryRegistry,
          resolveAsset,
        }),
      ),
    );
    const military = once(() =>
      sessionModel('military', () =>
        createApplicationMilitary({
          surface,
          source: sources.military,
          militaryRegistry,
          resolveAsset,
        }),
      ),
    );
    const vessels = once(() =>
      sessionModel('ais-live-vessels', () =>
        createApplicationVessels({
          source: sources.vessels,
          options: vesselOptions,
        }),
      ),
    );
    const installations = once(() =>
      sessionModel('military-installations', () =>
        createApplicationInstallations({
          surface,
          source: sources.installations,
        }),
      ),
    );
    const satellites = once(() =>
      sessionModel('satellites', () =>
        createApplicationSatellites({
          source: sources.satellites,
        }),
      ),
    );
    // Catalog order: [layer id(s), construction]. Only the layers the
    // engine can show are constructed (renderers.js).
    const entries = [
      [
        'bhote-koshi-2026',
        () =>
          sessionModel('bhote-koshi-2026', () =>
            createBhoteKoshiEventLayer({
              createNativeRenderer: (engine) =>
                rendererFor('bhote-koshi-2026', engine),
            }),
          ),
      ],
      [
        'bhote-koshi-locator',
        () =>
          sessionModel('bhote-koshi-locator', () =>
            createBhoteKoshiLocatorLayer({
              boundaryResolver: nepalBoundaryResolver,
              createNativeRenderer: (engine, data) =>
                rendererFor('bhote-koshi-locator', engine, { data }),
            }),
          ),
      ],
      ['flights', flights],
      ['military', military],
      [
        'local-adsb',
        () =>
          sessionModel('local-adsb', () =>
            createApplicationLocalAdsb({
              surface,
              // QA fixture receivers (?qaFeed=local-adsb:fixture, dev only).
              ...(sources.localAdsbFeeds
                ? { feeds: sources.localAdsbFeeds }
                : {}),
              enrichment: sources.flights,
              displayParams: () => flights().getParams(),
              ...(resolveAsset ? { resolveAsset } : {}),
            }),
          ),
      ],
      [
        'earthquakes',
        () =>
          sessionModel('earthquakes', () =>
            createApplicationEarthquakes({ source: sources.earthquakes }),
          ),
      ],
      [
        'air-quality',
        () =>
          sessionModel('air-quality', () =>
            createApplicationAirQuality({ source: sources['air-quality'] }),
          ),
      ],
      [
        'fire-perimeters',
        () =>
          sessionModel('fire-perimeters', () =>
            createApplicationFirePerimeters({
              source: sources['fire-perimeters'],
            }),
          ),
      ],
      [
        'gnss-integrity',
        () =>
          sessionModel('gnss-integrity', () =>
            createApplicationGnssIntegrity({
              source: sources['gnss-integrity'],
              windowMs: sources['gnss-integrity'].windowMs,
            }),
          ),
      ],
      [
        's2-ghostmaps',
        () =>
          sessionModel('s2-ghostmaps', () =>
            createApplicationGhostMaps({ source: sources['s2-ghostmaps'] }),
          ),
      ],
      // Cesium only, and without attachRenderer: built for each catalog and
      // destroyed when its globe leaves, so never a session model (as are
      // osm-places and the OSM overlays).
      [
        'drone-airspace',
        () =>
          createApplicationDroneAirspace({
            source: sources['drone-airspace'],
          }),
      ],
      [
        'alpr-cameras',
        () =>
          sessionModel('alpr-cameras', () =>
            createApplicationAlpr({ surface, source: sources.alpr }),
          ),
      ],
      [
        'street-level',
        () =>
          sessionModel('street-level', () =>
            createApplicationStreetLevel({
              surface,
              nativeRenderer: (engine) => rendererFor('street-level', engine),
              sources: { mapillary: sources.mapillary },
              providers: streetLevelProviders,
            }),
          ),
      ],
      ['satellites', satellites],
      [
        'rocket-launches',
        () =>
          sessionModel('rocket-launches', () =>
            createApplicationLaunches({
              source: sources.launches,
              satellites: satellites(),
            }),
          ),
      ],
      [
        'traffic',
        () =>
          sessionModel('traffic', () =>
            createApplicationTraffic({
              source: sources.traffic,
              surface,
              nativeRenderer: (engine) => rendererFor('traffic', engine),
            }),
          ),
      ],
      [
        'cctv',
        () =>
          sessionModel('cctv', () =>
            createApplicationCctv({ surface, source: sources.cctv }),
          ),
      ],
      [
        'radio',
        () =>
          sessionModel('radio', () =>
            createApplicationRadio({ surface, source: sources.radio }),
          ),
      ],
      [
        'transit',
        () =>
          sessionModel('transit', () =>
            createApplicationTransit({ surface, source: sources.transit }),
          ),
      ],
      [
        'bikeshare',
        () =>
          sessionModel('bikeshare', () =>
            createApplicationBikeshare({ source: sources.bikeshare }),
          ),
      ],
      [
        'directions',
        () =>
          sessionModel('directions', () =>
            createApplicationDirections({
              source: sources.directions,
              surface,
            }),
          ),
      ],
      [
        'recent-imagery',
        () =>
          sessionModel('recent-imagery', () =>
            createApplicationRecentImagery({
              source: sources['recent-imagery'],
            }),
          ),
      ],
      ['osm-places', () => createApplicationOsmPlaces()],
      ['ais-live-vessels', vessels],
      ['military-installations', installations],
      [
        'military-awareness',
        () =>
          sessionModel('military-awareness', () =>
            createApplicationAwareness({
              flights: flights(),
              military: military(),
              vessels: vessels(),
              installations: installations(),
            }),
          ),
      ],
      [
        'wind',
        () =>
          sessionModel('wind', () =>
            createWindLayer({
              feed: sources.wind,
              clock: weatherClock,
              createNativeRendering: (engine) => rendererFor('wind', engine),
            }),
          ),
      ],
      ...['weather-radar', 'weather-satellite', 'weather-lightning'].map(
        (id) => [
          id,
          () =>
            sessionModel(id, () =>
              createWeatherLayer({
                feed: sources.weather,
                id,
                clock: weatherClock,
                createNativeRendering: (engine, options) =>
                  rendererFor(id, engine, options),
              }),
            ),
        ],
      ),
      [
        'weather-cyclones',
        () =>
          sessionModel('weather-cyclones', () =>
            createCyclonesLayer({
              feed: sources.cyclones,
              createNativeRendering: (engine, options) =>
                rendererFor('weather-cyclones', engine, options),
            }),
          ),
      ],
      [OSM_OVERLAYS.map(({ id }) => id), () => createOsmOverlayLayers()],
      [
        ['local-datacenters', 'local-dams'],
        () =>
          sessionModel('local-infrastructure', () =>
            createInfrastructureLayers(
              localGeoJsonServices,
              (config, services) =>
                createInfrastructureSessionLayer(
                  config,
                  services,
                  (engine, descriptor, ops) =>
                    rendererFor(config.id, engine, {
                      config: descriptor,
                      services: ops,
                    }),
                ),
            ),
          ),
      ],
      [
        'telegeography-submarine-cables',
        () =>
          sessionModel('telegeography-submarine-cables', () =>
            createApplicationCables({ source: sources.cables, session: true }),
          ),
      ],
      [
        'local-firms',
        () =>
          sessionModel('local-firms', () =>
            createApplicationFirms({
              surface,
              id: 'local-firms',
              name: 'FIRMS Active Fires',
              icon: '▲',
              source: 'NASA FIRMS · LIVE',
              feed: sources.firms,
            }),
          ),
      ],
    ];
    const available = (id) => availability.isAvailable(id);
    const layers = [];
    for (const [ids, create] of entries) {
      const wanted = [ids].flat().filter(available);
      if (!wanted.length) continue;
      for (const layer of [create()].flat())
        if (wanted.includes(layer.id)) layers.push(layer);
    }
    const catalog = createLayerCatalog(
      layers,
      metadata.filter(({ id }) => available(id)),
    );
    return Object.freeze({
      ...catalog,
      engineKind,
      // Layers this engine cannot show: their metadata, so links keep their
      // state (data.js), and the stable availability API (renderers.js).
      unavailableMetadata: Object.freeze(
        metadata.filter(({ id }) => !available(id)),
      ),
      availability,
      getSourceAvailability: sourceComposition.createAvailabilityLookup(
        catalog.layers,
        {
          omitted: new Set(
            APPLICATION_LAYER_DIRECTORY.map(({ id }) => id).filter(
              (id) => !available(id),
            ),
          ),
        },
      ),
      militaryRegistry,
      surface,
      weatherClock,
    });
  } catch (error) {
    dispose();
    throw error;
  }
}
