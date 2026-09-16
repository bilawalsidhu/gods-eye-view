/**
 * @file Melbourne pedestrian-counter layer.
 *
 * Data source: the City of Melbourne Pedestrian Counting System — a network
 * of fixed, directional pedestrian counters at street level in central
 * Melbourne, published open (CC BY) through the council's Opendatasoft
 * portal. Two keyless, CORS-open datasets:
 *   - sensor locations (id, description, coordinates, status)
 *   - past-hour counts per minute (per-sensor pedestrian tallies)
 *
 * This is FOOT TRAFFIC from dedicated counters that publish tallies — never
 * devices, identifiers, or individuals. A count is how many people a fixed
 * sensor tallied in a time window, nothing about who they were. Coverage is
 * central Melbourne only, and a floor: it is what the council's sensors
 * measured, not everyone who walked.
 *
 * @module data/melbournePedestrians
 */

export const LAYER_ID = 'melbourne-pedestrians';

const BASE =
  'https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets';

export const SENSORS_URL = `${BASE}/pedestrian-counting-system-sensor-locations/records`;
export const COUNTS_URL = `${BASE}/pedestrian-counting-system-past-hour-counts-per-minute/records`;

/** The council publishes minute tallies; poll to match. */
export const UPDATE_INTERVAL_MS = 60000;

/** Counts are summed over this trailing window, and the label names it, so a
 * single quiet minute never reads as "nobody here". */
export const COUNT_WINDOW_MINUTES = 15;

/** A sensor whose newest reading is older than this has no CURRENT count: it
 * renders as inactive/unknown, never as zero. Sized above the window so a
 * sensor mid-window is not prematurely called stale. */
export const STALE_AFTER_MS = 25 * 60 * 1000;

/** Opendatasoft caps a page; the aggregate returns one row per sensor
 * (≤134 possible, ~99 seen live), so two pages always suffice. */
export const PAGE_SIZE = 100;

/** Graduated intensity tiers — trailing-window pedestrian totals. Vendor-
 * neutral cyan→coral ramp, matching the app's accent language. */
export const INTENSITY_TIERS = Object.freeze([
  { max: 50, color: '#3a7bd5', label: 'quiet' },
  { max: 200, color: '#52d4ff', label: 'light' },
  { max: 600, color: '#f5c451', label: 'busy' },
  { max: Infinity, color: '#ff6474', label: 'crowded' },
]);

/** Marker for a located sensor with no current reading. */
export const INACTIVE_COLOR = '#6b7280';

/** Base disc radius (m) per intensity tier index, scaled on the globe. */
export const BASE_RADIUS_M = 120;
