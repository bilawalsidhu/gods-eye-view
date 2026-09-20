import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import {
  LAYER_ID,
  UPDATE_INTERVAL_MS,
  HISTORY_WINDOW_MS,
  PATTERN_COLOR,
} from './policy.js';
import { appendSample, circlingAssessment, isCircling } from './circling.js';

export { appendSample, circlingAssessment, isCircling } from './circling.js';
export * from './policy.js';

/**
 * Own one circling-pattern display derived from the flight layers' records.
 * No network source: `services.flights` / `services.military` are the live
 * catalog layer instances, read through the same getAnalystRecords seam the
 * voice analyst uses. An aircraft only accumulates track while its own
 * layer is enabled and this layer is updating.
 */
export function createPatternWatchLayer({ services, overlayHost } = {}) {
  const feeds = [services?.flights, services?.military].filter(Boolean);
  if (!feeds.length)
    throw new TypeError('Pattern watch requires at least one aircraft layer');
  if (
    typeof overlayHost?.setEntries !== 'function' ||
    typeof overlayHost?.setVisible !== 'function' ||
    typeof overlayHost?.clearSource !== 'function'
  )
    throw new TypeError('Pattern watch requires the world-overlay host');
  let _viewer = null;
  let _dataSource = null;
  let _enabled = false;
  let _lastUpdate = null;
  let _flagged = [];
  /** id → {samples, callsign, military, altitudeM, lat, lon} */
  const _tracks = new Map();

  function sweep(nowMs) {
    const seen = new Set();
    for (const feed of feeds) {
      if (typeof feed.getAnalystRecords !== 'function') continue;
      for (const record of feed.getAnalystRecords(Number.MAX_SAFE_INTEGER) ||
        []) {
        const icao24 = String(record?.icao24 || '')
          .trim()
          .toLowerCase();
        const id = icao24 || String(record?.id || '').trim();
        if (
          !id ||
          !Number.isFinite(record.lat) ||
          !Number.isFinite(record.lon) ||
          record.onGround
        )
          continue;
        seen.add(id);
        let track = _tracks.get(id);
        if (!track) {
          track = { samples: [] };
          _tracks.set(id, track);
        }
        appendSample(
          track,
          { tMs: nowMs, lat: record.lat, lon: record.lon },
          nowMs,
        );
        track.callsign = record.callsign || record.icao24 || record.id;
        track.military = Boolean(record.military);
        track.altitudeM = record.altitudeM ?? null;
        track.lat = record.lat;
        track.lon = record.lon;
      }
    }
    // Aircraft gone from every feed for a full window forget their history.
    for (const [id, track] of _tracks) {
      if (seen.has(id)) continue;
      const last = track.samples[track.samples.length - 1];
      if (!last || nowMs - last.tMs > HISTORY_WINDOW_MS) _tracks.delete(id);
    }
    const flagged = [];
    for (const [id, track] of _tracks) {
      if (!seen.has(id)) continue;
      const assessment = circlingAssessment(track.samples);
      if (!isCircling(assessment)) continue;
      flagged.push({
        id,
        callsign: track.callsign,
        military: track.military,
        altitudeM: track.altitudeM,
        lat: track.lat,
        lon: track.lon,
        centerLat: assessment.center.lat,
        centerLon: assessment.center.lon,
        radiusM: assessment.radiusM,
        turns: Math.abs(assessment.totalTurnDeg) / 360,
        minutes: assessment.spanMs / 60000,
      });
    }
    return flagged;
  }

  function render(flagged) {
    if (!_dataSource) return;
    _dataSource.entities.removeAll();
    const accent = Cesium.Color.fromCssColorString(PATTERN_COLOR);
    const overlayEntries = [];
    for (const flag of flagged) {
      const ringRadius = Math.max(flag.radiusM * 1.25, 1500);
      _dataSource.entities.add({
        id: `pattern:${flag.id}`,
        position: Cesium.Cartesian3.fromDegrees(flag.centerLon, flag.centerLat),
        ellipse: {
          semiMajorAxis: ringRadius,
          semiMinorAxis: ringRadius,
          material: new Cesium.ColorMaterialProperty(accent.withAlpha(0.12)),
          outline: true,
          outlineColor: accent.withAlpha(0.9),
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
        properties: {
          callsign: flag.callsign,
          military: flag.military,
          turns: flag.turns,
          minutes: flag.minutes,
          radiusM: flag.radiusM,
        },
      });
      overlayEntries.push({
        id: `pattern:${flag.id}`,
        position: Cesium.Cartesian3.fromDegrees(flag.centerLon, flag.centerLat),
        variant: 'label',
        title: `${t(msg('CIRCLING'))} · ${String(flag.callsign).toUpperCase()}`,
        details: [
          `${flag.turns.toFixed(1)} ${t(msg('TURNS'))} · ${Math.round(flag.minutes)} ${t(msg('minutes'))}`,
        ],
        accent: PATTERN_COLOR,
        priority: 1000,
        collisionGroup: 'ambient-label',
        paintLane: 'ambient-label',
        edgeFade: 'keyhole',
        horizonCull: true,
        terrainOcclusion: false,
        maxDistance: 3_000_000,
        interactive: false,
      });
    }
    overlayHost.setEntries(LAYER_ID, overlayEntries, {
      cohortLimit: 256,
      collisionCapacity: 96,
      moving: false,
    });
  }

  return {
    id: LAYER_ID,
    name: 'Pattern Watch',
    icon: '🔄',
    source: 'Derived from live flight feeds',
    updateInterval: UPDATE_INTERVAL_MS,

    init(viewer) {
      if (_viewer) throw new Error('Pattern watch is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      overlayHost.setVisible(LAYER_ID, false);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(LAYER_ID, true);
    },

    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      _flagged = [];
      overlayHost.clearSource(LAYER_ID);
      overlayHost.setVisible(LAYER_ID, false);
    },

    update() {
      if (!_enabled || !_dataSource) return false;
      _flagged = sweep(Date.now());
      render(_flagged);
      _lastUpdate = Date.now();
      return true;
    },

    destroy(viewer = _viewer) {
      this.disable();
      if (_dataSource && viewer) viewer.dataSources.remove(_dataSource, true);
      _dataSource = null;
      _viewer = null;
      _tracks.clear();
      _flagged = [];
      _lastUpdate = null;
    },

    /**
     * Flagged aircraft for the analyst engine — id, position, and the
     * pattern evidence (turns, minutes, radius). [] while disabled.
     */
    getAnalystRecords(maxCount = 2000) {
      if (!_enabled || !_flagged.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      return _flagged.slice(0, limit).map((flag) => ({
        id: flag.id,
        lat: flag.lat,
        lon: flag.lon,
        callsign: flag.callsign,
        military: flag.military,
        turns: Number(flag.turns.toFixed(1)),
        minutes: Math.round(flag.minutes),
        radiusM: Math.round(flag.radiusM),
      }));
    },

    getRowControls() {
      return {
        chips: [],
        legend: [
          {
            label: t(msg('Circling flags')),
            color: PATTERN_COLOR,
            count: _flagged.length,
            blurb: t(
              msg(
                'Aircraft whose recent track keeps turning one way inside a small area (≥2 revolutions over ≥4 minutes). A flag describes the flight path, not the mission: training, traffic watch, survey work, and airport holding stacks all circle. Tracks build from the enabled flight layers — turn on Live Flights or Military Aircraft and give it a few minutes.',
              ),
            ),
          },
        ],
      };
    },

    getStats() {
      const feeding = feeds.some(
        (feed) => (feed.getAnalystRecords?.() || []).length > 0,
      );
      return {
        count: _flagged.length,
        countLabel:
          _enabled && _flagged.length
            ? `${_flagged.length} ${t(msg('circling'))}`
            : '',
        lastUpdate: _lastUpdate,
        error: null,
        loadingLabel: !_enabled
          ? ''
          : !feeding
            ? t(msg('Needs Live Flights or Military Aircraft enabled'))
            : _flagged.length
              ? ''
              : t(
                  msg(
                    'Watching for circling tracks — patterns need a few minutes of history',
                  ),
                ),
      };
    },
  };
}
