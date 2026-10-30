import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import {
  ENTSOE_DESCRIPTION,
  ENTSOE_KEY_ID,
  ENTSOE_LOAD_BANDS,
  ENTSOE_OVERLAY_COLLISION_CAPACITY,
  ENTSOE_OVERLAY_COHORT_LIMIT,
  ENTSOE_OVERLAY_SOURCE_ID,
  entsoeBandColor,
  entsoePointValidTime,
  mapEntsoeRecord,
} from './model.js';
export * from './model.js';
export { createEntsoeSource } from './source.js';

/** How many points of the series the globe draws. */
const MAX_DRAWN_POINTS = 96;

/**
 * Own one European grid display: the total-load series for the day as a
 * chain of coloured ground anchors.
 *
 * The layer needs an ENTSO-E operator token. Without one the proxy answers
 * 503 {error:'no_key'} and the layer reports `stats.keyRequired`, so the row
 * reads as a step the operator can take rather than a broken feed.
 */
export function createEntsoeGridLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('ENTSO-E grid requires a snapshot source');
  if (!overlayHost)
    throw new TypeError('ENTSO-E grid requires an overlay host');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _series = [];
  let _unit = null;
  let _day = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _keyRequired = false;
  let _enabled = false;
  // Which half of the day the card shows: the whole day-ahead forecast, or
  // only the hours that have already passed.
  let _mode = 'forecast';
  let rowControlsListener = null;

  const notify = () => rowControlsListener?.();

  const layer = {
    id: 'entsoe-grid',
    name: 'European Grid',
    icon: '⚡',
    source: 'ENTSO-E',
    updateInterval: 15 * 60_000,

    // The one data-layer control a provider key gates: the proxy answers
    // 503 {error:'no_key'} without an ENTSOE_TOKEN. Declared as a key-registry
    // id rather than an env-var string, so the panel can name the key from
    // the one place that owns what each key is called.
    requiresKeyId: ENTSOE_KEY_ID,

    init(viewer) {
      if (_viewer) throw new Error('ENTSO-E layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('entsoe-grid');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _series = [];
      _unit = null;
      _day = null;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _keyRequired = false;
      _enabled = false;
      overlayHost.setVisible(ENTSOE_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(ENTSOE_OVERLAY_SOURCE_ID, true);
      notify();
    },

    disable() {
      // Abort in flight: a response arriving after disable must not redraw.
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(ENTSOE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(ENTSOE_OVERLAY_SOURCE_ID, false);
      notify();
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const snapshot = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _series = snapshot.series;
        _unit = snapshot.unit;
        _day = snapshot.day;
        this._render();
        _count = _series.length;
        _lastUpdate = Date.now();
        _lastError = null;
        _keyRequired = false;
        notify();
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request) return false;
        // A missing token is a step the operator can take, not a fault: the
        // row says so and the panel names the environment variable.
        _keyRequired = error?.keyRequired === true;
        _lastError = error?.message || msg('Grid data unavailable');
        console.warn('[Data:ENTSOE] Refresh failed:', _lastError);
        notify();
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    /** Rebuild entities from the current series. */
    _render() {
      if (!_dataSource) return;
      _dataSource.entities.removeAll();
      // The series is a line of hourly values, not a set of places on the
      // globe: it is drawn as a chain of anchors along a fixed baseline so
      // the shape of the day is readable.
      const step = Math.max(1, Math.ceil(_series.length / MAX_DRAWN_POINTS));
      const shown = _series.filter((_, index) => index % step === 0);
      for (const point of shown) {
        const color = Cesium.Color.fromCssColorString(
          entsoeBandColor(point.band),
        );
        _dataSource.entities.add(
          new Cesium.Entity({
            id: `entsoe-point:${point.position}`,
            position: Cesium.Cartesian3.fromDegrees(
              -20 + point.position * 0.4,
              50,
            ),
            point: {
              // Static size: a per-frame callback would re-tessellate the
              // point every frame.
              pixelSize: 8,
              color: color.withAlpha(0.95),
            },
            properties: {
              value: point.value,
              unit: _unit,
              band: point.band,
              position: point.position,
            },
          }),
        );
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      overlayHost.clearSource(ENTSOE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(ENTSOE_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer?.dataSources?.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      _series = [];
      _unit = null;
      _day = null;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _keyRequired = false;
      rowControlsListener = null;
    },

    /**
     * Switch between the whole day-ahead forecast and the hours already
     * past.
     *
     * @param {{mode?: string}} params Layer parameters.
     * @returns {boolean} True when the parameters were accepted.
     */
    setParams(params = {}) {
      if (!params || typeof params !== 'object') return false;
      const mode = String(params.mode ?? '').trim();
      if (!mode) return false;
      if (!['forecast', 'observed'].includes(mode)) return false;
      if (mode === _mode) return true;
      _mode = mode;
      notify();
      return true;
    },

    /**
     * The card for the European Grid row.
     *
     * The hourly load is a SERIES, so the card is a valid-time rail: every
     * hour of the day is listed with the load the operator published for it.
     * The chip switches between the whole day-ahead forecast and the hours
     * that have already passed.
     *
     * WITHOUT a token the proxy answers 503 {error:'no_key'}. That is not
     * an empty grid: it is a step the operator can take, so the card says
     * which environment variable to set, through the same key-guidance
     * sentence the rest of the app uses.
     */
    getRowControls() {
      const now = Date.now();
      const rows = _series
        .map((point) => ({
          ...point,
          validTime: entsoePointValidTime(_day, point.position),
        }))
        .filter((point) => Boolean(point.validTime))
        .sort((a, b) => a.position - b.position);
      const observed = rows.filter(
        (point) => Date.parse(point.validTime) <= now,
      );
      const shown = _mode === 'observed' && observed.length ? observed : rows;
      // KEY REQUIRED is the app's existing status word for a missing
      // provider key; the guidance sentence beside it names the variable
      // the operator has to set.
      const status = _keyRequired
        ? t('KEY REQUIRED')
        : _lastError
          ? translateFeedError(_lastError)
          : _count === 0
            ? t('No grid data')
            : t('{count} readings · {unit}', {
                count: String(_count),
                unit: _unit || 'MW',
              });
      const chips = [
        {
          id: 'forecast',
          label: t('FORECAST'),
          active: _mode !== 'observed',
          title: t(
            'The whole day-ahead series, every hour the operator published',
          ),
          params: { mode: 'forecast' },
        },
        {
          id: 'observed',
          label: t('OBSERVED'),
          active: _mode === 'observed',
          disabled: !observed.length,
          title: observed.length
            ? t('Only the hours of the day that have already passed')
            : t('No hour of this day has passed yet'),
          params: { mode: 'observed' },
        },
      ];
      const detail = t('{count} hourly readings · {unit}', {
        count: String(shown.length),
        unit: _unit || 'MW',
      });
      return {
        readout: true,
        summary: {
          label: t('European Grid'),
          coverage: t(ENTSOE_DESCRIPTION),
          // The card names the variable the operator has to set. The
          // SENTENCE is built by the panel, which owns the key registry
          // wording; the layer only names the key it needs.
          ...(_keyRequired ? { keyRequirementId: ENTSOE_KEY_ID } : {}),
          detail,
          validTime: rows.length
            ? rows[0].validTime
            : _lastUpdate
              ? new Date(_lastUpdate).toISOString()
              : undefined,
          status,
          units: _unit || 'MW',
          settings: [
            {
              id: 'mode',
              label: t('SERIES'),
              chips,
            },
          ],
        },
        legend: ENTSOE_LOAD_BANDS.map((band) => ({
          color: band.color,
          label: t(band.label),
        })),
        legendCategorical: true,
        // The hour rail only exists when there IS a series to rail over: a
        // keyless layer has no hours, and an empty list would be a rail with
        // nothing on it.
        ...(shown.length
          ? {
              list: {
                ariaLabel: t('European grid load by hour'),
                items: shown.map((point) => ({
                  id: String(point.position),
                  lead: new Date(point.validTime).toISOString().slice(11, 16),
                  text: t('{value} {unit}', {
                    value: String(Math.round(point.value)),
                    unit: _unit || 'MW',
                  }),
                  accent: entsoeBandColor(point.band),
                })),
              },
            }
          : {}),
      };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    /**
     * Snapshot the series as JSON-safe rows for the analyst query engine.
     * @param {number} [maxCount=500]
     * @returns {Array<object>}
     */
    getAnalystRecords(maxCount = 500) {
      if (!_enabled || !_series.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 500;
      return _series.slice(0, limit).map((point, index) =>
        mapEntsoeRecord(
          {
            ...point,
            unit: _unit,
            sampledAt: _day,
          },
          index,
        ),
      );
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        // The machine-readable half of the keyless state: without it
        // 'no key configured' is indistinguishable from a broken feed.
        keyRequired: _keyRequired,
      };
    },
  };
  return layer;
}
