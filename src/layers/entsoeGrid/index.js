import { msg, t } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { hexColor } from '../../render/color.js';
import { drawOf } from '../../render/rendererOf.js';
import { createEntityCard } from '../entityCard.js';
import {
  ENTSOE_DEFAULT_FOCUS,
  ENTSOE_DESCRIPTION,
  ENTSOE_ZONE_PICK_PREFIX,
  buildEntsoeZoneCopy,
  entsoeCurrentPoint,
  entsoeZoneFromPick,
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

/** Each layer's draw set has an id of its own. */
let instances = 0;

/** Pin size in pixels: a static size, so no per-frame callback is needed. */
const ZONE_PIN_SIZE_PX = 12;

/**
 * Own one European grid display: one pin per bidding zone, coloured by the
 * zone's current load against its own day's peak. Clicking a pin opens a card
 * with the current reading and the day's curve.
 *
 * The layer needs an ENTSO-E operator token. Without one the proxy answers
 * 503 {error:'no_key'} and the layer reports `stats.keyRequired`, so the row
 * reads as a step the operator can take rather than a broken feed.
 */
export function createEntsoeGridLayer({
  source,
  overlayHost,
  interaction,
  inputFor,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('ENTSO-E grid requires a snapshot source');
  if (!overlayHost)
    throw new TypeError('ENTSO-E grid requires an overlay host');
  let _viewer = null;
  let _request = null;
  let _pins = null;
  const setId = `entsoe-grid:${++instances}`;
  let _zones = [];
  let _focus = ENTSOE_DEFAULT_FOCUS;
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

  // The zone whose hours the row's rail lists: France until a pin is chosen.
  const focusZone = () =>
    _zones.find((zone) => zone.code === _focus) ?? _zones[0] ?? null;
  const focusSeries = () => focusZone()?.series ?? [];

  const card = createEntityCard({
    layerId: 'entsoe-grid',
    overlayHost,
    sourceId: `${ENTSOE_OVERLAY_SOURCE_ID}-selected`,
    interaction,
    inputFor,
    owns: (id) => entsoeZoneFromPick(id) !== null,
    resolve(id) {
      const zone = _zones.find(
        (entry) => entry.code === entsoeZoneFromPick(id),
      );
      if (!zone) return null;
      return {
        ...buildEntsoeZoneCopy(zone, t),
        position: fromDegrees(zone.lon, zone.lat),
      };
    },
    // Choosing a pin also points the row's hour rail at that country.
    onSelect(id) {
      const code = entsoeZoneFromPick(id);
      if (code && code !== _focus) {
        _focus = code;
        notify();
      }
    },
  });

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
      _pins = drawOf(viewer).points({
        id: setId,
        clampTo: 'both',
        show: false,
      });
      _zones = [];
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
      if (_pins) _pins.show = true;
      overlayHost.setVisible(ENTSOE_OVERLAY_SOURCE_ID, true);
      card.install(_viewer);
      notify();
    },

    disable() {
      // Abort in flight: a response arriving after disable must not redraw.
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_pins) _pins.show = false;
      overlayHost.clearSource(ENTSOE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(ENTSOE_OVERLAY_SOURCE_ID, false);
      card.remove();
      notify();
    },

    async update() {
      if (!_enabled || !_pins) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const snapshot = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _zones = snapshot.zones;
        _unit = snapshot.unit;
        _day = snapshot.day;
        this._render();
        _count = _zones.length;
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

    /** Rebuild the zone pins from the current snapshot. */
    _render() {
      if (!_pins) return;
      card.clear();
      const now = Date.now();
      _pins.set(
        _zones.map((zone) => {
          const current = entsoeCurrentPoint(zone, now);
          return {
            id: `${ENTSOE_ZONE_PICK_PREFIX}${zone.code}`,
            pos: fromDegrees(zone.lon, zone.lat),
            pixelSize: ZONE_PIN_SIZE_PX,
            color: hexColor(entsoeBandColor(current?.band), 0.95),
            outlineColor: hexColor('#ffffff', 0.85),
            outlineWidth: 1,
          };
        }),
      );
    },

    destroy() {
      _request?.abort();
      _request = null;
      _enabled = false;
      overlayHost.clearSource(ENTSOE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(ENTSOE_OVERLAY_SOURCE_ID, false);
      card.remove();
      _pins?.dispose();
      _pins = null;
      _viewer = null;
      _zones = [];
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
      const zone = focusZone();
      const rows = focusSeries()
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
            : t('{count} countries · {unit}', {
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
      const detail = t('{zone} · {count} hourly readings · {unit}', {
        zone: zone ? t(zone.name) : '—',
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
                ariaLabel: t('{zone} grid load by hour', {
                  zone: zone ? t(zone.name) : '',
                }),
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
      if (!_enabled || !_zones.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 500;
      return _zones
        .flatMap((zone) =>
          zone.series.map((point) =>
            mapEntsoeRecord({
              ...point,
              id: `GRID-${zone.code}-${String(point.position).padStart(2, '0')}`,
              zone: zone.code,
              unit: zone.unit,
              sampledAt: zone.day,
            }),
          ),
        )
        .slice(0, limit);
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
