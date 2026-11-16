import { msg, t } from '../../i18n/index.js';
import { spriteDrawOrder } from '../../data/spriteOrder.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { drawOf, findFrame } from '../../render/rendererOf.js';
import { inputFor } from '../../input/dispatcher.js';
import { createHorizonCull } from '../streetLevel/view.js';
import { ACCIDENT_COLOR, describeAirAccident } from './cards.js';
import {
  inPeriod,
  normalizePeriod,
  periodRange,
  yearExtent,
} from './period.js';
export * from './records.js';
export * from './cards.js';
export * from './period.js';
export { createAirAccidentsSource } from './source.js';

export const AIR_ACCIDENTS_LAYER_ID = 'air-accidents';
export const AIR_ACCIDENTS_OVERLAY_SOURCE_ID = 'air-accidents';
const PICK_PREFIX = 'air-accident:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const MAX_CARD_LINES = 14;

/**
 * Marker size grows with the death toll, so the worst read first. The
 * scale matches the shipwrecks layer, so both read alike side by side.
 */
export function markerPixelSize(fatalities) {
  const n = Number.isFinite(fatalities) && fatalities > 0 ? fatalities : 0;
  return Math.round(16 + Math.min(20, Math.log2(1 + n) * 2));
}

/**
 * A round marker in the class colour with an aircraft seen from above in
 * the middle, as an SVG data URL: the shipwrecks layer's marker pattern
 * (coloured disc, white rim, dark glyph), so a wreck and a crash are told
 * apart at a glance when both layers are on. It is rasterized at 144 px,
 * four times the largest marker, so big markers stay sharp.
 * @param {string} color CSS colour.
 * @returns {string}
 */
export function accidentMarkerImage(color) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 36 36">` +
    `<circle cx="18" cy="18" r="16" fill="${color}" stroke="#ffffff" stroke-width="2"/>` +
    `<path d="M18 6.5c.9 0 1.5.9 1.5 2V15l8.5 5v2.3l-8.5-2.6V25l2.4 1.9v1.8L18 27.6l-3.9 1.1v-1.8l2.4-1.9v-5.3L8 22.3V20l8.5-5V8.5c0-1.1.6-2 1.5-2z" fill="#0b1420"/>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * Notable aircraft accidents worldwide from Wikidata, one ground marker
 * each, with a card.
 */
export function createAirAccidentsLayer({
  source,
  overlayHost = null,
  picking = null,
  pointer = null,
  openExternal = null,
  // The clicks on the globe: the application's input dispatcher.
  input = (viewer) => inputFor(viewer),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Air accidents require a snapshot source');
  let _viewer = null;
  let _enabled = false;
  // One icon set for every marker (tens of thousands of them).
  let _markers = null;
  const _image = accidentMarkerImage(ACCIDENT_COLOR);
  let _request = null;
  let _records = new Map();
  let _pins = [];
  let _snapshot = null;
  let _lastError = null;
  let _clickHandler = null;
  let _rowListener = null;
  let _selectedId = null;
  let _selectedCardId = null;
  let _selectedLink = null;
  let _period = { from: null, to: null };
  let _extent = null;
  let _range = null;

  const render = () => {
    flushPins();
    if (_viewer) findFrame(_viewer)?.requestRender(AIR_ACCIDENTS_LAYER_ID);
  };
  const notifyRow = () => _rowListener?.();
  const canSelect = () => overlayHost && picking;
  /** Pins whose marker changed since the set was last written. */
  const changedPins = new Set();
  // Markers skip the depth test so terrain does not swallow them; the
  // horizon cull hides the far side of the planet instead.
  const _horizon = createHorizonCull({
    getViewer: () => _viewer,
    items: () => _pins,
    onChange: render,
  });

  /** Shown: its year is inside the period. */
  function visible(record) {
    return Boolean(record) && inPeriod(record, _range);
  }

  function applyPin(pin) {
    const show = pin.inFront && visible(pin.record);
    if (pin.item.show === show) return;
    pin.item = { ...pin.item, show };
    changedPins.add(pin);
  }

  /** Send the markers that changed to the set. */
  function flushPins() {
    if (!changedPins.size) return;
    const items = [...changedPins].map((pin) => pin.item);
    changedPins.clear();
    _markers?.upsert(items);
  }

  /** Re-apply the period to every marker and the open card. */
  function applyFilter() {
    for (const pin of _pins) applyPin(pin);
    if (_selectedId && !visible(_records.get(_selectedId))) clearSelection();
    notifyRow();
    render();
  }

  function rebuild(records) {
    _records = new Map(records.map((record) => [record.id, record]));
    _extent = yearExtent(records);
    _range = periodRange(_period, _extent);
    _pins = [];
    changedPins.clear();
    if (!_markers) return;
    // Within one set later markers draw on top: add by rising death toll so
    // a bigger toll covers smaller neighbours.
    const ordered = [...records].sort(
      (a, b) => (a.fatalities || 0) - (b.fatalities || 0),
    );
    for (const record of ordered) {
      // On the ellipsoid, drawn over terrain (no depth test): clamping each
      // marker to terrain would cost a terrain query per marker.
      const position = fromDegrees(record.lon, record.lat);
      const size = markerPixelSize(record.fatalities);
      const pin = {
        // The marker as the set draws it.
        item: {
          id: `${PICK_PREFIX}${record.id}`,
          pos: position,
          image: _image,
          size: [size, size],
          disableDepthTest: Number.POSITIVE_INFINITY,
          show: true,
        },
        record,
        position,
        inFront: true,
        get show() {
          return this.inFront;
        },
        set show(value) {
          this.inFront = value;
          applyPin(this);
        },
      };
      applyPin(pin);
      _pins.push(pin);
    }
    changedPins.clear();
    _markers.set(_pins.map((pin) => pin.item));
    _horizon.update();
    if (_selectedId && !_records.has(_selectedId)) clearSelection();
    else if (_selectedId) publishCard();
    render();
  }

  // ---- selection card ----------------------------------------------------
  function publishCard() {
    if (!canSelect()) return;
    const record = _selectedId ? _records.get(_selectedId) : null;
    if (!visible(record)) {
      clearSelection();
      return;
    }
    const { title, details, link } = describeAirAccident(record);
    _selectedLink = link && openExternal ? link : null;
    const card = {
      id: `air-accident-card:${record.id}`,
      selected: true,
      interactive: Boolean(_selectedLink),
      title,
      details: details.slice(0, MAX_CARD_LINES),
      accent: ACCIDENT_COLOR,
      priority: Number.MAX_SAFE_INTEGER,
      gapPx: 15,
      verticalOnly: true,
      placement: 'above',
      stateless: true,
      horizonCull: true,
      position: fromDegrees(record.lon, record.lat),
    };
    if (card.interactive) {
      const target = _selectedLink;
      card.accessibilityLabel = t('Open the source for {title}', { title });
      card.activate = () => {
        openExternal(target);
        return true;
      };
    }
    _selectedCardId = card.id;
    overlayHost.setEntries(
      AIR_ACCIDENTS_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
    overlayHost.setVisible?.(AIR_ACCIDENTS_OVERLAY_SOURCE_ID, true);
  }

  function clearSelection() {
    _selectedId = null;
    _selectedCardId = null;
    _selectedLink = null;
    overlayHost?.setEntries(
      AIR_ACCIDENTS_OVERLAY_SOURCE_ID,
      [],
      CARD_HOST_OPTIONS,
    );
  }

  function pickedRecordId(pickId) {
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
    return _records.has(id) ? id : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    picking.registerPickOwner?.(
      AIR_ACCIDENTS_LAYER_ID,
      (pickedId) =>
        typeof pickedId === 'string' && pickedId.startsWith(PICK_PREFIX),
    );
    // A viewer with no renderer input bound takes no clicks.
    let clicks = null;
    try {
      clicks = input(_viewer) ?? null;
    } catch {
      clicks = null;
    }
    if (!clicks) return;
    _clickHandler = clicks.onClick((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const at = click.screenPosition;
      const cardHit = overlayHost.hitTest?.(at?.x, at?.y, {
        sourceId: AIR_ACCIDENTS_OVERLAY_SOURCE_ID,
      });
      if (cardHit && cardHit.entryId === _selectedCardId) {
        if (_selectedLink) openExternal(_selectedLink);
        return;
      }
      // A marker's item id is its pick id, `air-accident:<id>`. Read from what
      // is exactly under the click: a touch's wider contact search would pick
      // an accident the tap missed, or a contact near one.
      const picked = click.topHit;
      const pickId = picked ? (picking.resolvePickId(picked) ?? null) : null;
      const id = pickedRecordId(pickId);
      if (id) {
        _selectedId = id;
        publishCard();
        render();
        return;
      }
      if (pickId && picking.isOwnedByOtherLayer(AIR_ACCIDENTS_LAYER_ID, pickId))
        return;
      if (_selectedId) {
        clearSelection();
        render();
      }
    });
  }

  function removeClickHandler() {
    _clickHandler?.();
    _clickHandler = null;
    picking?.unregisterPickOwner?.(AIR_ACCIDENTS_LAYER_ID);
  }

  /** The start and end year pickers, side by side under the row. */
  function periodControls() {
    if (!_extent || _extent.min === _extent.max) return {};
    const range = periodRange(_period, _extent);
    const valueText = range.all
      ? t('All years')
      : range.from === range.to
        ? String(range.from)
        : `${range.from}–${range.to}`;
    const options = [];
    for (let year = _extent.max; year >= _extent.min; year--)
      options.push({ value: year, label: String(year) });
    return {
      range: {
        id: 'period',
        label: t('Period'),
        valueText,
        from: {
          label: t('From'),
          ariaLabel: t('First year of the accident period'),
          value: range.from,
        },
        to: {
          label: t('To'),
          ariaLabel: t('Last year of the accident period'),
          value: range.to,
        },
        options,
        params: (end, value) => ({ [end]: Number(value) }),
      },
    };
  }

  const layer = {
    id: AIR_ACCIDENTS_LAYER_ID,
    name: 'Air accidents',
    icon: '✈️',
    source: 'Wikidata',
    // The proxy refreshes once a day; this only notices a new snapshot.
    updateInterval: 6 * 60 * 60 * 1000,

    init(viewer) {
      if (_viewer)
        throw new Error('Air accidents layer is already initialized');
      _viewer = viewer;
      // One set for every accident marker, under the other sprite layers
      // (`SPRITE_LAYER_ORDER`).
      _markers = drawOf(viewer).icons({
        id: 'air-accidents:markers',
        drawOrder: spriteDrawOrder(AIR_ACCIDENTS_LAYER_ID),
        show: false,
      });
    },

    enable() {
      _enabled = true;
      if (_markers) _markers.show = true;
      installClickHandler();
      if (_pins.length) _horizon.update();
      render();
    },

    disable() {
      _enabled = false;
      _request?.abort();
      _request = null;
      if (_markers) _markers.show = false;
      removeClickHandler();
      clearSelection();
      _horizon.stop();
      render();
    },

    async update() {
      if (!_enabled || !_markers) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const snapshot = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _snapshot = snapshot;
        _lastError = snapshot.complete
          ? null
          : msg('Accidents without their own coordinates are missing');
        rebuild(snapshot.records);
        notifyRow();
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:AirAccidents] Fetch error:', error);
        _lastError = error?.message || msg('Air accidents unavailable');
        notifyRow();
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy() {
      layer.disable();
      if (_markers) {
        _markers.dispose();
        _markers = null;
      }
      _records = new Map();
      _pins = [];
      _snapshot = null;
      _viewer = null;
      _rowListener = null;
    },

    /** The period filter: `from` and `to` are years (null = oldest / latest in the data). */
    getParams() {
      return { ..._period };
    },

    setParams(params = {}) {
      const next = normalizePeriod(params, _period);
      if (next.from === _period.from && next.to === _period.to) return true;
      _period = next;
      _range = periodRange(_period, _extent);
      applyFilter();
      return true;
    },

    setRowControlsListener(listener) {
      _rowListener = listener;
    },

    getRowControls() {
      return {
        ...periodControls(),
        legend: [],
        info: t('Notable accidents worldwide · Wikidata'),
        infoTitle: t(
          'Aviation accidents recorded on Wikidata, worldwide. Accidents without their own coordinates are placed at their location (an airport, a mountain, a town) and marked approximate. Marker size grows with fatalities. Click a marker for its card.',
        ),
      };
    },

    getStats() {
      let shown = 0;
      for (const record of _records.values()) if (visible(record)) shown++;
      return {
        count: shown,
        lastUpdate: _snapshot?.fetchedAt ?? null,
        stale: _snapshot?.stale === true,
        error: _lastError,
      };
    },

    /** Loaded records as plain JSON-safe objects, for tools and QA. */
    getAnalystRecords(maxCount = 2000) {
      if (!_enabled) return [];
      const out = [];
      for (const record of _records.values()) {
        if (out.length >= maxCount) break;
        if (!visible(record)) continue;
        out.push({
          id: record.id,
          date: record.date,
          lat: record.lat,
          lon: record.lon,
          approximate: record.approximate,
          fatalities: record.fatalities,
          aircraft: record.aircraft,
          name: record.name,
        });
      }
      return out;
    },
  };
  return layer;
}
