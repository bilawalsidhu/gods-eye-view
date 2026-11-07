import * as geo from '../../geo/index.js';

export function createState({ services }) {
  const state = {};

  state.distanceEndpointScratch = geo.cartographic.create();

  state.distanceGeodesicScratch = geo.ellipsoidGeodesic.create();

  Object.assign(state, {
    viewer: null,
    engine: null,
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
    timer: null,
    googleSearchRequested: false,
    /** Contacts subject position; when set, it replaces the camera viewport. */
    contextAnchor: null,
    /** Latest subject centre, independent of the retained tile-fetch anchor. */
    contextPosition: null,
    /** Coverage of the last successful load: viewport, or radius around a subject. */
    coverage: { kind: 'viewport' },
  });
  return state;
}
