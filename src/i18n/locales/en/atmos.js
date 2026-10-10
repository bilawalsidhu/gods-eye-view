/** Atmosphere layers — observed weather products (src/layers/weather) and the
 * wind forecast layer (src/layers/wind). Layer registration names/sources stay
 * English (voice/HUD matching); the `row` entries name their display form. */
export default {
  row: {
    weatherRadar: 'Rain radar',
    weatherLightning: 'Lightning density',
    weatherSatellite: 'Satellite clouds',
    weatherSource: 'NOAA nowCOAST · OBSERVED',
    wind: 'Wind',
    windSource: 'GFS / ECMWF IFS · FORECAST',
  },
  weather: {
    error: {
      frame: 'Frame unavailable; previous observation retained',
      imagery: 'Weather imagery unavailable',
      source: 'Weather source unavailable; previous observation retained',
      generic: 'Weather unavailable',
      // Stable rendering-module messages, named at this presentation edge.
      tiles: 'Weather tiles unavailable · previous frame retained',
      someTiles: 'Some weather tiles unavailable',
      hostHidden: 'Hidden by this map source · choose a globe map',
    },
    summary: {
      radar: 'Rain radar · US',
      lightning: 'Lightning density · 15 min',
      satellite: 'Satellite clouds',
      coverage: {
        conus: 'CONUS',
        lightning: 'Americas + Pacific',
        global: 'Global · 60°S–60°N',
        northAmerica: 'North America',
      },
      detail: '{mode} · {time} · {lag}{relation}',
      observationUnavailable: 'Observation unavailable',
      waitingForObservation: 'Waiting for observation',
      delayed: 'Source observations delayed',
      stale: 'Stale source',
      loading: 'Loading next frame…',
      outside: 'Map center outside coverage',
    },
    observed: 'Observed',
    history: 'History',
    chips: {
      northAmerica: 'N. America',
      global: 'Global',
      cloudsOnly: 'Clouds only',
      full: 'Full',
      soft: 'Soft',
      vivid: 'Vivid',
      viewRadar: 'View US radar',
      viewLightning: 'View Americas & Pacific',
      viewCoverage: 'View coverage',
      globalMosaicTitle: 'Hourly global mosaic; usually 2–3 hours delayed',
      regionalCloudsTitle:
        'GOES regional clouds; approximately 5-minute updates',
      cloudsOnlyTitle:
        'Dim everything but the bright, cold cloud tops; a brightness filter, not a cloud mask',
      fullTitle: 'The complete infrared image at the chosen opacity',
      opacityTitle: 'Image opacity; does not alter the observed values',
    },
    legend: {
      radar: '{label} dBZ radar reflectivity',
      lightning: '{label} strikes/km²/min ×10³ (15-minute density)',
    },
    info: {
      radar: 'RADAR REFLECTIVITY · dBZ',
      lightning: 'LIGHTNING DENSITY · 15 min accumulation',
      globalInfrared: 'GLOBAL INFRARED · hourly',
      goesInfrared: 'GOES INFRARED · ~5 min',
      latest: 'Latest observation',
      loading: ' · loading',
      frame: ' · frame {i}/{n}',
      observationUnavailable: 'Observation: unavailable',
      stale: 'STALE · cached source metadata',
      radarScope: 'Contiguous US · gaps ≠ no rain',
      lightningScope: 'Americas + Pacific · not individual strikes',
      lightningColor: 'Color: strikes/km²/min ×10³',
      globalScope: '60°S–60°N · typically 2–3 h delayed',
      regionalScope: 'North America · infrared imagery',
      outside: 'Map center is outside source coverage',
      reducedMotionClock: 'Reduced motion · history playback unavailable',
      reducedMotionManual: 'Reduced motion · manual history available',
    },
    infoTitle: {
      lightning:
        'NOAA/NWS 15-minute lightning density derived from Vaisala NLDN/GLD360. Coverage 110°E across the Pacific/Americas to 0°, 25°S–80°N. Not a live strike count, global coverage or a safety warning.',
      radar:
        'NOAA MRMS radar echoes indicate precipitation patterns, not rain rate, a storm warning or a future forecast. Native source approximately 1 km; display is limited to level 6. Frames use exact advertised observation times.',
      satellite:
        'GOES-19/18 longwave infrared Band 14 regional; NESDIS global longwave mosaic. Clouds only dims everything but bright, cold cloud tops; a brightness filter, not a cloud mask. Coverage and freshness differ by region.',
    },
    settings: { region: 'REGION', image: 'IMAGE', opacity: 'OPACITY' },
  },
  wind: {
    error: {
      unavailable: 'Wind unavailable',
      source: 'Wind source unavailable',
      // Stable rendering-module messages, named at this presentation edge.
      globeImagery: 'Globe imagery unavailable',
      globeFieldImage: 'Globe field image unavailable',
      temperatureField: 'temperature field unavailable',
      pressureField: 'pressure field unavailable',
    },
    status: {
      loading: 'Loading forecast',
      stale: 'Cached forecast · stale',
      model: 'Model forecast',
      preparing: 'Preparing flow',
      scalarMissing: 'Selected field unavailable',
      history: 'Forecast · does not follow history',
    },
    overlay: {
      none: 'Wind motion',
      speed: 'Wind speed',
      pressure: 'Sea-level pressure',
      temperature: 'Air temperature · 2 m',
    },
    coverage: 'Global · 1° grid',
    detail: '{model} forecast · {time}',
    chips: {
      reducedMotion: 'Reduced motion',
      resume: 'Resume',
      pause: 'Pause',
      pauseTitle:
        'Pause visual flow; forecast time does not advance with animation',
      none: 'None',
      speed: 'Speed',
      pressure: 'Pressure',
      temperature: 'Temperature',
      noneTitle: 'Wind trails with no field shading',
      speedTitle: 'How hard the surface wind is blowing',
      pressureTitle: 'Sea-level air pressure: broad highs and lows',
      temperatureTitle: 'Air temperature two meters above the surface',
      ecmwfTitle: 'ECMWF IFS surface forecast',
      gfsTitle: 'NOAA GFS surface forecast',
      unitsTitle: 'Wind speed units',
      readWind: 'Read wind at map center',
      readWindTitle:
        'Read the forecast at the center of the map without changing selection',
    },
    info: {
      header: '{model} forecast · {field} ({units})',
      valid: 'Valid: {time}',
      issued: 'Issued: {time}',
      loading: ' · loading',
      preparing: ' · preparing',
      stale: ' · STALE',
      scalarMissing: 'Selected field unavailable · wind remains visible',
      imagerySuffix: '{error} · wind remains visible',
    },
    infoTitle:
      'Surface wind at 10 m. Approximately 1° global grid. Curves follow the 10 m wind field, lifted 12 km for visibility; display height is not weather altitude. View lighting is for readability. Animation shows flow through one fixed forecast; it does not advance time. Color fields drape the globe basemap or the active photorealistic 3D Tiles.',
    settings: {
      model: 'MODEL',
      field: 'FIELD',
      units: 'UNITS',
      motion: 'MOTION',
    },
    countLabel: 'Forecast',
    reading: {
      calm: '{speed} · calm',
      from: '{speed} from {bearing}',
      label: 'WIND AT {coordinates}',
      meta: '{model} · valid {time}',
      scalar: '{scalarLabel} · {scalarValue}',
    },
    noReading: {
      coordinates: 'No surface reading',
      wind: 'Aim the map center at Earth',
      explanation:
        'A location reading needs a loaded forecast and the Earth at the center of the view.',
    },
    explanation:
      'Interpolated model forecast on an approximately 1° grid. Broad weather patterns, not a street-level measurement.',
  },
};
