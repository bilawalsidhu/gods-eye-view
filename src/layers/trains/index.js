import * as Cesium from 'cesium';
import {
  LAYER_ID,
  UPDATE_INTERVAL_MS,
  MAX_RENDERED,
  TRAIN_COLOR,
  LABEL_MAX_DISTANCE_M,
  TRAIN_EXTRAPOLATION_MAX_MS,
} from './policy.js';
import { parseFixTimeMs, trainShownDegrees } from './records.js';

export {
  trainHeadingDeg,
  normalizeTrainsPayload,
  parseFixTimeMs,
  trainShownDegrees,
} from './records.js';
export { createAmtrakerTrainSource } from './source.js';
export * from './policy.js';

/** One-line status under the label: speed and the next station when known. */
export function trainStatusLine(record) {
  const parts = [];
  if (Number.isFinite(record.velocityMph))
    parts.push(`${record.velocityMph} MPH`);
  if (record.nextStation) parts.push(`→ ${record.nextStation.toUpperCase()}`);
  return parts.join(' ');
}

/** Own one live-train display and its refresh lifecycle. */
export function createLiveTrainsLayer({ source, services } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Live trains require a snapshot source');
  // Dots move between polls (dead reckoning off real fixes), so while the
  // layer is enabled it holds the demand-driven render loop open the way the
  // aircraft layers do. Optional: without render services the layer still
  // works, just repainting on data refreshes only.
  const holdRender = services?.render?.holdContinuousRender;
  const releaseRender = services?.render?.releaseContinuousRender;
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _records = [];
  /** id → {fixes: [{timeMs, lon, lat}]} — the last two real GPS fixes. */
  const _tracks = new Map();

  const layer = {
    id: LAYER_ID,
    name: 'Live Trains',
    icon: '🚆',
    source: source.label || 'Live train positions',
    updateInterval: UPDATE_INTERVAL_MS,

    init(viewer) {
      if (_viewer) throw new Error('Live trains layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      _records = [];
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      holdRender?.(LAYER_ID);
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      releaseRender?.(LAYER_ID);
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

        const fallback = Cesium.Color.fromCssColorString(TRAIN_COLOR);
        const retained = new Set();
        for (const record of rows.slice(0, MAX_RENDERED)) {
          retained.add(record.id);
          // Track upkeep: append a fix only when the telemetry moved on, so
          // repeated polls of one stale fix never fake a fresh observation.
          const fixTimeMs = parseFixTimeMs(record.updatedAt) ?? Date.now();
          let track = _tracks.get(record.id);
          if (!track) {
            track = {
              fixes: [{ timeMs: fixTimeMs, lon: record.lon, lat: record.lat }],
            };
            _tracks.set(record.id, track);
          } else {
            const last = track.fixes[track.fixes.length - 1];
            if (
              fixTimeMs > last.timeMs &&
              (record.lon !== last.lon || record.lat !== last.lat)
            ) {
              track.fixes.push({
                timeMs: fixTimeMs,
                lon: record.lon,
                lat: record.lat,
              });
              if (track.fixes.length > 2) track.fixes.shift();
            }
          }

          const accent = record.accent
            ? Cesium.Color.fromCssColorString(record.accent)
            : fallback;
          const status = trainStatusLine(record);
          const labelText =
            `${record.routeName.toUpperCase()}${record.trainNum ? ` ${record.trainNum}` : ''}` +
            (status ? `\n${status}` : '');
          const existing = _dataSource.entities.getById(record.id);
          if (existing) {
            // Entities persist across polls; only presentation values change.
            // The position callback already reads the mutated track.
            existing.label.text = labelText;
            existing.point.color = accent;
            for (const [key, value] of Object.entries({
              velocityMph: record.velocityMph,
              nextStation: record.nextStation,
              timeliness: record.timeliness,
            }))
              existing.properties[key] = value;
            continue;
          }
          _dataSource.entities.add(
            new Cesium.Entity({
              id: record.id,
              // Dead-reckoned every frame from the last two real fixes.
              position: new Cesium.CallbackProperty(() => {
                const shown = trainShownDegrees(
                  track,
                  Date.now(),
                  TRAIN_EXTRAPOLATION_MAX_MS,
                );
                return Cesium.Cartesian3.fromDegrees(shown.lon, shown.lat);
              }, false),
              point: {
                pixelSize: 8,
                color: accent,
                outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
                outlineWidth: 2,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                scaleByDistance: new Cesium.NearFarScalar(350, 1.3, 6e6, 0.5),
              },
              label: {
                text: labelText,
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
                  LABEL_MAX_DISTANCE_M,
                ),
              },
              properties: {
                routeName: record.routeName,
                trainNum: record.trainNum,
                velocityMph: record.velocityMph,
                nextStation: record.nextStation,
                origin: record.origin,
                destination: record.destination,
                timeliness: record.timeliness,
                provider: record.provider,
              },
            }),
          );
        }
        // Trains that completed their run leave the display and the tracks.
        for (const entity of [..._dataSource.entities.values]) {
          if (retained.has(entity.id)) continue;
          _dataSource.entities.remove(entity);
          _tracks.delete(entity.id);
        }
        _records = rows;
        _count = _dataSource.entities.values.length;
        _lastUpdate = Date.now();
        _lastError = null;
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _lastError = error?.message || 'Train source unavailable';
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      releaseRender?.(LAYER_ID);
      if (_dataSource && viewer) viewer.dataSources.remove(_dataSource, true);
      _dataSource = null;
      _viewer = null;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _records = [];
      _tracks.clear();
    },

    /**
     * Snapshot the loaded trains as plain JSON-safe objects for the analyst
     * query engine. On-demand only — no listeners, no caching. Returns []
     * while the layer is disabled or empty. (Wired to voice separately, so
     * the seam ships without another schema re-pin.)
     * @param {number} [maxCount=2000] - Maximum records to return.
     */
    getAnalystRecords(maxCount = 2000) {
      if (!_enabled || !_records.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      return _records.slice(0, limit).map((record) => ({
        id: record.id,
        lat: record.lat,
        lon: record.lon,
        routeName: record.routeName,
        trainNum: record.trainNum,
        velocityMph: record.velocityMph,
        nextStation: record.nextStation,
        origin: record.origin,
        destination: record.destination,
        timeliness: record.timeliness,
      }));
    },

    getStats() {
      return {
        count: _count,
        countLabel: _enabled && _count ? `${_count} active` : '',
        lastUpdate: _lastUpdate,
        error: _lastError,
      };
    },
  };
  return layer;
}
