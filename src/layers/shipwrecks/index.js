import * as Cesium from 'cesium';
import { formatNumber, msg, t, tn } from '../../i18n/index.js';
import { createHorizonCull } from '../streetLevel/view.js';
import { ERA_COLORS, ERA_LABELS, describeShipwreck } from './cards.js';
import { SHIPWRECK_ERAS, eraOf, normalizeEras } from './eras.js';
export * from './records.js';
export * from './cards.js';
export * from './eras.js';
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
/**
 * Marker size in pixels: grows with the death toll, as on the air-accidents
 * layer, from 16 px (no deaths known) to 36 px (about a thousand or more).
 */
export function markerPixelSize(casualties) {
  const n = Number.isFinite(casualties) && casualties > 0 ? casualties : 0;
  return Math.round(16 + Math.min(20, Math.log2(1 + n) * 2));
}

/**
 * A round marker in the era's colour with a sinking hull and mast in the
 * middle, as an SVG data URL.
 * @param {string} color CSS colour.
 * @returns {string}
 */
export function wreckMarkerImage(color) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">` +
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
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  openExternal = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Shipwrecks require a snapshot source');
  let _viewer = null;
  let _enabled = false;
  let _dataSource = null;
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
  let _eras = new Set(SHIPWRECK_ERAS);
  const _images = Object.fromEntries(
    SHIPWRECK_ERAS.map((era) => [era, wreckMarkerImage(ERA_COLORS[era])]),
  );

  const render = () => _viewer?.scene?.requestRender?.();
  const notifyRow = () => _rowListener?.();
  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;
  // Markers skip the depth test so terrain does not swallow them; the
  // horizon cull hides the far side of the planet instead.
  const _horizon = createHorizonCull({
    getViewer: () => _viewer,
    items: () => _pins,
    onChange: render,
  });

  /** Shown: its era chip is on. */
  function visible(record) {
    return Boolean(record) && _eras.has(eraOf(record));
  }

  function applyPin(pin) {
    pin.entity.show = pin.inFront && visible(pin.record);
  }

  /** Re-apply the era chips to every marker and the open card. */
  function applyFilter() {
    for (const pin of _pins) applyPin(pin);
    if (_selectedId && !visible(_records.get(_selectedId))) clearSelection();
    notifyRow();
    render();
  }

  function rebuild(records) {
    _records = new Map(records.map((record) => [record.id, record]));
    _pins = [];
    if (!_dataSource) return;
    _dataSource.entities.suspendEvents();
    _dataSource.entities.removeAll();
    for (const record of records) {
      const position = Cesium.Cartesian3.fromDegrees(record.lon, record.lat);
      const entity = _dataSource.entities.add({
        id: `${PICK_PREFIX}${record.id}`,
        position,
        billboard: {
          image: _images[eraOf(record)],
          width: markerPixelSize(record.casualties),
          height: markerPixelSize(record.casualties),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          // Bigger toll, drawn on top of smaller neighbours.
          eyeOffset: new Cesium.Cartesian3(
            0,
            0,
            -Math.min(record.casualties || 0, 5000),
          ),
        },
      });
      const pin = {
        entity,
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
    _dataSource.entities.resumeEvents();
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
      position: Cesium.Cartesian3.fromDegrees(record.lon, record.lat),
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
    const pickId = picking.resolvePickId(picked);
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
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const cardHit = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
        { sourceId: SHIPWRECKS_OVERLAY_SOURCE_ID },
      );
      if (cardHit && cardHit.entryId === _selectedCardId) {
        if (_selectedLink) openExternal(_selectedLink);
        return;
      }
      const picked = _viewer.scene.pick(click.position);
      const id = picked ? pickedRecordId(picked) : null;
      if (id) {
        _selectedId = id;
        publishCard();
        render();
        return;
      }
      if (picked) {
        const pickId = picking.resolvePickId(picked);
        if (pickId && picking.isOwnedByOtherLayer(SHIPWRECKS_LAYER_ID, pickId))
          return;
      }
      if (_selectedId) {
        clearSelection();
        render();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    _clickHandler?.destroy();
    _clickHandler = null;
    picking?.unregisterPickOwner?.(SHIPWRECKS_LAYER_ID);
  }

  function toggleEra(era) {
    if (_eras.has(era)) _eras.delete(era);
    else _eras.add(era);
    applyFilter();
  }

  function countOf(era) {
    let count = 0;
    for (const record of _records.values()) if (eraOf(record) === era) count++;
    return count;
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
      _dataSource = new Cesium.CustomDataSource(SHIPWRECKS_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      installClickHandler();
      if (_pins.length) _horizon.update();
    },

    disable() {
      _enabled = false;
      _request?.abort();
      _request = null;
      if (_dataSource) _dataSource.show = false;
      removeClickHandler();
      clearSelection();
      _horizon.stop();
      render();
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
        _snapshot = snapshot;
        _lastError =
          snapshot.sources.emodnet && snapshot.sources.wikidata
            ? null
            : snapshot.sources.emodnet
              ? msg('Wikidata unavailable; showing EMODnet only')
              : msg('EMODnet unavailable; showing Wikidata only');
        rebuild(snapshot.records);
        notifyRow();
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:Shipwrecks] Fetch error:', error);
        _lastError = error?.message || msg('Shipwrecks unavailable');
        notifyRow();
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      layer.disable();
      if (_dataSource) {
        viewer?.dataSources?.remove(_dataSource, true);
        _dataSource = null;
      }
      _records = new Map();
      _pins = [];
      _snapshot = null;
      _viewer = null;
      _rowListener = null;
    },

    /** The era filter: `eras` lists the era chips that are on. */
    getParams() {
      return { eras: SHIPWRECK_ERAS.filter((era) => _eras.has(era)) };
    },

    setParams(params = {}) {
      if (!('eras' in params)) return true;
      const next = normalizeEras(params.eras, _eras);
      if (next.size === _eras.size && [...next].every((era) => _eras.has(era)))
        return true;
      _eras = next;
      applyFilter();
      return true;
    },

    setRowControlsListener(listener) {
      _rowListener = listener;
    },

    getRowControls() {
      return {
        chips: SHIPWRECK_ERAS.map((era) => ({
          id: era,
          label: t(ERA_LABELS[era]),
          active: _eras.has(era),
          color: ERA_COLORS[era],
          title: tn(countOf(era), '{count} wreck', '{count} wrecks', {
            count: formatNumber(countOf(era)),
          }),
          onClick: () => toggleEra(era),
        })),
        legend: [],
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
