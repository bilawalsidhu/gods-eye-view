import * as Cesium from 'cesium';
import {
  GNSS_LEVEL_COLORS,
  GNSS_MIN_AIRCRAFT,
  GNSS_NACP_THRESHOLD,
  GNSS_NIC_THRESHOLD,
  GNSS_WINDOW_MS,
  accumulateGnssObservations,
  binGnssCells,
  gnssProvenance,
  pruneGnssObservations,
} from './records.js';
export * from './records.js';
export { createAdsbGnssSource } from './source.js';

/** Low stays visible over land so coverage reads apart from no data. */
const FILL_ALPHA = Object.freeze({ low: 0.3, medium: 0.42, high: 0.55 });
const LEVEL_LABELS = Object.freeze({
  low: 'Under 2% low accuracy',
  medium: '2–10% low accuracy',
  high: 'Over 10% low accuracy',
});

/** Degrees at the centre of the current view, or null before the camera settles. */
export function defaultGnssViewAnchor(viewer) {
  const rectangle = viewer?.camera?.computeViewRectangle?.(
    viewer.scene?.globe?.ellipsoid,
  );
  const carto = rectangle
    ? Cesium.Rectangle.center(rectangle)
    : viewer?.camera?.positionCartographic;
  if (!carto) return null;
  const latitude = Cesium.Math.toDegrees(carto.latitude);
  const longitude = Cesium.Math.toDegrees(carto.longitude);
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    ? { latitude, longitude }
    : null;
}

/**
 * Own one GNSS navigation-integrity display: rolling integrity observations
 * around the views the user visits, binned into cells coloured by the share
 * of aircraft reporting low navigation accuracy. The layer id keeps its
 * original `gnss-interference` spelling because share links depend on it.
 */
export function createGnssIntegrityLayer({
  source,
  viewAnchor = defaultGnssViewAnchor,
  now = () => Date.now(),
  windowMs = GNSS_WINDOW_MS,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('GNSS integrity layer requires a snapshot source');
  let _viewer = null;
  let _dataSource = null;
  let _request = null;
  let _enabled = false;
  let _cells = [];
  let _signature = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  const _observations = new Map();
  const provenance = gnssProvenance({ windowMs });

  /** Age the store without new evidence, so expired cells leave the globe. */
  function expire() {
    pruneGnssObservations(_observations, now(), { windowMs });
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
    _dataSource.entities.removeAll();
    for (const cell of _cells) {
      const color = Cesium.Color.fromCssColorString(
        GNSS_LEVEL_COLORS[cell.level],
      );
      _dataSource.entities.add(
        new Cesium.Entity({
          id: `gnss-interference:${cell.id}`,
          rectangle: {
            coordinates: Cesium.Rectangle.fromDegrees(
              cell.west,
              cell.south,
              cell.east,
              cell.north,
            ),
            material: new Cesium.ColorMaterialProperty(
              color.withAlpha(FILL_ALPHA[cell.level]),
            ),
            classificationType: Cesium.ClassificationType.BOTH,
          },
        }),
      );
    }
  }

  const layer = {
    id: 'gnss-interference',
    name: 'GNSS Integrity',
    icon: '📡',
    source: 'adsb.lol',
    /** Where each part of the method comes from; see records.js. */
    provenance,
    updateInterval: 60000,

    init(viewer) {
      if (_viewer)
        throw new Error('GNSS integrity layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('gnss-interference');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    enable() {
      _enabled = true;
      // Cells left from before a long disable must not reappear past the window.
      if (_dataSource) {
        expire();
        _dataSource.show = true;
      }
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
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
      try {
        const snapshot = await source.getSnapshot(anchor, {
          signal: request.signal,
        });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
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
        _lastUpdate = now();
        _lastError = null;
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:GNSS] Fetch error:', e);
        _lastError = e?.message || 'GNSS integrity source unavailable';
        // Keep the last cells only while their evidence is inside the window.
        expire();
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      _observations.clear();
      _cells = [];
      _signature = null;
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
    },

    getRowControls() {
      return {
        chips: [],
        legend: ['high', 'medium', 'low'].map((level, index) => ({
          label: LEVEL_LABELS[level],
          color: GNSS_LEVEL_COLORS[level],
          count: _cells.filter((cell) => cell.level === level).length,
          ...(index === 0
            ? {
                blurb: `Share of ADS-B aircraft reporting low navigation accuracy over the last ${provenance.window.minutes} minutes, around the views you visit. An aircraft counts when it reports NIC < ${GNSS_NIC_THRESHOLD} or NACp < ${GNSS_NACP_THRESHOLD} or GPS loss: a GEV threshold borrowed from US ADS-B Out minima, not a published interference test. Cells use gpsjam.org's formula and 2% / 10% bands. Cells with fewer than ${GNSS_MIN_AIRCRAFT} aircraft are not drawn, so blank areas mean no data, not clean GNSS. Medium and high cells are navigation-integrity anomalies. Suspected jamming or spoofing is one possible cause, not a detection: avionics faults also report low values.`,
              }
            : {}),
        })),
      };
    },

    getStats() {
      return {
        count: _cells.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
        provenance,
        // Load-bearing: without an explicit boolean, layerFeedState reads the
        // adsb.lol source name as a flights fallback (src/data/feedState.js).
        fallback: false,
      };
    },
  };
  return layer;
}
