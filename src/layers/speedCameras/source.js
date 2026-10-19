import {
  OVERPASS_URL,
  OVERPASS_STATUS_URL,
  CAPABILITY_PROBE_TIMEOUT_MS,
  CAPABILITY_PROBE_RETRY_MS,
  MAX_VIEWPORT_DEGREES,
  QUERY_SNAP_DEGREES,
  QUERY_LIMIT,
} from './policy.js';
import { buildSpeedCameraQuery, normalizeSpeedCameraNode } from './records.js';
// msg() for a module the server and tools may also import: marks English that
// stays in data for `npm run i18n` without loading the catalogs (marker.js).
import { msg } from '../../i18n/marker.js';

/**
 * A capability miss holds until re-probed: `OVERPASS_UPSTREAMS` is not
 * configured, so no Overpass route can answer. The source re-probes after
 * CAPABILITY_PROBE_RETRY_MS (and on resetCapability, called by a fresh
 * enable) instead of retrying on every pan. Kept stable so tests and the
 * feed-state mapping can recognize it (see main's unavailable-capability
 * contract: never schedule an automatic retry).
 */
export const SPEED_CAMERAS_NOT_CONFIGURED = msg('Overpass is not configured');

/**
 * Viewport-bounded OpenStreetMap speed camera source through the shared
 * `/api/overpass` proxy. Construct without starting a request; `fetch(box)`
 * resolves a snapshot for one snapped viewport or throws.
 *
 * Before the first query the source probes `GET /api/overpass/status`; an
 * explicit `configured:false` answers every fetch with the not-configured
 * error without a POST (re-probed after CAPABILITY_PROBE_RETRY_MS), so the
 * layer never shows "temporarily unavailable" on every pan of a stock
 * install. `resetCapability()` forgets the answer so a fresh enable asks
 * again.
 */
export function createSpeedCameraSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  let capability = null; // null = unknown, false = not configured, true = configured
  let capabilityRetryAt = 0;
  let capabilityProbe = null;
  let capabilityEpoch = 0;

  function notConfiguredError() {
    // retryable:false — the feed maps this to UNAVAILABLE, not DEGRADED, and
    // the layer stops querying until the probe flips or the page reloads.
    return Object.assign(
      new Error(`${SPEED_CAMERAS_NOT_CONFIGURED} (see /api/overpass/status)`),
      { code: 'OVERPASS_NOT_CONFIGURED', retryable: false },
    );
  }

  function probeCapability(signal) {
    if (capability !== null) {
      if (capability || Date.now() < capabilityRetryAt) return capability;
      // An explicit configured:false is re-probed once the retry window
      // passes: the operator may set OVERPASS_UPSTREAMS without a reload.
      capability = null;
    }
    if (Date.now() < capabilityRetryAt) return null; // unknown; let the query ask
    const epoch = capabilityEpoch;
    capabilityProbe ??= fetchImpl(OVERPASS_STATUS_URL, {
      signal: AbortSignal.any(
        [AbortSignal.timeout(CAPABILITY_PROBE_TIMEOUT_MS), signal].filter(
          Boolean,
        ),
      ),
    }).then(
      (response) => {
        capabilityProbe = null;
        if (epoch !== capabilityEpoch) return capability; // reset mid-flight
        if (response.ok) {
          return response
            .json()
            .then((payload) => {
              if (typeof payload?.configured === 'boolean') {
                capability = payload.configured;
                if (!capability)
                  capabilityRetryAt = Date.now() + CAPABILITY_PROBE_RETRY_MS;
                return capability;
              }
              if (epoch === capabilityEpoch)
                capabilityRetryAt = Date.now() + CAPABILITY_PROBE_RETRY_MS;
              return null;
            })
            .catch(() => {
              if (epoch === capabilityEpoch)
                capabilityRetryAt = Date.now() + CAPABILITY_PROBE_RETRY_MS;
              return null;
            });
        }
        if (epoch === capabilityEpoch)
          capabilityRetryAt = Date.now() + CAPABILITY_PROBE_RETRY_MS;
        return null;
      },
      () => {
        capabilityProbe = null;
        if (epoch === capabilityEpoch)
          capabilityRetryAt = Date.now() + CAPABILITY_PROBE_RETRY_MS;
        return null;
      },
    );
    return capabilityProbe;
  }

  /**
   * Forget the capability answer (and any in-flight probe) so the next fetch
   * asks `/api/overpass/status` again. The layer calls this on a fresh
   * enable so an operator configuring upstreams live is picked up without a
   * page reload.
   */
  function resetCapability() {
    capabilityEpoch += 1;
    capability = null;
    capabilityProbe = null;
    capabilityRetryAt = 0;
  }

  async function fetchSpeedCameras(box, signal) {
    signal?.throwIfAborted();
    if (
      !box ||
      ![box.south, box.west, box.north, box.east].every(Number.isFinite) ||
      box.south < -90 ||
      box.north > 90 ||
      box.west < -180 ||
      box.east > 180 ||
      box.north <= box.south ||
      box.east <= box.west ||
      box.north - box.south >
        MAX_VIEWPORT_DEGREES + 2 * QUERY_SNAP_DEGREES + 1e-9 ||
      box.east - box.west > MAX_VIEWPORT_DEGREES + 2 * QUERY_SNAP_DEGREES + 1e-9
    ) {
      throw new TypeError('Speed cameras require a bounded city viewport');
    }
    const configured = await probeCapability(signal);
    if (configured === false) throw notConfiguredError();
    const query = buildSpeedCameraQuery(
      box.south,
      box.west,
      box.north,
      box.east,
    );
    const response = await fetchImpl(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      signal,
    });
    if (!response.ok) {
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        /* non-JSON error; status remains authoritative */
      }
      // Key the not-configured label on the payload code alone: main's proxy
      // also answers a plain 503 (no code) when it is busy, and that must
      // surface as "temporarily unavailable", not "not configured".
      const message =
        payload?.code === 'OVERPASS_NOT_CONFIGURED'
          ? SPEED_CAMERAS_NOT_CONFIGURED
          : response.status === 429
            ? 'Overpass rate-limited'
            : response.status === 504
              ? 'Overpass timed out'
              : 'Overpass temporarily unavailable';
      const error = Object.assign(new Error(message), {
        code: payload?.code,
        retryable:
          payload?.code === 'OVERPASS_NOT_CONFIGURED'
            ? false
            : payload?.retryable !== false,
      });
      if (payload?.code === 'OVERPASS_NOT_CONFIGURED') {
        capability = false;
        capabilityRetryAt = Date.now() + CAPABILITY_PROBE_RETRY_MS;
      }
      throw error;
    }
    const stale = response.headers.get('x-overpass-cache') === 'STALE';
    const snapshotPayload = await response.json();
    signal?.throwIfAborted();
    // The shared proxy already rejects query errors. Validate here too so a
    // malformed or partial response never becomes an authoritative empty map.
    if (!Array.isArray(snapshotPayload?.elements) || snapshotPayload.remark) {
      throw new Error('Overpass returned an incomplete camera response');
    }
    return {
      records: [
        ...new Map(
          snapshotPayload.elements
            .slice(0, QUERY_LIMIT)
            .map(normalizeSpeedCameraNode)
            .filter(Boolean)
            .map((record) => [record.id, record]),
        ).values(),
      ],
      stale,
      saturated: snapshotPayload.elements.length >= QUERY_LIMIT,
    };
  }

  return {
    fetch: fetchSpeedCameras,
    /** Forget the capability answer; the next fetch re-probes (see above). */
    resetCapability,
    label: msg('OpenStreetMap · community mapped'),
    attribution: {
      name: 'OpenStreetMap',
      description: 'OpenStreetMap contributors (ODbL 1.0; community mapped)',
      text: '© OpenStreetMap contributors',
      href: 'https://www.openstreetmap.org/copyright',
    },
  };
}
