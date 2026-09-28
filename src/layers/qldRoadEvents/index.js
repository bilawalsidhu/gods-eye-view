import * as Cesium from 'cesium';
import {
  QLD_ROAD_EVENTS_OVERLAY_SOURCE_ID,
  QLD_ROAD_EVENT_STYLES,
  QLDTRAFFIC_URL,
  buildQldRoadEventCard,
  qldRoadEventGlyph,
  qldRoadEventStyle,
} from './cards.js';
export * from './cards.js';
export * from './records.js';
export { createQldRoadEventsSource } from './source.js';

export const QLD_ROAD_EVENTS_LAYER_ID = 'qld-road-events';
const PICK_PREFIX = 'qld-road-event:';
const SELECTED_SCALE = 1.35;
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const LEGEND_ORDER = Object.keys(QLD_ROAD_EVENT_STYLES).sort(
  (a, b) => QLD_ROAD_EVENT_STYLES[b].rank - QLD_ROAD_EVENT_STYLES[a].rank,
);

/** Resolve a pick id to the event id it names, or null for foreign ids. */
export function qldRoadEventIdFromPick(pickId) {
  if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
    return null;
  return pickId.slice(PICK_PREFIX.length).split(':')[0] || null;
}

/**
 * Own the QLDTraffic road-event display: one refresh lifecycle, glyph markers
 * with horizon culling, ground-draped event lines, and click-to-card selection.
 */
export function createQldRoadEventsLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  openExternal = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('QLD road events require a snapshot source');
  let _viewer = null;
  let _dataSource = null;
  let _request = null;
  let _signature = null;
  let _enabled = false;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  let _clickHandler = null;
  let _selectedId = null;
  let _selectedCardId = null;
  let _removePreRender = null;
  let _occluder = null;
  /** @type {Map<string, object>} geometry-free event facts by id */
  const _events = new Map();
  /** @type {Map<string, Cesium.Entity>} primary marker per event */
  const _markers = new Map();
  /** @type {Array<{entity: Cesium.Entity, position: Cesium.Cartesian3}>} */
  let _billboards = [];

  const canSelect = () =>
    Boolean(overlayHost && screenSpaceEventHandlerFactory && picking);
  const requestRender = () => {
    if (_viewer && !_viewer.isDestroyed?.()) _viewer.scene?.requestRender?.();
  };

  // Markers never depth-test (they would sink into terrain), so markers on
  // the far side of the globe are hidden explicitly.
  function cullHorizon() {
    if (!_viewer || !_billboards.length) return;
    _occluder ||= new Cesium.EllipsoidalOccluder(
      Cesium.Ellipsoid.WGS84,
      _viewer.camera.positionWC,
    );
    _occluder.cameraPosition = _viewer.camera.positionWC;
    let changed = false;
    for (const { entity, position } of _billboards) {
      const show = _occluder.isPointVisible(position);
      if (entity.show !== show) {
        entity.show = show;
        changed = true;
      }
    }
    if (changed) requestRender();
  }

  function syncHorizonListener() {
    const wanted = _enabled && _billboards.length > 0;
    if (!wanted) {
      _removePreRender?.();
      _removePreRender = null;
      return;
    }
    if (_removePreRender || !_viewer?.scene?.preRender) return;
    _removePreRender = _viewer.scene.preRender.addEventListener(cullHorizon);
  }

  function markerScale(event, selected) {
    const { scale } = qldRoadEventStyle(event.category);
    return selected ? Math.max(scale, 0.8) * SELECTED_SCALE : scale;
  }

  function highlight(id, selected) {
    const entity = _markers.get(id);
    const event = _events.get(id);
    if (entity?.billboard && event)
      entity.billboard.scale = markerScale(event, selected);
  }

  function publishSelectedCard() {
    if (!canSelect()) return;
    const event = _selectedId ? _events.get(_selectedId) : null;
    if (!event) {
      _selectedId = null;
      _selectedCardId = null;
      overlayHost.setEntries(
        QLD_ROAD_EVENTS_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = {
      ...buildQldRoadEventCard(event, Date.now()),
      position: Cesium.Cartesian3.fromDegrees(event.anchor[0], event.anchor[1]),
    };
    if (openExternal)
      card.activate = () => {
        openExternal(QLDTRAFFIC_URL);
        return true;
      };
    else card.interactive = false;
    _selectedCardId = card.id;
    overlayHost.setEntries(
      QLD_ROAD_EVENTS_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  function select(id) {
    if (_selectedId && _selectedId !== id) highlight(_selectedId, false);
    _selectedId = id;
    if (id) highlight(id, true);
    publishSelectedCard();
    requestRender();
  }

  function clearSelection() {
    if (_selectedId) highlight(_selectedId, false);
    _selectedId = null;
    _selectedCardId = null;
    if (overlayHost) {
      overlayHost.clearSource(QLD_ROAD_EVENTS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible?.(QLD_ROAD_EVENTS_OVERLAY_SOURCE_ID, false);
    }
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const cardHit = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
        { sourceId: QLD_ROAD_EVENTS_OVERLAY_SOURCE_ID },
      );
      if (cardHit && cardHit.entryId === _selectedCardId) {
        openExternal?.(QLDTRAFFIC_URL);
        return;
      }
      const picked = _viewer.scene.pick(click.position);
      const pickId = picked ? picking.resolvePickId(picked) : null;
      const eventId = qldRoadEventIdFromPick(pickId);
      if (eventId && _events.has(eventId)) {
        select(eventId);
        return;
      }
      // A sibling layer's pick is not empty space; leave the selection alone.
      if (pickId && picking.isOwnedByOtherLayer(layer.id, pickId)) return;
      if (_selectedId) select(null);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    _clickHandler?.destroy();
    _clickHandler = null;
  }

  function buildEntities(events) {
    const entities = [];
    const billboards = [];
    const markers = new Map();
    for (const event of events) {
      const style = qldRoadEventStyle(event.category);
      const color = Cesium.Color.fromCssColorString(style.color);
      const image = qldRoadEventGlyph(event.category);
      event.lines.forEach((line, index) => {
        entities.push(
          new Cesium.Entity({
            id: `${PICK_PREFIX}${event.id}:line:${index}`,
            polyline: {
              positions: line.map(([lon, lat]) =>
                Cesium.Cartesian3.fromDegrees(lon, lat),
              ),
              clampToGround: true,
              classificationType: Cesium.ClassificationType.BOTH,
              width: style.lineWidth,
              material: style.dashed
                ? new Cesium.PolylineDashMaterialProperty({
                    color: color.withAlpha(style.lineAlpha),
                    dashLength: 12,
                  })
                : new Cesium.ColorMaterialProperty(
                    color.withAlpha(style.lineAlpha),
                  ),
            },
          }),
        );
      });
      const anchors = [event.anchor];
      for (const point of event.points)
        if (point[0] !== event.anchor[0] || point[1] !== event.anchor[1])
          anchors.push(point);
      anchors.forEach(([lon, lat], index) => {
        const position = Cesium.Cartesian3.fromDegrees(lon, lat);
        const primary = index === 0;
        const entity = new Cesium.Entity({
          id: primary
            ? `${PICK_PREFIX}${event.id}`
            : `${PICK_PREFIX}${event.id}:point:${index}`,
          position,
          billboard: {
            image,
            scale: primary ? style.scale : style.scale * 0.7,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            verticalOrigin: Cesium.VerticalOrigin.CENTER,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance: new Cesium.NearFarScalar(2e3, 1.2, 2e6, 0.55),
            ...(style.fade
              ? {
                  translucencyByDistance: new Cesium.NearFarScalar(
                    5e4,
                    1,
                    1.5e6,
                    0.35,
                  ),
                }
              : {}),
          },
        });
        entities.push(entity);
        billboards.push({ entity, position });
        if (primary) markers.set(event.id, entity);
      });
    }
    return { entities, billboards, markers };
  }

  const layer = {
    id: QLD_ROAD_EVENTS_LAYER_ID,
    name: 'QLD Road Events',
    icon: '⚠',
    source: 'QLDTraffic',
    updateInterval: 120000,

    init(viewer) {
      if (_viewer) throw new Error('QLD road events are already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(QLD_ROAD_EVENTS_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      overlayHost?.setVisible?.(QLD_ROAD_EVENTS_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(QLD_ROAD_EVENTS_OVERLAY_SOURCE_ID, true);
      picking?.registerPickOwner?.(
        layer.id,
        (pickId) => qldRoadEventIdFromPick(pickId) !== null,
      );
      installClickHandler();
      syncHorizonListener();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      picking?.unregisterPickOwner?.(layer.id);
      removeClickHandler();
      clearSelection();
      syncHorizonListener();
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
        const events = snapshot.events;
        _stale = snapshot.stale === true;
        const signature = JSON.stringify(events);
        if (signature !== _signature) {
          const { entities, billboards, markers } = buildEntities(events);
          _dataSource.entities.removeAll();
          for (const entity of entities) _dataSource.entities.add(entity);
          _billboards = billboards;
          _markers.clear();
          for (const [id, entity] of markers) _markers.set(id, entity);
          _events.clear();
          for (const { points, lines, ...facts } of events)
            _events.set(facts.id, facts);
          _signature = signature;
          _count = events.length;
          if (_selectedId && _events.has(_selectedId))
            highlight(_selectedId, true);
          syncHorizonListener();
          console.log(
            `[Data:QldRoadEvents] Updated: ${_count} events, ${entities.length} entities`,
          );
        }
        if (_selectedId) publishSelectedCard();
        _lastUpdate = Date.now();
        _lastError = null;
        requestRender();
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:QldRoadEvents] Fetch error:', error);
        _lastError = error?.message || 'QLDTraffic unavailable';
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      this.disable();
      _removePreRender?.();
      _removePreRender = null;
      _occluder = null;
      _events.clear();
      _markers.clear();
      _billboards = [];
      _signature = null;
      if (_dataSource && viewer) viewer.dataSources.remove(_dataSource, true);
      _dataSource = null;
      _viewer = null;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
    },

    getRowControls() {
      const counts = new Map();
      for (const event of _events.values())
        counts.set(event.category, (counts.get(event.category) || 0) + 1);
      const legend = LEGEND_ORDER.filter(
        (category) => category !== 'other' || counts.get('other'),
      ).map((category, index) => ({
        label: QLD_ROAD_EVENT_STYLES[category].label,
        color: QLD_ROAD_EVENT_STYLES[category].color,
        count: counts.get(category) || 0,
        ...(index === 0
          ? {
              blurb:
                'Live Queensland road incidents. Roadworks are small, faded and dashed so incidents stand out. Click an event for details.',
            }
          : {}),
      }));
      return { chips: [], legend };
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
      };
    },

    /** Test and diagnostics seam: rendered entity and marker counts. */
    getDiagnostics() {
      return {
        entities: _dataSource?.entities.values.length || 0,
        markers: _billboards.length,
        selectedId: _selectedId,
        horizonListener: Boolean(_removePreRender),
      };
    },
  };
  return layer;
}
