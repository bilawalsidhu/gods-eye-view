import { resolveCatalogSources } from './sourceComposition.js';
import { createWeatherClock } from '../layers/weather/clock.js';
import { worldClock } from '../time/worldClock.js';
import { createWeatherLayer } from '../layers/weather/index.js';
import { createApplicationCyclones } from './layers/cyclones.js';
import { createWindLayer } from '../layers/wind/index.js';
import { createLayerCatalog } from './catalog.js';
import { rendererFor } from './layers/renderers.js';
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
import { createApplicationWildlifeSightings } from './layers/wildlifeSightings.js';
import { createApplicationCables } from './layers/submarineCables.js';
import { createOsmOverlayLayers } from '../data/osmOverlays.js';
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
  const weatherClock =
    layerSession?.weatherClock ?? createWeatherClock({ world: worldClock });
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
    const sessionModel = (id, create) => {
      if (!layerSession) return create();
      const models = (layerSession.models ??= new Map());
      if (!models.has(id)) models.set(id, create());
      return models.get(id);
    };
    const flights = sessionModel('flights', () =>
      createApplicationFlights({
        surface,
        source: sources.flights,
        militaryRegistry,
        resolveAsset,
      }),
    );
    const military = sessionModel('military', () =>
      createApplicationMilitary({
        surface,
        source: sources.military,
        militaryRegistry,
        resolveAsset,
      }),
    );
    const vessels = sessionModel('ais-live-vessels', () =>
      createApplicationVessels({
        source: sources.vessels,
        options: vesselOptions,
      }),
    );
    const installations = sessionModel('military-installations', () =>
      createApplicationInstallations({
        surface,
        source: sources.installations,
      }),
    );
    const satellites = sessionModel('satellites', () =>
      createApplicationSatellites({
        source: sources.satellites,
      }),
    );
    const layers = [
      sessionModel('bhote-koshi-2026', () =>
        createBhoteKoshiEventLayer({
          createNativeRenderer: (engine) =>
            rendererFor('bhote-koshi-2026', engine),
        }),
      ),
      sessionModel('bhote-koshi-locator', () =>
        createBhoteKoshiLocatorLayer({
          boundaryResolver: nepalBoundaryResolver,
          createNativeRenderer: (engine, data) =>
            rendererFor('bhote-koshi-locator', engine, { data }),
        }),
      ),
      flights,
      military,
      sessionModel('local-adsb', () =>
        createApplicationLocalAdsb({
          surface,
          // QA fixture receivers (?qaFeed=local-adsb:fixture, dev only).
          ...(sources.localAdsbFeeds ? { feeds: sources.localAdsbFeeds } : {}),
          enrichment: sources.flights,
          displayParams: () => flights.getParams(),
          ...(resolveAsset ? { resolveAsset } : {}),
        }),
      ),
      sessionModel('earthquakes', () =>
        createApplicationEarthquakes({ source: sources.earthquakes }),
      ),
      sessionModel('air-quality', () =>
        createApplicationAirQuality({ source: sources['air-quality'] }),
      ),
      sessionModel('fire-perimeters', () =>
        createApplicationFirePerimeters({
          source: sources['fire-perimeters'],
        }),
      ),
      sessionModel('gnss-integrity', () =>
        createApplicationGnssIntegrity({
          source: sources['gnss-integrity'],
          windowMs: sources['gnss-integrity'].windowMs,
        }),
      ),
      sessionModel('s2-ghostmaps', () =>
        createApplicationGhostMaps({ source: sources['s2-ghostmaps'] }),
      ),
      sessionModel('drone-airspace', () =>
        createApplicationDroneAirspace({
          source: sources['drone-airspace'],
        }),
      ),
      sessionModel('wildlife-sightings', () =>
        createApplicationWildlifeSightings({
          source: sources['wildlife-sightings'],
          groundFloor: surface.groundFloor,
        }),
      ),
      sessionModel('alpr-cameras', () =>
        createApplicationAlpr({ surface, source: sources.alpr }),
      ),
      sessionModel('street-level', () =>
        createApplicationStreetLevel({
          surface,
          nativeRenderer: (engine) => rendererFor('street-level', engine),
          sources: { mapillary: sources.mapillary },
          providers: streetLevelProviders,
        }),
      ),
      satellites,
      sessionModel('rocket-launches', () =>
        createApplicationLaunches({
          source: sources.launches,
          satellites: satellites,
        }),
      ),
      sessionModel('traffic', () =>
        createApplicationTraffic({
          source: sources.traffic,
          surface,
        }),
      ),
      sessionModel('cctv', () =>
        createApplicationCctv({ surface, source: sources.cctv }),
      ),
      sessionModel('radio', () =>
        createApplicationRadio({ surface, source: sources.radio }),
      ),
      sessionModel('transit', () =>
        createApplicationTransit({ surface, source: sources.transit }),
      ),
      sessionModel('bikeshare', () =>
        createApplicationBikeshare({ source: sources.bikeshare }),
      ),
      sessionModel('directions', () =>
        createApplicationDirections({
          source: sources.directions,
          surface,
        }),
      ),
      sessionModel('recent-imagery', () =>
        createApplicationRecentImagery({
          source: sources['recent-imagery'],
        }),
      ),
      sessionModel('osm-places', () => createApplicationOsmPlaces()),
      vessels,
      installations,
      sessionModel('military-awareness', () =>
        createApplicationAwareness({
          flights: flights,
          military: military,
          vessels: vessels,
          installations: installations,
        }),
      ),
      sessionModel('wind', () =>
        createWindLayer({
          feed: sources.wind,
          clock: weatherClock,
          createNativeRendering: (engine, options) =>
            rendererFor('wind', engine, options),
        }),
      ),
      ...['weather-radar', 'weather-satellite', 'weather-lightning'].map((id) =>
        sessionModel(id, () =>
          createWeatherLayer({
            feed: sources.weather,
            id,
            clock: weatherClock,
            createNativeRendering: (engine, options) =>
              rendererFor(id, engine, options),
          }),
        ),
      ),
      sessionModel('weather-cyclones', () =>
        createApplicationCyclones({
          feed: sources.cyclones,
          createNativeRendering: (engine, options) =>
            rendererFor('weather-cyclones', engine, options),
        }),
      ),
      ...sessionModel('osm-overlays', () => createOsmOverlayLayers()),
      ...sessionModel('local-infrastructure', () =>
        createInfrastructureLayers(localGeoJsonServices, (config, services) =>
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
      sessionModel('telegeography-submarine-cables', () =>
        createApplicationCables({ source: sources.cables, session: true }),
      ),
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
    ];
    const catalog = createLayerCatalog(layers, metadata);
    return Object.freeze({
      ...catalog,
      engineKind,
      getSourceAvailability: sourceComposition.createAvailabilityLookup(
        catalog.layers,
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
