import * as Cesium from 'cesium';
import { DEFAULT_FAMILY, DEFAULT_WINDOW_YEARS } from './policy.js';

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
    /** Whether the upstream held more sites in view than this response carries. */
    saturated: false,
    /** True upstream match count, which may exceed the rendered records. */
    totalSiteCount: 0,
    /** Active analyte family; every request is scoped to exactly one. */
    family: DEFAULT_FAMILY,
    windowYears: DEFAULT_WINDOW_YEARS,
    /**
     * Start of the sampling window the CURRENT records answer for. Distinct from
     * lastUpdate, which is when this client fetched: a site in these records may
     * not have been sampled for years, and conflating the two would report a
     * healthy feed as stale forever.
     */
    sampledSince: null,
    loading: false,
    abort: null,
    /** Measurements for selected sites, filled lazily on selection. */
    measurementsBySite: new Map(),
    measurementsLoading: false,
    measurementsError: null,
    /**
     * Second controller on purpose: a camera move must abort site loading
     * without killing an in-flight card fetch for a site being read.
     */
    measurementsAbort: null,
    /** Pending timed retry while status is 'unavailable'. */
    retryTimer: null,
    /** Current backoff step for that retry; 0 = next failure starts at the minimum. */
    retryDelayMs: 0,
    retryAt: 0,
    failureReason: null,
    moveEndRemove: null,
    clickHandler: null,
    timer: null,
  });
  return state;
}
