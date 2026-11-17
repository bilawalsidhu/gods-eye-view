import { formatNumber, msg, t, tn } from '../../i18n/index.js';
import { spriteDrawOrder } from '../../data/spriteOrder.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { drawOf, findFrame } from '../../render/rendererOf.js';
import { inputFor } from '../../input/dispatcher.js';
import { createHorizonCull } from '../streetLevel/view.js';
import { ERA_COLORS, ERA_LABELS, describeShipwreck } from './cards.js';
import { SHIPWRECK_ERAS, eraOf } from './eras.js';
import {
  inPeriod,
  normalizePeriod,
  periodRange,
  yearExtent,
} from './period.js';
export * from './records.js';
export * from './cards.js';
export * from './eras.js';
export * from './period.js';
export { createShipwrecksSource } from './source.js';

export const SHIPWRECKS_LAYER_ID = 'shipwrecks';
export const SHIPWRECKS_OVERLAY_SOURCE_ID = 'shipwrecks';
const PICK_PREFIX = 'shipwreck:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const MAX_CARD_LINES = 14;
/** Wrecks not refreshed for this long leave the map (the proxy's own limit). */
const MAX_SHOWN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * When the shown wrecks leave the map if the page cannot refresh, on this
 * page's clock: the age the proxy reports (its own clock) is subtracted from
 * the limit, so the two clocks are never compared, and the newest source
 * decides. A wreck both sources list is one merged record, so the snapshot
 * goes as a whole, not per source. With no age reported, the snapshot counts
 * as fresh when it arrives.
 */
export function snapshotDeadline(snapshot, at) {
  const limit = snapshot.maxAgeMs ?? MAX_SHOWN_AGE_MS;
  const ages = ['emodnet', 'wikidata']
    .filter((name) => snapshot.sources?.[name] !== false)
    .map((name) => snapshot.ages?.[name] ?? 0);
  const newest = ages.length ? Math.min(...ages) : 0;
  return at + limit - newest;
}
/**
 * Marker size in pixels: grows with the death toll, from 16 px (no deaths known) to 36 px (about a thousand or more).
 */
export function markerPixelSize(casualties) {
  const n = Number.isFinite(casualties) && casualties > 0 ? casualties : 0;
  return Math.round(16 + Math.min(20, Math.log2(1 + n) * 2));
}

/**
 * A round marker in the era's colour with a sinking hull and mast in the
 * middle, as an SVG data URL. It is rasterized at 144 px, four times the
 * largest marker, so big markers stay sharp on high-density screens.
 * @param {string} color CSS colour.
 * @returns {string}
 */
export function wreckMarkerImage(color) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 36 36">` +
    `<circle cx="18" cy="18" r="16" fill="${color}" stroke="#ffffff" stroke-width="2"/>` +
    `<path d="M8 21h20l-3.5 5h-13z" fill="#0b1420"/>` +
    `<path d="M17 8v12M17 9l6 7h-6" fill="none" stroke="#0b1420" stroke-width="2.2" stroke-linejoin="round"/>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * Shipwrecks: EMODnet's European heritage wrecks and Wikidata's notable
 * wrecks worldwide, one marker each, with a card and era chips.
 */
export function createShipwrecksLayer({
  source,
  overlayHost = null,
  picking = null,
  pointer = null,
  openExternal = null,
  now = () => Date.now(),
  // The clicks on the globe: the application's input dispatcher.
  input = (viewer) => inputFor(viewer),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Shipwrecks require a snapshot source');
  let _viewer = null;
  let _enabled = false;
  let _markers = null;
  let _request = null;
  let _records = new Map();
  let _pins = [];
  let _snapshot = null;
  let _deadline = null;
  let _lastError = null;
  let _clickHandler = null;
  let _rowListener = null;
  let _selectedId = null;
  let _selectedCardId = null;
  let _selectedLink = null;
  let _period = { from: null, to: null };
  let _extent = null;
  let _range = null;
  const _images = Object.fromEntries(
    SHIPWRECK_ERAS.map((era) => [era, wreckMarkerImage(ERA_COLORS[era])]),
  );

  const render = () => {
    flushPins();
    if (_viewer) findFrame(_viewer)?.requestRender('shipwrecks');
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

  /** Shown: its year is inside the period (undated ones only for all years). */
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
      (a, b) => (a.casualties || 0) - (b.casualties || 0),
    );
    for (const record of ordered) {
      const position = fromDegrees(record.lon, record.lat);
      const size = markerPixelSize(record.casualties);
      const pin = {
        // The marker as the set draws it.
        item: {
          id: `${PICK_PREFIX}${record.id}`,
          pos: position,
          image: _images[eraOf(record)],
          size: [size, size],
          height: 'clampGround',
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
    const { title, details, link } = describeShipwreck(record);
    _selectedLink = link && openExternal ? link : null;
    const card = {
      id: `shipwreck-card:${record.id}`,
      selected: true,
      interactive: Boolean(_selectedLink),
      title,
      details: details.slice(0, MAX_CARD_LINES),
      accent: ERA_COLORS[eraOf(record)],
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
      SHIPWRECKS_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
    overlayHost.setVisible?.(SHIPWRECKS_OVERLAY_SOURCE_ID, true);
  }

  function clearSelection() {
    _selectedId = null;
    _selectedCardId = null;
    _selectedLink = null;
    overlayHost?.setEntries(
      SHIPWRECKS_OVERLAY_SOURCE_ID,
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
      SHIPWRECKS_LAYER_ID,
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
        sourceId: SHIPWRECKS_OVERLAY_SOURCE_ID,
      });
      if (cardHit && cardHit.entryId === _selectedCardId) {
        if (_selectedLink) openExternal(_selectedLink);
        return;
      }
      // A marker's item id is its pick id, `shipwreck:<id>`. Read from what is
      // exactly under the click: a touch's wider contact search would pick a
      // wreck the tap missed, or a contact near one.
      const picked = click.topHit;
      const pickId = picked ? (picking.resolvePickId(picked) ?? null) : null;
      const id = pickedRecordId(pickId);
      if (id) {
        _selectedId = id;
        publishCard();
        render();
        return;
      }
      if (pickId && picking.isOwnedByOtherLayer(SHIPWRECKS_LAYER_ID, pickId))
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
    picking?.unregisterPickOwner?.(SHIPWRECKS_LAYER_ID);
  }

  /** Wrecks shown per era, in one pass over the records. */
  function eraCounts() {
    const counts = Object.fromEntries(SHIPWRECK_ERAS.map((era) => [era, 0]));
    for (const record of _records.values())
      if (inPeriod(record, _range)) counts[eraOf(record)]++;
    return counts;
  }

  /** The years that have a dated wreck, plus `extra` ones, newest first. */
  function yearsInData(extra = []) {
    const years = new Set(extra);
    for (const record of _records.values())
      if (Number.isInteger(record.year)) years.add(record.year);
    return [...years].sort((a, b) => b - a);
  }

  /** The start and end year pickers, side by side. */
  function periodControls() {
    if (!_extent || _extent.min === _extent.max) return {};
    const range = periodRange(_period, _extent);
    const valueText = range.all
      ? t('All years')
      : range.from === range.to
        ? String(range.from)
        : `${range.from}–${range.to}`;
    // Only years with a wreck: a picker of every year since the oldest
    // dated wreck would run to well over a thousand entries.
    // The chosen ends stay listed even when no wreck sank that year.
    const options = yearsInData([range.from, range.to]).map((year) => ({
      value: year,
      label: String(year),
    }));
    return {
      range: {
        id: 'period',
        label: t('Period'),
        valueText,
        from: {
          label: t('From'),
          ariaLabel: t('First year of the shipwreck period'),
          value: range.from,
        },
        to: {
          label: t('To'),
          ariaLabel: t('Last year of the shipwreck period'),
          value: range.to,
        },
        options,
        params: (end, value) => ({ [end]: Number(value) }),
      },
    };
  }

  const layer = {
    id: SHIPWRECKS_LAYER_ID,
    name: 'Shipwrecks',
    icon: '⚓',
    source: 'EMODnet · Wikidata',
    // The proxy refreshes once a day; this only notices a new snapshot.
    updateInterval: 6 * 60 * 60 * 1000,

    init(viewer) {
      if (_viewer) throw new Error('Shipwrecks layer is already initialized');
      _viewer = viewer;
      // One set for every wreck marker (thousands of them), under the other
      // sprite layers (`SPRITE_LAYER_ORDER`).
      _markers = drawOf(viewer).icons({
        id: 'shipwrecks:markers',
        // Translucent, as its billboards were.
        blend: 'translucent',
        drawOrder: spriteDrawOrder(SHIPWRECKS_LAYER_ID),
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
        // The page checks every 6 h; the proxy refreshes once a day. Only a
        // new snapshot rebuilds the markers.
        const unchanged =
          typeof snapshot.version === 'string' &&
          snapshot.version === _snapshot?.version &&
          _pins.length > 0;
        _snapshot = snapshot;
        _deadline = snapshotDeadline(snapshot, now());
        _lastError =
          snapshot.sources.emodnet && snapshot.sources.wikidata
            ? null
            : snapshot.sources.emodnet
              ? msg('Wikidata unavailable; showing EMODnet only')
              : msg('EMODnet unavailable; showing Wikidata only');
        if (!unchanged) rebuild(snapshot.records);
        notifyRow();
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:Shipwrecks] Fetch error:', error);
        _lastError = error?.message || msg('Shipwrecks unavailable');
        // What is on the map was not refreshed: say so, and drop it once
        // even its newest source is older than the proxy would serve.
        if (_snapshot) {
          if (now() >= _deadline) {
            _snapshot = null;
            _deadline = null;
            rebuild([]);
          } else _snapshot = { ..._snapshot, stale: true };
        }
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
      _deadline = null;
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
      const counts = eraCounts();
      return {
        chips: [],
        ...periodControls(),
        // The colours are a legend: when the ship sank.
        legend: SHIPWRECK_ERAS.map((era) => ({
          label: t(ERA_LABELS[era]),
          count: counts[era],
          color: ERA_COLORS[era],
          blurb: tn(counts[era], '{count} wreck', '{count} wrecks', {
            count: formatNumber(counts[era]),
          }),
        })),
        info: t('EMODnet (European waters) · Wikidata (worldwide)'),
        infoTitle: t(
          'European heritage wrecks come from EMODnet Human Activities; notable wrecks worldwide come from Wikidata. Colour shows when the ship sank; marker size grows with deaths. Click a marker for its card.',
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
          source: record.source,
          name: record.name,
          vesselType: record.vesselType,
          year: record.year,
          era: eraOf(record),
          lat: record.lat,
          lon: record.lon,
          depth: record.depth,
          casualties: record.casualties,
        });
      }
      return out;
    },
  };
  return layer;
}
