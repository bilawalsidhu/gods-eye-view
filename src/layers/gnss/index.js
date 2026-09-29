import * as Cesium from 'cesium';
import {
  GNSS_LEVEL_COLORS,
  GNSS_WINDOW_MS,
  accumulateGnssObservations,
  binGnssCells,
} from './records.js';
export * from './records.js';
export { createAdsbGnssSource } from './source.js';

const FILL_ALPHA = Object.freeze({ low: 0.14, medium: 0.32, high: 0.45 });
const LEVEL_LABELS = Object.freeze({
  low: 'Under 2% degraded',
  medium: '2–10% degraded',
  high: 'Over 10% degraded',
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
 * Own one GNSS-interference display: rolling integrity observations around
 * the views the user visits, binned into cells coloured by the share of
 * aircraft reporting degraded navigation integrity.
 */
export function createGnssInterferenceLayer({
  source,
  viewAnchor = defaultGnssViewAnchor,
  now = () => Date.now(),
  windowMs = GNSS_WINDOW_MS,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('GNSS interference requires a snapshot source');
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

  function render() {
    const signature = JSON.stringify(
      _cells.map(({ id, level, aircraft, degraded }) => [
        id,
        level,
        aircraft,
        degraded,
      ]),
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
    name: 'GNSS Interference',
    icon: '📡',
    source: 'adsb.lol',
    updateInterval: 60000,

    init(viewer) {
      if (_viewer)
        throw new Error('GNSS interference layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('gnss-interference');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
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
      if (!anchor) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const snapshot = await source.getSnapshot(anchor, {
          signal: request.signal,
        });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        accumulateGnssObservations(_observations, snapshot.rows, now(), {
          windowMs,
        });
        _cells = binGnssCells(_observations);
        render();
        _stale = snapshot.stale;
        _lastUpdate = now();
        _lastError = null;
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:GNSS] Fetch error:', e);
        _lastError = e?.message || 'GNSS integrity source unavailable';
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
                blurb:
                  'Share of ADS-B aircraft reporting low navigation integrity (NIC/NACp) over the last 30 minutes, around the views you visit. An inference of jamming or spoofing, not a detection.',
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
        fallback: false,
      };
    },
  };
  return layer;
}
