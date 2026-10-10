/**
 * Loading feedback: the top-center status chip, traffic-sync fallback, and the
 * mapped-site availability table shared with the layer row. Retry copy keeps
 * the "reason — follow-up" shape; presentation splits on " — ".
 */
export default {
  layerFallback: 'Layer',
  trafficFallback: 'syncing road network',
  overpassDetail: 'OpenStreetMap · Overpass',
  overpassUnavailable: 'Overpass temporarily unavailable',
  camera: {
    retryIn: 'ALPR cameras · retrying in {seconds}s',
    retryPending: 'ALPR cameras · retry pending',
    retrying: 'RETRYING ALPR CAMERAS',
    fetching: 'FETCHING ALPR CAMERAS',
  },
  sites: {
    retrying: 'RETRYING MAPPED SITES',
    fetching: 'FETCHING MAPPED SITES',
  },
  batch: {
    loading: 'LOADING LIVE DATA',
    refreshing: 'REFRESHING LIVE DATA',
    turningOff: 'TURNING OFF LIVE DATA',
    complete: 'LOAD COMPLETE',
    cancelled: 'LOAD CANCELLED',
    failed: 'LOAD FAILED',
    liveOff: 'LIVE DATA OFF',
    sitesLoaded: 'MAPPED SITES LOADED',
  },
  install: {
    rate_limited: 'Overpass rate-limited',
    timeout: 'Overpass timed out',
    query_failed: 'Overpass could not complete the query',
    tiles_unavailable: 'Map tiles temporarily unavailable',
    names_unavailable: 'Mapped names temporarily unavailable',
    unavailable: 'Overpass temporarily unavailable',
    fetching: 'Fetching mapped sites…',
    retrying: 'Retrying mapped sites…',
    retryingIn: '{reason} — retrying in {seconds}s',
    retryPending: '{reason} — retry pending',
    zoomIn: 'Zoom in to search mapped installations',
    stale: 'Showing cached mapped sites',
    idle: 'Mapped sites not loaded',
    whereNear: ' within {km} km of the contact',
    whereInView: ' in view',
    noSites: 'No mapped sites{where}',
    sites: {
      one: '{count} mapped site{where}',
      other: '{count} mapped sites{where}',
    },
    loaded: 'Mapped sites loaded',
  },
};
