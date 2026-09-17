/** Frame construction and failure classification for the weather layer. */

/**
 * Marker for "the server says no credential is configured".
 *
 * This layer has no keyless mode, so a missing key is a standing state the row
 * must name rather than a transient outage to retry quietly. It is kept
 * distinct from "the status probe could not be reached", which looks identical
 * from the outside and means something else entirely: one is a thing the
 * operator can fix, the other may be a passing network fault.
 */
export const NO_KEY = 'no_key';

/** The error the source throws when the server reports no credential. */
export function noKeyError() {
  const error = new Error('ADD XWEATHER KEY');
  error.code = NO_KEY;
  return error;
}

/** Whether a rejection means the key is absent rather than the service unwell. */
export function isNoKeyError(error) {
  return error?.code === NO_KEY;
}

/**
 * A frame for a service that publishes no time dimension at all.
 *
 * The tile endpoint always serves its current composite, so there is nothing
 * to read or pin. The poll stamp is the change key: a new one each refresh is
 * what makes the imagery stack rebuild the layer, which is in turn what makes
 * Cesium re-request its tiles.
 *
 * `refreshMs` rides along because the server owns the cadence. It is set from
 * measured call volume against a billable quota, so the client must not hold
 * an opinion of its own about how often to ask.
 */
export function liveFrame(now = Date.now(), refreshMs = null) {
  return {
    key: `live:${now}`,
    validTime: null,
    referenceTime: null,
    refreshMs: Number.isFinite(refreshMs) && refreshMs > 0 ? refreshMs : null,
  };
}
