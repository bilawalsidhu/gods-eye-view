import * as Cesium from 'cesium';
import { formatNumber, msg, t, tn } from '../../i18n/index.js';
import {
  SA_ROAD_EVENTS_OVERLAY_SOURCE_ID,
  SA_ROAD_EVENT_KIND_LABELS,
  buildSaRoadEventCard,
  feedUpdatedText,
  roadEventColor,
} from './cards.js';
import { validateSaRoadEventsPayload } from './records.js';
export * from './cards.js';
export * from './records.js';
export { createSaRoadEventsSource } from './source.js';

export const SA_ROAD_EVENTS_LAYER_ID = 'sa-road-events';

/**
 * Point kinds shown until the user changes the row chips. The incident-class
 * kinds (incident, collision, flooding, emergency waterworks) stay on; both
 * roadworks kinds ("24HR ROADWORKS" is ~90% of the feed) are off so they do
 * not drown the rest, and their row chips show how many are hidden.
 * Unrecognised kinds stay visible so a new upstream category is never silently
 * hidden. Closures and detours (lines) are always shown.
 */
export const SA_ROAD_EVENT_DEFAULT_VISIBLE_KINDS = Object.freeze([
  'incident',
  'collision',
  'flooding',
  'waterworks',
  'unknown',
]);

const PICK_PREFIX = 'sa-road-event:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const MARKER_PIXELS = Object.freeze({
  incident: 13,
  collision: 13,
  flooding: 13,
  waterworks: 13,
  works24: 8,
  works: 7,
  unknown: 7,
});
const SELECTED_EXTRA_PIXELS = 5;
const LEGEND_ORDER = [
  'incident',
  'collision',
  'flooding',
  'waterworks',
  'closure',
  'detour',
  'works24',
  'works',
  'unknown',
];
// Legend entries that appear only while the feed actually carries them.
const LEGEND_WHEN_PRESENT = new Set([
  'collision',
  'flooding',
  'waterworks',
  'unknown',
]);
const POINT_KINDS = new Set([
  'incident',
  'collision',
  'flooding',
  'waterworks',
  'works24',
  'works',
  'unknown',
]);

/**
 * Resolve a pick id to this layer's record key (`point:<id>` / `line:<id>`),
 * or null for foreign ids.
 * @param {*} pickId - Resolved pick id from the scene.
 * @returns {string|null}
 */
export function saRoadEventKeyFromPick(pickId) {
  if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
    return null;
  const [geom, id] = pickId.slice(PICK_PREFIX.length).split(':');
  return (geom === 'point' || geom === 'line') && id ? `${geom}:${id}` : null;
}

const cesiumColor = (kind, alpha = 1) =>
  Cesium.Color.fromCssColorString(roadEventColor(kind)).withAlpha(alpha);

function lineMaterial(kind) {
  if (kind === 'detour')
    return new Cesium.PolylineDashMaterialProperty({
      color: cesiumColor(kind, 0.95),
      dashLength: 16,
    });
  return new Cesium.ColorMaterialProperty(cesiumColor(kind, 0.92));
}

/**
 * Own the Traffic SA road-event display: one refresh lifecycle, ground-clamped
 * point markers (with horizon culling and a per-kind filter), clamped
 * closure/detour lines, and click-to-card selection.
 */
export function createSaRoadEventsLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('SA road events require a snapshot source');
  let _viewer = null;
  let _dataSource = null;
  let _request = null;
  let _signature = null;
  let _enabled = false;
  let _lastUpdate = null;
  let _lastError = null;
  let _feed = null;
  let _clickHandler = null;
  let _selectedKey = null;
  let _removePreRender = null;
  let _occluder = null;
  let _listener = null;
  const _visibleKinds = new Set(SA_ROAD_EVENT_DEFAULT_VISIBLE_KINDS);
  /** @type {Map<string, {record: object, entity: Cesium.Entity, position: Cesium.Cartesian3, onHorizon: boolean}>} */
  const _points = new Map();
  /** @type {Map<string, {record: object}>} */
  const _lines = new Map();

  const canSelect = () =>
    Boolean(overlayHost && screenSpaceEventHandlerFactory && picking);
  const requestRender = () => {
    if (_viewer && !_viewer.isDestroyed?.()) _viewer.scene?.requestRender?.();
  };
  const notify = () => _listener?.();
  const recordFor = (key) =>
    _points.get(key)?.record || _lines.get(key)?.record || null;
  const isShown = (marker) =>
    _visibleKinds.has(marker.record.kind) && marker.onHorizon;

  function markerSize(marker, selected) {
    return (
      (MARKER_PIXELS[marker.record.kind] || MARKER_PIXELS.unknown) +
      (selected ? SELECTED_EXTRA_PIXELS : 0)
    );
  }

  function applyVisibility() {
    let changed = false;
    for (const marker of _points.values()) {
      const show = isShown(marker);
      if (marker.entity.show !== show) {
        marker.entity.show = show;
        changed = true;
      }
    }
    return changed;
  }

  // Markers never depth-test (they would sink into terrain), so markers on
  // the far side of the globe are hidden explicitly.
  function cullHorizon() {
    if (!_viewer || !_points.size) return;
    _occluder ||= new Cesium.EllipsoidalOccluder(
      Cesium.Ellipsoid.WGS84,
      _viewer.camera.positionWC,
    );
    _occluder.cameraPosition = _viewer.camera.positionWC;
    for (const marker of _points.values())
      marker.onHorizon = _occluder.isPointVisible(marker.position);
    if (applyVisibility()) requestRender();
  }

  function syncHorizonListener() {
    if (!(_enabled && _points.size)) {
      _removePreRender?.();
      _removePreRender = null;
      return;
    }
    if (_removePreRender || !_viewer?.scene?.preRender) return;
    _removePreRender = _viewer.scene.preRender.addEventListener(cullHorizon);
  }

  function highlight(key, selected) {
    const marker = _points.get(key);
    if (marker?.entity.point)
      marker.entity.point.pixelSize = markerSize(marker, selected);
  }

  function publishSelectedCard() {
    if (!canSelect()) return;
    const record = _selectedKey ? recordFor(_selectedKey) : null;
    const visible =
      record &&
      (_lines.has(_selectedKey) || isShown(_points.get(_selectedKey)));
    if (!record || !visible) {
      _selectedKey = null;
      overlayHost.setEntries(
        SA_ROAD_EVENTS_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const [lon, lat] = _lines.has(_selectedKey)
      ? record.anchor
      : [record.lon, record.lat];
    overlayHost.setEntries(
      SA_ROAD_EVENTS_OVERLAY_SOURCE_ID,
      [
        {
          ...buildSaRoadEventCard(record, {
            nowMs: Date.now(),
            feedUpdatedMs: _feed?.fetchedAt ?? null,
            stale: _feed?.stale === true,
          }),
          position: Cesium.Cartesian3.fromDegrees(lon, lat),
        },
      ],
      CARD_HOST_OPTIONS,
    );
  }

  function select(key) {
    if (_selectedKey && _selectedKey !== key) highlight(_selectedKey, false);
    _selectedKey = key;
    if (key) highlight(key, true);
    publishSelectedCard();
    requestRender();
  }

  function clearSelection() {
    if (_selectedKey) highlight(_selectedKey, false);
    _selectedKey = null;
    if (overlayHost) {
      overlayHost.clearSource(SA_ROAD_EVENTS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible?.(SA_ROAD_EVENTS_OVERLAY_SOURCE_ID, false);
    }
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const picked = _viewer.scene.pick(click.position);
      const pickId = picked ? picking.resolvePickId(picked) : null;
      const key = saRoadEventKeyFromPick(pickId);
      if (key && (_points.has(key) || _lines.has(key))) {
        select(key);
        return;
      }
      // A sibling layer's pick is not empty space; leave the selection alone.
      if (pickId && picking.isOwnedByOtherLayer(layer.id, pickId)) return;
      if (_selectedKey) select(null);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    _clickHandler?.destroy();
    _clickHandler = null;
  }

  function replaceEntities({ points, lines }) {
    const entities = _dataSource.entities;
    entities.suspendEvents();
    try {
      entities.removeAll();
      _points.clear();
      _lines.clear();
      for (const record of lines) {
        _lines.set(`line:${record.id}`, { record });
        record.lines.forEach((vertices, index) => {
          entities.add(
            new Cesium.Entity({
              id: `${PICK_PREFIX}line:${record.id}:${index}`,
              polyline: {
                positions: vertices.map(([lon, lat]) =>
                  Cesium.Cartesian3.fromDegrees(lon, lat),
                ),
                clampToGround: true,
                classificationType: Cesium.ClassificationType.BOTH,
                width: 4,
                material: lineMaterial(record.kind),
              },
            }),
          );
        });
      }
      for (const record of points) {
        const position = Cesium.Cartesian3.fromDegrees(record.lon, record.lat);
        const marker = { record, position, onHorizon: true, entity: null };
        marker.entity = new Cesium.Entity({
          id: `${PICK_PREFIX}point:${record.id}`,
          position,
          show: _visibleKinds.has(record.kind),
          point: {
            pixelSize: markerSize(marker, false),
            color: cesiumColor(record.kind),
            outlineColor: Cesium.Color.fromCssColorString('#10161d'),
            outlineWidth: 1.5,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
        entities.add(marker.entity);
        _points.set(`point:${record.id}`, marker);
      }
    } finally {
      entities.resumeEvents();
    }
  }

  function setKindVisible(kind, visible) {
    if (!POINT_KINDS.has(kind)) return;
    if (visible) _visibleKinds.add(kind);
    else _visibleKinds.delete(kind);
    applyVisibility();
    if (_selectedKey) publishSelectedCard();
    requestRender();
    notify();
  }

  const visibleCount = () =>
    _lines.size +
    [..._points.values()].filter((marker) => isShown(marker)).length;

  const layer = {
    id: SA_ROAD_EVENTS_LAYER_ID,
    name: 'SA Road Events',
    icon: '🚧',
    source: 'Traffic SA',
    updateInterval: 120000,

    init(viewer) {
      if (_viewer) throw new Error('SA road events are already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(SA_ROAD_EVENTS_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      overlayHost?.setVisible?.(SA_ROAD_EVENTS_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(SA_ROAD_EVENTS_OVERLAY_SOURCE_ID, true);
      picking?.registerPickOwner?.(
        layer.id,
        (pickId) => saRoadEventKeyFromPick(pickId) !== null,
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
        const raw = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        // Validate the whole payload before touching what is on screen.
        const snapshot = validateSaRoadEventsPayload(raw);
        if (!snapshot) throw new Error('Malformed Traffic SA snapshot');
        const signature = JSON.stringify([snapshot.points, snapshot.lines]);
        if (signature !== _signature) {
          replaceEntities(snapshot);
          _signature = signature;
          if (_selectedKey && recordFor(_selectedKey))
            highlight(_selectedKey, true);
          syncHorizonListener();
          console.log(
            `[Data:SaRoadEvents] Updated: ${snapshot.points.length} points, ${snapshot.lines.length} lines`,
          );
        }
        _feed = {
          fetchedAt: snapshot.fetchedAt,
          stale: snapshot.stale,
          mirror: snapshot.mirror,
          sources: snapshot.sources,
        };
        if (_selectedKey) publishSelectedCard();
        _lastUpdate = Date.now();
        _lastError = null;
        requestRender();
        notify();
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        // Keep the previous entities: a failed refresh never blanks the map.
        console.warn('[Data:SaRoadEvents] Fetch error:', error);
        _lastError = error?.message || msg('Traffic SA unavailable');
        notify();
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
      _points.clear();
      _lines.clear();
      _signature = null;
      if (_dataSource && viewer) viewer.dataSources.remove(_dataSource, true);
      _dataSource = null;
      _viewer = null;
      _feed = null;
      _lastUpdate = null;
      _lastError = null;
      _visibleKinds.clear();
      for (const kind of SA_ROAD_EVENT_DEFAULT_VISIBLE_KINDS)
        _visibleKinds.add(kind);
    },

    /** Snapshot visible events (no geometry) for the analyst query engine. */
    getAnalystRecords(maxCount = 2000) {
      if (!_enabled || !_dataSource) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const result = [];
      for (const [key, { record }] of _lines) {
        if (result.length >= limit) return result;
        const { lines, anchor, ...facts } = record;
        result.push({
          ...facts,
          id: key,
          lat: anchor[1],
          lon: anchor[0],
        });
      }
      for (const [key, marker] of _points) {
        if (result.length >= limit) return result;
        if (!_visibleKinds.has(marker.record.kind)) continue;
        const { lon, lat, ...facts } = marker.record;
        result.push({ ...facts, id: key, lat, lon });
      }
      return result;
    },

    getRowControls() {
      const counts = new Map();
      for (const { record } of _points.values())
        counts.set(record.kind, (counts.get(record.kind) || 0) + 1);
      for (const { record } of _lines.values())
        counts.set(record.kind, (counts.get(record.kind) || 0) + 1);
      const legend = LEGEND_ORDER.filter(
        (kind) => !LEGEND_WHEN_PRESENT.has(kind) || counts.get(kind),
      ).map((kind, index) => ({
        label: t(SA_ROAD_EVENT_KIND_LABELS[kind]),
        color: roadEventColor(kind),
        count: counts.get(kind) || 0,
        ...(index === 0
          ? {
              blurb: t(
                'Live Traffic SA incidents, closures, detours and roadworks. Click an event for details. Roadworks (both kinds) are hidden until switched on with the chips.',
              ),
            }
          : {}),
      }));
      const chipLabel = (text, kind) =>
        counts.get(kind) ? `${text} · ${formatNumber(counts.get(kind))}` : text;
      const hiddenWorks = ['works24', 'works']
        .filter((kind) => !_visibleKinds.has(kind))
        .reduce((sum, kind) => sum + (counts.get(kind) || 0), 0);
      const info = [
        _feed
          ? feedUpdatedText(_feed.fetchedAt, _feed.stale)
          : t('Waiting for Traffic SA'),
      ];
      // A group the proxy could not serve is not "nothing happening".
      const unavailable = (group) =>
        _feed?.sources?.[group]?.status === 'unavailable';
      if (unavailable('incidents') && unavailable('closures'))
        info.push(t('Incidents and closures unavailable'));
      else if (unavailable('incidents')) info.push(t('Incidents unavailable'));
      else if (unavailable('closures'))
        info.push(t('Closures and detours unavailable'));
      if (unavailable('roadworks')) info.push(t('Roadworks unavailable'));
      if (
        _feed &&
        !visibleCount() &&
        !unavailable('incidents') &&
        !unavailable('closures')
      )
        info.push(t('No incidents or closures reported right now'));
      if (hiddenWorks)
        info.push(
          tn(
            hiddenWorks,
            '{count} roadwork hidden; use the chips to show them',
            '{count} roadworks hidden; use the chips to show them',
            { count: formatNumber(hiddenWorks) },
          ),
        );
      if (_feed?.mirror)
        info.push(t('Roadworks served from the Traffic SA mirror service'));
      if (_lastError)
        info.push(
          _feed
            ? t('Last refresh failed; showing the previous data')
            : t('Traffic SA unavailable'),
        );
      return {
        chips: [
          {
            id: 'works24',
            label: chipLabel(t('24 H WORKS'), 'works24'),
            active: _visibleKinds.has('works24'),
            title: t(
              'Show or hide roadworks that run around the clock (hidden by default)',
            ),
            onClick: () =>
              setKindVisible('works24', !_visibleKinds.has('works24')),
          },
          {
            id: 'works',
            label: chipLabel(t('ROADWORKS'), 'works'),
            active: _visibleKinds.has('works'),
            title: t('Show or hide long-term roadworks (hidden by default)'),
            onClick: () => setKindVisible('works', !_visibleKinds.has('works')),
          },
        ],
        legend,
        info: info.join(' · '),
        infoTitle: t(
          'Roadworks, incidents and closures: Traffic SA, Department for Infrastructure and Transport, Government of South Australia (CC BY 4.0). The time is when the proxy last read the feed, not when each event was entered.',
        ),
      };
    },

    setRowControlsListener(listener) {
      _listener = typeof listener === 'function' ? listener : null;
    },

    getStats() {
      return {
        count: visibleCount(),
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _feed?.stale === true,
      };
    },

    /** Test and diagnostics seam: rendered entity and marker counts. */
    getDiagnostics() {
      return {
        entities: _dataSource?.entities.values.length || 0,
        points: _points.size,
        shownPoints: [..._points.values()].filter((marker) => isShown(marker))
          .length,
        lines: _lines.size,
        selectedKey: _selectedKey,
        horizonListener: Boolean(_removePreRender),
      };
    },
  };
  return layer;
}
