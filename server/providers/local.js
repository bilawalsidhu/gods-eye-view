import { openAqProxy } from './openAq.js';
import { airQualityFieldProxy } from './airQualityField.js';
import { openSkyProxy } from './aircraft/opensky.js';
import { celestrakProxy, rocketLaunchesProxy } from './space.js';
import { issTelemetryProxy } from './space/issTelemetry.js';
import { tomtomProxy } from './traffic.js';
import { firmsProxy } from './firms.js';
import { terrainHeightsProxy } from './terrain.js';
import { adsbdbProxy } from './aircraft/enrichment.js';
import { overpassProxy } from './overpass.js';
import { militaryInstallationsProxy } from './military-installations.js';
import { regionalBriefProxy } from './regional/briefing.js';
import { geocodeProxy, NOMINATIM_CACHE_DIR } from './regional/place.js';
import { weatherEffectsProxy } from './regional/weather-effects.js';
import { cctvProxy } from './cctv.js';
import { defaultSourceRoot } from './common/source-root.js';
import { radioBrowserProxy } from './radio.js';
import { gbfsProxy } from './gbfs.js';
import { localReceiversProxy } from './local-receivers.js';
import { transitProxy } from './transit.js';
import { railProxy } from './rail.js';
import { adsbLolProxy } from './aircraft/adsb-lol.js';
import { aisLiveProxy } from './vessels/ais-live.js';
import { trackBackfillProxies } from './aircraft/tracks.js';
import { openAiRealtimeProxy } from './openai.js';
import { geminiLiveProxy } from './gemini.js';
import { googlePlacesContextProxy } from './places.js';
import { mapillaryProxy } from './mapillary.js';
import { keySetupEndpoint } from '../standalone/key-setup.js';
import { weatherProxy } from './weather.js';
import { firePerimetersProxy } from './firePerimeters.js';
import { gnssIntegrityProxy } from './gnssIntegrity.js';
import { ghostMapsProxy } from './ghostMaps.js';
import { shipwrecksProxy } from './shipwrecks.js';
import { droneAirspaceProxy } from './droneAirspace.js';
import { newsProxy } from './news.js';
import { inaturalistProxy } from './inaturalist/observations.js';
import { acartiaProxy } from './acartia.js';
import { cycloneProxy } from './cyclones.js';
import { windProxy } from './wind.js';
import { libraryProxy } from './library.js';
import { layerCountsEndpoint } from './common/layerCounts.js';

/**
 * Construct the local provider plugins in their established order.
 * `realtime` configures OpenAI; `gemini` explicitly opts into Gemini Live.
 * `nominatimStorageDir` is the absolute directory the geocode cache binds;
 * omission retains the durable per-source cache and policy state.
 */
function localProviderPlugins({
  realtime,
  gemini,
  nominatimStorageDir = NOMINATIM_CACHE_DIR,
} = {}) {
  const countReaders = {};
  function withCount(layerId, provider) {
    countReaders[layerId] = provider.api.readLayerCount;
    return provider;
  }
  return [
    withCount('flights', openSkyProxy()),
    withCount('satellites', celestrakProxy()),
    issTelemetryProxy(),
    tomtomProxy(),
    withCount('local-firms', firmsProxy()),
    rocketLaunchesProxy(),
    terrainHeightsProxy(),
    adsbdbProxy(),
    overpassProxy(),
    militaryInstallationsProxy(),
    regionalBriefProxy(),
    geocodeProxy({ storageDir: nominatimStorageDir }),
    weatherEffectsProxy(),
    withCount('cctv', cctvProxy({ sourceRoot: defaultSourceRoot })),
    radioBrowserProxy(),
    gbfsProxy(),
    localReceiversProxy(),
    transitProxy(),
    railProxy(),
    adsbLolProxy(),
    withCount('ais-live-vessels', aisLiveProxy()),
    trackBackfillProxies(),
    openAiRealtimeProxy({ realtime }),
    ...(gemini ? [geminiLiveProxy({ realtime: gemini })] : []),
    googlePlacesContextProxy(),
    windProxy(),
    weatherProxy(),
    cycloneProxy(),
    openAqProxy(),
    airQualityFieldProxy(),
    mapillaryProxy(),
    firePerimetersProxy(),
    gnssIntegrityProxy(),
    libraryProxy(),
    ghostMapsProxy(),
    shipwrecksProxy(),
    droneAirspaceProxy(),
    newsProxy(),
    inaturalistProxy(),
    acartiaProxy(),
    layerCountsEndpoint(countReaders),
    keySetupEndpoint(),
  ];
}

export { localProviderPlugins };
