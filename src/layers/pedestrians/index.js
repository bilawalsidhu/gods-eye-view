import * as Cesium from 'cesium';
import {
  LAYER_ID,
  UPDATE_INTERVAL_MS,
  INTENSITY_TIERS,
  INACTIVE_COLOR,
  BASE_RADIUS_M,
  COUNT_WINDOW_MINUTES,
} from './policy.js';
import { pedestrianCountLabel } from './records.js';

export {
  normalizeSensors,
  normalizeCounts,
  mergePedestrianRecords,
  intensityTier,
  windowStartIso,
  parseSensingMs,
  pedestrianCountLabel,
} from './records.js';
export { createMelbournePedestrianSource } from './source.js';
export * from './policy.js';

/** Own one Melbourne pedestrian-counter display and its refresh lifecycle. */
export function createPedestriansLayer({ source } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Pedestrian counters require a snapshot source');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _enabled = false;
  let _lastUpdate = null;
  let _lastError = null;
  let _records = [];

  /** How current the feed snapshot is, in minutes behind wall clock. */
  function feedDelayMin() {
    const asOfMs = _records.find((r) => Number.isFinite(r.asOfMs))?.asOfMs;
    return Number.isFinite(asOfMs)
      ? Math.max(0, Math.round((Date.now() - asOfMs) / 60000))
      : null;
  }

  function tierColor(tier) {
    if (tier == null || !INTENSITY_TIERS[tier])
      return Cesium.Color.fromCssColorString(INACTIVE_COLOR);
    return Cesium.Color.fromCssColorString(INTENSITY_TIERS[tier].color);
  }

  function render() {
    if (!_dataSource) return;
    _dataSource.entities.removeAll();
    for (const record of _records) {
      const color = tierColor(record.tier);
      const radius = record.hasRecent
        ? BASE_RADIUS_M * (1 + (record.tier ?? 0) * 0.9)
        : BASE_RADIUS_M * 0.6;
      _dataSource.entities.add({
        id: `pedestrian:${record.locationId}`,
        position: Cesium.Cartesian3.fromDegrees(record.lon, record.lat),
        ellipse: {
          semiMajorAxis: radius,
          semiMinorAxis: radius,
          material: new Cesium.ColorMaterialProperty(
            color.withAlpha(record.hasRecent ? 0.35 : 0.15),
          ),
          outline: true,
          outlineColor: color.withAlpha(record.hasRecent ? 0.95 : 0.5),
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
        label: {
          text: `${record.description.toUpperCase()}\n${pedestrianCountLabel(record)}`,
          font: '12px system-ui',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -14),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
            0,
            400000,
          ),
        },
        properties: {
          description: record.description,
          windowTotal: record.windowTotal,
          windowMinutes: record.windowMinutes,
          hasRecent: record.hasRecent,
        },
      });
    }
  }

  return {
    id: LAYER_ID,
    name: 'Foot Traffic (Melbourne)',
    icon: '🚶',
    source: source.label || 'Pedestrian counters',
    updateInterval: UPDATE_INTERVAL_MS,

    init(viewer) {
      if (_viewer) throw new Error('Pedestrian layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(LAYER_ID);
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
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const rows = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _records = rows;
        _lastUpdate = Date.now();
        _lastError = null;
        render();
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _lastError = error?.message || 'Pedestrian source unavailable';
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource && viewer) viewer.dataSources.remove(_dataSource, true);
      _dataSource = null;
      _viewer = null;
      _records = [];
      _lastUpdate = null;
      _lastError = null;
    },

    /** Reporting sensors for the analyst engine; [] while disabled/empty. */
    getAnalystRecords(maxCount = 2000) {
      if (!_enabled || !_records.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      return _records
        .filter((record) => record.hasRecent)
        .slice(0, limit)
        .map((record) => ({
          id: record.id,
          lat: record.lat,
          lon: record.lon,
          description: record.description,
          pedestriansWindow: record.windowTotal,
          windowMinutes: record.windowMinutes,
        }));
    },

    getRowControls() {
      const reporting = _records.filter((r) => r.hasRecent).length;
      const delay = feedDelayMin();
      // The council feed publishes in bursts and can lag; name the snapshot's
      // real recency rather than implying it is live to the second.
      const freshness =
        delay == null
          ? ''
          : delay <= 20
            ? ' Data is roughly live.'
            : ` The feed's latest data is about ${delay} min old (it publishes in bursts).`;
      return {
        chips: [],
        legend: [
          {
            label: `Foot traffic · ${reporting} sensors reporting`,
            color: INTENSITY_TIERS[2].color,
            count: reporting,
            blurb:
              `Pedestrians counted in the last ${COUNT_WINDOW_MINUTES} minutes at each fixed City of Melbourne street counter ` +
              '(cyan quiet → coral crowded; gray = no recent reading). ' +
              'These are directional foot-traffic tallies from council sensors — never devices or people — covering central Melbourne only, ' +
              'and a floor: what the sensors measured, not everyone who walked.' +
              freshness +
              ' CC BY City of Melbourne.',
          },
        ],
      };
    },

    getStats() {
      const reporting = _records.filter((r) => r.hasRecent).length;
      const delay = feedDelayMin();
      return {
        count: reporting,
        countLabel: _enabled && reporting ? `${reporting} reporting` : '',
        lastUpdate: _lastUpdate,
        error: _lastError,
        loadingLabel: !_enabled
          ? ''
          : reporting
            ? delay != null && delay > 20
              ? `Feed ~${delay} min behind`
              : ''
            : !_lastError
              ? 'Waiting for Melbourne counter readings'
              : '',
      };
    },
  };
}
