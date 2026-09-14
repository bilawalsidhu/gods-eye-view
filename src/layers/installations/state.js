import * as Cesium from 'cesium';

export function createState({ services }) {
  const state = {};

  state.distanceEndpointScratch = new Cesium.Cartographic();

  state.distanceGeodesicScratch = new Cesium.EllipsoidGeodesic();

  Object.assign(state, {
    viewer: null,
    dataSource: null,
    enabled: false,
    records: [],
    recordById: new Map(),
    selectedId: null,
    lastUpdate: null,
    error: null,
    status: 'idle',
    stale: false,
    /** Whether the upstream truncated at its element cap for the current view. */
    saturated: false,
    loading: false,
    abort: null,
    /** Pending timed retry while status is 'unavailable' (see scheduleUnavailableRetry). */
    retryTimer: null,
    /** Current backoff step for that retry; 0 = next failure starts at the minimum. */
    retryDelayMs: 0,
    retryAt: 0,
    failureReason: null,
    moveEndRemove: null,
    clickHandler: null,
    timer: null,
    googleSearchRequested: false,
  });
  return state;
}
