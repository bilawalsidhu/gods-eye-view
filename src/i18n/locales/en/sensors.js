/**
 * English pack — sensor layers (Local ADS-B, ALPR Cameras, Mapped
 * Installations). Values are verbatim; aviation abbreviations (ICAO, ALT,
 * GS, TRK, V/S, FPM, MSG, FT, KT) and band symbols (1090 MHz, 978 MHz UAT)
 * stay tokens.
 */
export default {
  localAdsb: {
    heardBy: 'Heard by your receiver',
    source: {
      webusb: 'browser SDR',
      feed: 'decoder feed',
    },
    status: {
      feedsSource: 'Decoder feeds',
      combinedSource: 'WebUSB + decoder feeds',
      feedProblem: {
        one: 'feed {list} {status}',
        other: 'feeds {list} {status}',
      },
      feedsLive: {
        one: '{live} feed live · {heard}',
        other: '{live} feeds live · {heard}',
      },
      heardRate: '{heard} heard · {rate}',
      heardCount: '{n} heard',
      msgRate: '{rate} msg/s',
      openingReceiver: 'opening receiver',
      checkingFeeds: 'checking decoder feeds',
      webusbUnsupported: 'WebUSB needs desktop Chrome or Edge',
      connectHint: 'connect a receiver in Radio',
      fmMode: 'receiver is in FM mode',
      listening: 'listening',
      usbError: 'USB error',
    },
    card: {
      receiverAndFeed: 'Your RTL-SDR receiver and decoder feed',
      receiverFeed: 'Your decoder feed',
      receiver: 'Your RTL-SDR receiver',
      noCallsign: 'NO CALLSIGN',
      ageValue: '{n} S AGO',
      position: {
        one: 'POSITION {pos} · {messages} MSG',
        other: 'POSITION {pos} · {messages} MSGS',
      },
    },
    feedName: 'feed',
  },
  alpr: {
    rowName: 'ALPR Cameras',
    entity: 'ALPR camera',
    displayFallback: 'ALPR CAMERA',
    sourceFallback: 'Camera source',
    osmMapped: 'OSM MAPPED',
    sourceNamed: 'Source: {name}',
    direction: 'DIRECTION {deg}°',
    publicMapData: 'PUBLIC MAP DATA',
    chipShowNearest: 'SHOW NEAREST',
    chipTitleBlocked:
      'Stop following the current object before navigating to a camera',
    chipTitle: 'Move to the nearest loaded camera and show its details',
    legendLabel: 'Camera badges',
    legendBlurb:
      'Cyan cameras turn coral when selected. Wedges illustrate mapped direction, not measured coverage. Nearby cameras may be outside the screen.',
    noneOnScreen: 'None on screen — nearby cameras are outside the view',
    retrying: 'retrying mapped ALPR cameras',
    loading: 'loading mapped ALPR cameras',
    noDataArea: 'No ALPR data for this area — US and Canada only',
    zoomIn: 'Zoom in to load mapped cameras',
    cached: 'Showing cached locations',
    coverageLimited: 'Coverage limited — zoom in',
    noData: 'No ALPR data for this area',
  },
  installations: {
    loading: 'loading mapped installation context',
    withinKm: 'WITHIN {n} KM',
    viewportOnly: 'CURRENT VIEWPORT ONLY',
    placesUnavailable: 'Google Places search unavailable; showing mapped sites',
    servingCached: 'Serving cached mapped context · {date}',
    tooManySites: 'Too many mapped sites in view to list them all',
    contextUnavailable: 'Installation context unavailable',
  },
};
