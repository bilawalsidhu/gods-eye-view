import * as geo from '../../geo/index.js';
import { formatNumber, msg, t, tn } from '../../i18n/index.js';
import { SPRITE_LAYER_ORDER } from '../../data/spriteOrder.js';
import { createMapMarkers } from '../shared/render/mapMarkers.js';
import { bindOverlayHost } from '../../overlays/bindOverlayHost.js';
import { selectionDispatcherFor } from '../../data/selectionDispatcher.js';
import { pickRegistryFor, resolvePickId } from '../../data/pickRegistry.js';
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
  openExternal = null,
  now = () => Date.now(),
  drawAtlas,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Shipwrecks require a snapshot source');
  let engine = null;
  overlayHost = bindOverlayHost(overlayHost, () => engine);
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
    _markers?.refresh();
    engine?.render.request(SHIPWRECKS_LAYER_ID);
  };
  const notifyRow = () => _rowListener?.();
  const canSelect = () => Boolean(overlayHost);

  /** Shown: its year is inside the period (undated ones only for all years). */
  function visible(record) {
    return Boolean(record) && inPeriod(record, _range);
  }

  function applyPin(pin) {
    pin.show = visible(pin.record);
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
    if (!_markers) return;
    // Within one collection later markers draw on top: add by rising death
    // toll so a bigger toll covers smaller neighbours.
    const ordered = [...records].sort(
      (a, b) => (a.casualties || 0) - (b.casualties || 0),
    );
    for (const record of ordered) {
      const position = geo.cartesian3.fromDegrees(record.lon, record.lat);
      const size = markerPixelSize(record.casualties);
      const pin = {
        id: `${PICK_PREFIX}${record.id}`,
        billboard: { image: _images[eraOf(record)], width: size, height: size },
        record,
        position,
        show: visible(record),
      };
      _pins.push(pin);
    }
    const ready = _markers.replace(_pins);
    if (_selectedId && !_records.has(_selectedId)) clearSelection();
    else if (_selectedId) publishCard();
    render();
    return ready;
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
      position:
        _pins.find((pin) => pin.record.id === record.id)?.position ||
        geo.cartesian3.fromDegrees(record.lon, record.lat),
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

  function pickedRecordId(picked) {
    const pickId = resolvePickId(picked);
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
    return _records.has(id) ? id : null;
  }

  const picks = {
    owner: SHIPWRECKS_LAYER_ID,
    predicate: (id) => typeof id === 'string' && id.startsWith(PICK_PREFIX),
  };
  function installClickHandler() {
    if (!canSelect() || _clickHandler || !engine) return;
    _clickHandler = selectionDispatcherFor(engine).register(picks.owner, {
      owns: picks.predicate,
      onClick(click) {
        const cardHit = overlayHost.hitTest?.(
          click.position?.x,
          click.position?.y,
          {
            sourceId: SHIPWRECKS_OVERLAY_SOURCE_ID,
          },
        );
        if (cardHit && cardHit.entryId === _selectedCardId) {
          if (_selectedLink) openExternal(_selectedLink);
          return;
        }
        const id = pickedRecordId(click.picked);
        if (id) {
          _selectedId = id;
          publishCard();
          render();
          return;
        }
        const pickedId = resolvePickId(click.picked);
        if (
          pickedId &&
          pickRegistryFor(engine).isOwnedByOtherLayer(
            SHIPWRECKS_LAYER_ID,
            pickedId,
          )
        )
          return;
        if (_selectedId) {
          clearSelection();
          render();
        }
      },
    });
  }

  function removeClickHandler() {
    _clickHandler?.();
    _clickHandler = null;
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

    picks,
    init(_viewer, context) {
      this.attachRenderer(context);
    },
    attachRenderer(context = {}) {
      if (engine) throw new Error('Shipwrecks layer is already initialized');
      engine = context.engine;
      _markers = createMapMarkers(engine, {
        id: SHIPWRECKS_LAYER_ID,
        order: SPRITE_LAYER_ORDER.indexOf(SHIPWRECKS_LAYER_ID),
        drawAtlas,
      });
      _markers.show(_enabled);
      const ready = rebuild([..._records.values()]);
      if (_enabled) installClickHandler();
      return ready;
    },
    detachRenderer() {
      removeClickHandler();
      overlayHost?.clearSource?.(SHIPWRECKS_OVERLAY_SOURCE_ID);
      _markers?.destroy();
      _markers = null;
      _pins = [];
      engine = null;
    },
    show(value) {
      _markers?.show(value);
      overlayHost?.setVisible?.(SHIPWRECKS_OVERLAY_SOURCE_ID, value);
    },
    enable() {
      _enabled = true;
      this.show(true);
      installClickHandler();
      if (_selectedId) publishCard();
    },

    disable() {
      _enabled = false;
      _request?.abort();
      _request = null;
      this.show(false);
      removeClickHandler();
      clearSelection();
      render();
    },

    async update() {
      if (!_enabled) return false;
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
          _records.size > 0;
        _snapshot = snapshot;
        _deadline = snapshotDeadline(snapshot, now());
        _lastError =
          snapshot.sources.emodnet && snapshot.sources.wikidata
            ? null
            : snapshot.sources.emodnet
              ? msg('Wikidata unavailable; showing EMODnet only')
              : msg('EMODnet unavailable; showing Wikidata only');
        if (!unchanged) await rebuild(snapshot.records);
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
      layer.detachRenderer();
      _records = new Map();
      _pins = [];
      _snapshot = null;
      _deadline = null;
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
