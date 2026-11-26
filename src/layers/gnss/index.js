import { rayEllipsoid, toLonLatH } from '../../geo/ellipsoid.js';
import { rectangleCenter } from '../../geo/rectangle.js';
import { toDegrees, toRadians } from '../../geo/vector.js';
import { drawOf, findCamera } from '../../render/rendererOf.js';
import { hexColor } from '../../render/color.js';
import { formatNumber, msg, t, tn } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import {
  GNSS_LEVEL_COLORS,
  GNSS_WINDOW_MS,
  accumulateGnssObservations,
  binGnssCells,
  gnssCellKey,
  gnssCellRing,
  gnssProvenance,
  pruneGnssObservations,
} from './records.js';
export * from './records.js';
export { createAdsbGnssSource } from './source.js';

/**
 * The draw set the cells are drawn in starts with this; each layer has its
 * own (`gnss-integrity:1`, …), so several can share a renderer.
 */
export const GNSS_SET_PREFIX = 'gnss-integrity';
let instances = 0;

/** Low stays visible over land so coverage reads apart from no data. */
const FILL_ALPHA = Object.freeze({ low: 0.3, medium: 0.42, high: 0.55 });
const LEVEL_LABELS = Object.freeze({
  low: msg('Low-accuracy score < 2%'),
  medium: msg('Low-accuracy score 2–10%'),
  high: msg('Low-accuracy score > 10%'),
});

/** The middle of a degree rectangle, across the antimeridian too. */
function degreesCentre(rect) {
  const { lon, lat } = rectangleCenter({
    west: toRadians(rect.west),
    south: toRadians(rect.south),
    east: toRadians(rect.east),
    north: toRadians(rect.north),
  });
  return { lon: toDegrees(lon), lat: toDegrees(lat) };
}

/**
 * Degrees at the centre of the current view, or null before the camera
 * settles: where the eye's line of sight (the ray through the screen
 * centre) meets the ellipsoid, else the middle of the view rectangle, else
 * the point under the eye.
 */
export function defaultGnssViewAnchor(viewer) {
  const camera = findCamera(viewer);
  if (!camera) return null;
  const pose = camera.pose();
  // At globe scale the visible rectangle can be the whole world, whose
  // midpoint is unrelated to the place under the screen centre.
  const centre = rayEllipsoid({
    origin: pose.position,
    direction: pose.direction,
  });
  const rectangle = !centre && camera.viewRectangle();
  const at = centre
    ? toLonLatH(centre)
    : rectangle
      ? degreesCentre(rectangle)
      : pose;
  const latitude = at?.lat;
  const longitude = at?.lon;
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    ? { latitude, longitude }
    : null;
}

/**
 * Own one GNSS navigation-integrity display: rolling integrity observations
 * around the views the user visits, binned into H3 hexagons coloured by the
 * gpsjam low-accuracy score. Share links retain token 3.
 */
export function createGnssIntegrityLayer({
  source,
  viewAnchor = defaultGnssViewAnchor,
  now = () => Date.now(),
  // The end of the window shown; retries and receipt times stay on `now`.
  worldNow = now,
  monotonicNow = () => performance.now(),
  windowMs: requestedWindowMs,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('GNSS integrity layer requires a snapshot source');
  // A source may set its own evidence window; anything but a positive finite
  // duration keeps the default.
  const windowMs =
    Number.isFinite(requestedWindowMs) && requestedWindowMs > 0
      ? requestedWindowMs
      : GNSS_WINDOW_MS;
  let _viewer = null;
  let _fills = null;
  let _request = null;
  let _enabled = false;
  let _cells = [];
  let _signature = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  let _manager = null;
  let _cameraTimer = null;
  let _backgroundRefresh = null;
  let _lastQueryKey = null;
  let _lastRequestAt = -Infinity;
  let _removeCameraEnd = null;
  let _removeCameraChanged = null;
  let _coverage = null;
  let _retryTimer = null;
  let _retryAt = 0;
  let _failureCount = 0;
  const _observations = new Map();
  const provenance = gnssProvenance({ windowMs });

  const queryKey = (anchor) =>
    anchor
      ? `${Math.round(anchor.latitude)},${Math.round(anchor.longitude)}`
      : null;

  function scheduleCameraRefresh() {
    if (!_enabled || !_fills) return;
    if (now() < _retryAt) return;
    const key = queryKey(viewAnchor(_viewer));
    if (!key || key === _lastQueryKey) return;
    clearTimeout(_cameraTimer);
    // Debounce drags and bound moving/follow cameras to at most 24 requests
    // per minute. Nearby views share the proxy's whole-degree cache key.
    _cameraTimer = setTimeout(
      async () => {
        _cameraTimer = null;
        if (!_enabled || _backgroundRefresh || _request) return;
        const key = queryKey(viewAnchor(_viewer));
        if (!key || key === _lastQueryKey) return;
        await refreshInBackground();
      },
      Math.max(600, 2500 - (monotonicNow() - _lastRequestAt)),
    );
  }

  async function refreshInBackground() {
    if (!_enabled || _backgroundRefresh) return;
    const controller = new AbortController();
    _backgroundRefresh = controller;
    try {
      if (_manager)
        await _manager.refreshLayer(layer.id, { signal: controller.signal });
      else await layer.update(undefined, { signal: controller.signal });
    } finally {
      if (_backgroundRefresh === controller) {
        _backgroundRefresh = null;
        scheduleCameraRefresh();
        scheduleRetry();
      }
    }
  }

  function scheduleRetry() {
    clearTimeout(_retryTimer);
    _retryTimer = null;
    if (!_enabled || !_retryAt) return;
    // Long provider cooldowns keep their full deadline. Browser timers cannot
    // exceed ~24 days, so wake in bounded chunks without fetching early.
    _retryTimer = setTimeout(
      () => {
        _retryTimer = null;
        void refreshInBackground();
      },
      Math.min(2147483647, Math.max(0, _retryAt - now())),
    );
    _retryTimer?.unref?.();
  }

  /** Age the store without new evidence, so expired cells leave the globe. */
  function expire() {
    pruneGnssObservations(_observations, worldNow(), { windowMs });
    _cells = binGnssCells(_observations);
    render();
  }

  function render() {
    // Only the id and band change what is drawn; counts alone do not.
    const signature = JSON.stringify(
      _cells.map(({ id, level }) => [id, level]),
    );
    if (signature === _signature) return;
    _signature = signature;
    _fills.set(
      _cells.map((cell) => {
        const ring = gnssCellRing(cell);
        const positions = [];
        for (let i = 0; i < ring.length; i += 2)
          positions.push({ lon: ring[i], lat: ring[i + 1] });
        return {
          id: `${layer.id}:${cell.id}`,
          // H3 edges are great-circle arcs, as a polygon's edges are drawn.
          geometry: { kind: 'polygon', rings: [positions] },
          fill: hexColor(GNSS_LEVEL_COLORS[cell.level], FILL_ALPHA[cell.level]),
          height: 'clampGround',
        };
      }),
    );
  }

  const layer = {
    id: 'gnss-integrity',
    name: 'GNSS Integrity',
    icon: '📡',
    source: 'adsb.lol',
    /** Where each part of the method comes from; see records.js. */
    provenance,
    updateInterval: 60000,

    attachDataManager(manager) {
      _manager = manager;
    },

    init(viewer) {
      if (_viewer)
        throw new Error('GNSS integrity layer is already initialized');
      // The cells never take part in picks: ground geometry under them
      // (another layer's polygons) stays pickable. They are an overlay:
      // drawn flat over the 3D tiles and terrain, never draped onto the
      // tiles (where a cell hundreds of kilometres wide streaks through
      // them) nor hidden under them, and hidden past the horizon.
      _fills = drawOf(viewer).shapes({
        id: `${GNSS_SET_PREFIX}:${++instances}`,
        clampTo: 'overlay',
        pickable: false,
        show: false,
      });
      _viewer = viewer;
      const camera = findCamera(viewer);
      _removeCameraEnd = camera?.on('moveEnd', scheduleCameraRefresh) ?? null;
      _removeCameraChanged =
        camera?.on('changed', scheduleCameraRefresh) ?? null;
    },

    enable() {
      _enabled = true;
      // Cells left from before a long disable must not reappear past the window.
      if (_fills) {
        expire();
        _fills.show = true;
      }
    },

    disable() {
      clearTimeout(_cameraTimer);
      _cameraTimer = null;
      clearTimeout(_retryTimer);
      _retryTimer = null;
      _backgroundRefresh?.abort();
      _backgroundRefresh = null;
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_fills) _fills.show = false;
    },

    async update(_viewerArg, { signal } = {}) {
      if (!_enabled || !_fills || signal?.aborted) return false;
      if (now() < _retryAt) {
        expire();
        scheduleRetry();
        return true;
      }
      _retryAt = 0;
      clearTimeout(_retryTimer);
      _retryTimer = null;
      const anchor = viewAnchor(_viewer);
      // No anchor yet (camera still settling) is not a failure: returning
      // false would make the manager reject the enable. The next interval
      // retries; cells already drawn still age out of the window.
      if (!anchor) {
        expire();
        return true;
      }
      _request?.abort();
      const request = new AbortController();
      _request = request;
      const onAbort = () => request.abort(signal.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      _lastQueryKey = queryKey(anchor);
      _lastRequestAt = monotonicNow();
      _coverage = {
        kind: 'regional',
        latitude: Math.round(anchor.latitude),
        longitude: Math.round(anchor.longitude),
        radiusNm: 250,
      };
      let received = false;
      try {
        const snapshot = await source.getSnapshot(anchor, {
          signal: request.signal,
        });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        received = true;
        // Date the rows by when the proxy observed them: a cached or stale
        // replay keeps its original age instead of restarting the window.
        // The proxy reports that age, so client and server clocks never mix.
        const at = now();
        accumulateGnssObservations(_observations, snapshot.rows, at, {
          windowMs,
          observedAt: at - snapshot.ageMs,
        });
        _cells = binGnssCells(_observations);
        render();
        _stale = snapshot.stale === true;
        _lastUpdate = at - snapshot.ageMs;
        _lastError = null;
        _retryAt = 0;
        _failureCount = 0;
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        // A renderer/programming failure remains a real lifecycle failure.
        // Only acquisition failures are kept enabled for recovery.
        if (received) throw e;
        console.warn('[Data:GNSS] Fetch error:', e);
        _lastError = e?.message || msg('GNSS integrity source unavailable');
        // Keep the last cells only while their evidence is inside the window.
        expire();
        if (e?.retryable === false) return false;
        _failureCount = Math.min(3, _failureCount + 1);
        const delay =
          Number.isFinite(e?.retryAfterMs) && e.retryAfterMs > 0
            ? e.retryAfterMs
            : Math.min(120000, 30000 * 2 ** (_failureCount - 1));
        _retryAt = Math.max(
          _retryAt,
          Math.min(Number.MAX_VALUE, now() + delay),
        );
        // Enabling the display succeeded. Stats still report an unavailable
        // or degraded feed; the manager keeps its normal refresh failure lane.
        return true;
      } finally {
        signal?.removeEventListener('abort', onAbort);
        if (_request === request) _request = null;
        scheduleCameraRefresh();
        scheduleRetry();
      }
    },

    destroy() {
      layer.disable();
      _removeCameraEnd?.();
      _removeCameraChanged?.();
      _removeCameraEnd = null;
      _removeCameraChanged = null;
      _observations.clear();
      _cells = [];
      _signature = null;
      _fills?.dispose();
      _fills = null;
      _viewer = null;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
      _coverage = null;
      _retryAt = 0;
      _failureCount = 0;
      _lastQueryKey = null;
      _manager = null;
    },

    getRowControls() {
      return {
        chips: [],
        info:
          t(
            'Regional sample · 250 nm radius · cells from visited views over {minutes} min',
            { minutes: formatNumber(provenance.window.minutes) },
          ) +
          (_lastError && _retryAt
            ? ` · ${translateFeedError(_lastError)} · ${
                _retryAt <= 8640000000000000
                  ? t('Retrying automatically at {time} UTC', {
                      time: new Date(_retryAt).toISOString().slice(11, 19),
                    })
                  : t('Retrying automatically after provider cooldown')
              }`
            : ''),
        infoTitle: t(
          'Updates automatically after pan or zoom and once a minute. The public feed covers a 250-nautical-mile circle around the view centre; zooming out does not make it a worldwide snapshot. Blank areas had no aircraft reporting navigation accuracy in the window.',
        ),
        legend: ['high', 'medium', 'low'].map((level, index) => ({
          label: t(LEVEL_LABELS[level]),
          color: GNSS_LEVEL_COLORS[level],
          count: _cells.filter((cell) => cell.level === level).length,
          ...(index === 0
            ? {
                blurb: t(
                  'Low-accuracy score = 100 × max(0, bad − 1) / total: one aircraft is discounted, so this is not the raw share. Navigation-integrity anomalies are not a detection of jamming or spoofing.',
                ),
              }
            : {}),
        })),
      };
    },

    /**
     * The navigation-accuracy score band and raw report counts for the
     * already-binned cell under a point. Null while off or unsampled.
     */
    getValueAt(lat, lon) {
      if (!_enabled || !_cells.length) return null;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      if (Math.abs(lat) > 90) return null;
      let id;
      try {
        id = gnssCellKey(lat, lon);
      } catch {
        return null;
      }
      const cell = _cells.find((candidate) => candidate.id === id);
      if (!cell) return null;
      return {
        value: t(LEVEL_LABELS[cell.level]),
        detail: tn(
          cell.aircraft,
          '{degraded} of {count} aircraft reported low accuracy',
          '{degraded} of {count} aircraft reported low accuracy',
          { degraded: formatNumber(cell.degraded) },
        ),
        at: cell.observedAt,
      };
    },

    getStats() {
      return {
        count: _cells.length,
        levels: Object.fromEntries(
          ['low', 'medium', 'high'].map((level) => [
            level,
            _cells.filter((cell) => cell.level === level).length,
          ]),
        ),
        lastUpdate: _lastUpdate,
        error: _lastError,
        retryInSec: _retryAt
          ? Math.max(0, Math.ceil((_retryAt - now()) / 1000))
          : null,
        stale: _stale,
        provenance,
        coverage: _coverage,
        // Load-bearing: without an explicit boolean, layerFeedState reads the
        // adsb.lol source name as a flights fallback (src/data/feedState.js).
        fallback: false,
      };
    },
  };
  return layer;
}
