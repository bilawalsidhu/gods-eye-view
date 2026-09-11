import * as Cesium from 'cesium';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import {
  WORLD_NEWS_DISCLAIMER,
  mapAnalystRecord,
  normalizeWorldNewsSnapshot,
} from './worldNewsData.js';
import {
  WORLD_DESK_CATEGORIES,
  WORLD_DESK_ERA_END,
  WORLD_DESK_ERA_START,
  WORLD_DESK_HISTORY,
  eventsVisibleOnPlayhead,
  formatWorldDeskYear,
} from './worldNewsHistory.js';

export {
  WORLD_NEWS_ARTICLE_CAP,
  WORLD_NEWS_DISCLAIMER,
  WORLD_NEWS_HEADLINES_PER_POINT,
  WORLD_NEWS_POINT_CAP,
  WORLD_NEWS_QUERY,
  clusterWorldNewsPoints,
  countryCentroid,
  mapAnalystRecord,
  normalizeWorldNewsArticles,
  normalizeWorldNewsSnapshot,
} from './worldNewsData.js';

/**
 * World News — GDELT DOC 2.0 headlines clustered on the globe.
 *
 * Pins are the **outlet country** of matching coverage, not a verified
 * incident location. GDELT's GEO PointData API is not a reliable runtime
 * dependency (404/403 from this stack); the DOC article list is the same
 * index the cockpit already uses as its headline fallback.
 */

export const WORLD_NEWS_LAYER_ID = 'world-news';
export const WORLD_NEWS_OVERLAY_SOURCE_ID = 'world-news';
export const WORLD_NEWS_SELECTED_OVERLAY_SOURCE_ID = 'world-news-selected';
export const WORLD_NEWS_OVERLAY_COHORT_LIMIT = 64;
export const WORLD_NEWS_OVERLAY_COLLISION_CAPACITY = 48;
export const WORLD_NEWS_UPDATE_INTERVAL_MS = 5 * 60_000;
export const WORLD_NEWS_ACCENT = '#ffd166';

export const WORLD_NEWS_SELECTED_OVERLAY_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  moving: false,
});

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

export function createWorldNewsOverlayEntry({ id, position, place, count }) {
  return {
    id: String(id),
    position,
    variant: 'label',
    title: String(place),
    accent: WORLD_NEWS_ACCENT,
    priority: Math.round(Number(count) * 1000),
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}

export function selectWorldNewsOverlayCohort(
  entries,
  limit = WORLD_NEWS_OVERLAY_COHORT_LIMIT,
) {
  const cap = Math.max(0, Math.min(
    WORLD_NEWS_OVERLAY_COHORT_LIMIT,
    Math.floor(Number(limit) || 0),
  ));
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries.slice().sort((a, b) => (
    b.priority - a.priority || String(a.id).localeCompare(String(b.id))
  )).slice(0, cap);
}

export function createWorldNewsSelectedOverlayEntry(point, position) {
  if (!point?.id || !position) return null;
  const headline = point.articles?.[0];
  const details = [
    `${point.count} headline${point.count === 1 ? '' : 's'} · outlet country`,
    headline ? `${headline.domain} · ${headline.title}` : WORLD_NEWS_DISCLAIMER,
  ];
  return {
    id: String(point.id),
    position,
    variant: 'selected',
    selected: true,
    protected: true,
    paintLane: 'selected',
    collisionGroup: 'ambient-card',
    priority: Number.MAX_SAFE_INTEGER,
    title: point.place,
    details,
    accent: WORLD_NEWS_ACCENT,
    interactive: false,
    anchorRadiusPx: 9,
    minAnchorGapPx: 11,
    verticalOnly: true,
    placement: 'above',
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
  };
}

export function createWorldNewsLayer({
  overlayHost = DEFAULT_OVERLAY_HOST,
  fetchImpl = fetch,
} = {}) {
  let _dataSource = null;
  let _handler = null;
  let _records = new Map();
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _geometry = 'outlet-country';
  let _source = 'GDELT';
  let _selectedId = null;
  let _year = WORLD_DESK_ERA_END;
  let _categories = new Set(WORLD_DESK_CATEGORIES.map((row) => row.id));
  let _liveSnapshot = { points: [] };

  function syncTimelineDock() {
    const dock = globalThis.document?.getElementById('world-desk-timeline');
    if (!dock) return;
    dock.hidden = !_enabled;
    const label = dock.querySelector('[data-world-desk-year]');
    if (label) label.textContent = formatWorldDeskYear(_year);
    const slider = dock.querySelector('#world-desk-year');
    if (slider && Number(slider.value) !== _year) slider.value = String(_year);
  }

  function paint() {
    if (!_dataSource) return;
    const nextEntities = [];
    const overlayEntries = [];
    const nextRecords = new Map();
    const liveColor = Cesium.Color.fromCssColorString(WORLD_NEWS_ACCENT);
    const historyColor = Cesium.Color.fromCssColorString('#4cc9f0');
    const showLive = _categories.has('live') && _year >= WORLD_DESK_ERA_END - 2;
    if (showLive) {
      for (const point of _liveSnapshot.points || []) {
        const position = Cesium.Cartesian3.fromDegrees(point.lon, point.lat);
        nextRecords.set(point.id, { ...point, place: point.place, articles: point.articles, count: point.count });
        nextEntities.push(new Cesium.Entity({
          id: `world-news:${point.id}`,
          position,
          point: {
            pixelSize: 8 + Math.min(14, Math.round(Math.log2((point.count || 1) + 1) * 4)),
            color: liveColor.withAlpha(0.92),
            outlineColor: Cesium.Color.BLACK.withAlpha(0.55),
            outlineWidth: 1,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          properties: {
            place: point.place,
            count: point.count,
            title: point.articles?.[0]?.title || null,
            domain: point.articles?.[0]?.domain || null,
            url: point.articles?.[0]?.url || null,
          },
        }));
        overlayEntries.push(createWorldNewsOverlayEntry({
          id: point.id, position, place: point.place, count: point.count,
        }));
      }
    }
    const historic = eventsVisibleOnPlayhead(
      WORLD_DESK_HISTORY.filter((event) => _categories.has(event.category)),
      _year,
    );
    for (const event of historic) {
      const position = Cesium.Cartesian3.fromDegrees(event.lon, event.lat);
      nextRecords.set(event.id, {
        id: event.id,
        place: event.place,
        lat: event.lat,
        lon: event.lon,
        count: 1,
        articles: [{ title: event.title, url: '', domain: event.category }],
      });
      nextEntities.push(new Cesium.Entity({
        id: `world-news:${event.id}`,
        position,
        point: {
          pixelSize: 9,
          color: historyColor.withAlpha(0.9),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.5),
          outlineWidth: 1,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        properties: {
          place: event.place,
          count: 1,
          title: event.title,
          domain: event.category,
          url: null,
        },
      }));
      overlayEntries.push(createWorldNewsOverlayEntry({
        id: event.id, position, place: event.title, count: 1,
      }));
    }
    _dataSource.entities.removeAll();
    for (const entity of nextEntities) _dataSource.entities.add(entity);
    _records = nextRecords;
    _count = nextRecords.size;
    if (_enabled) {
      overlayHost.setEntries(
        WORLD_NEWS_OVERLAY_SOURCE_ID,
        selectWorldNewsOverlayCohort(overlayEntries),
        {
          cohortLimit: WORLD_NEWS_OVERLAY_COHORT_LIMIT,
          collisionCapacity: WORLD_NEWS_OVERLAY_COLLISION_CAPACITY,
          moving: false,
        },
      );
    }
    syncTimelineDock();
  }

  function clearSelection() {
    _selectedId = null;
    overlayHost.clearSource(WORLD_NEWS_SELECTED_OVERLAY_SOURCE_ID);
  }

  function publishSelection(point, position) {
    const entry = createWorldNewsSelectedOverlayEntry(point, position);
    if (!entry) {
      clearSelection();
      return;
    }
    _selectedId = point.id;
    overlayHost.setEntries(
      WORLD_NEWS_SELECTED_OVERLAY_SOURCE_ID,
      [entry],
      WORLD_NEWS_SELECTED_OVERLAY_OPTIONS,
    );
    overlayHost.setVisible(WORLD_NEWS_SELECTED_OVERLAY_SOURCE_ID, true);
  }

  const layer = {
    id: WORLD_NEWS_LAYER_ID,
    name: 'World News',
    icon: '📰',
    source: 'GDELT',
    updateInterval: WORLD_NEWS_UPDATE_INTERVAL_MS,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource(WORLD_NEWS_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _records = new Map();
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      _selectedId = null;
      overlayHost.setVisible(WORLD_NEWS_OVERLAY_SOURCE_ID, false);
      overlayHost.setVisible(WORLD_NEWS_SELECTED_OVERLAY_SOURCE_ID, false);
      if (
        viewer?.scene?.canvas
        && typeof Cesium.ScreenSpaceEventHandler === 'function'
        && globalThis.document
      ) {
        _handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        _handler.setInputAction((click) => {
          if (!_enabled) return;
          const picked = viewer.scene.pick(click.position);
          const entity = picked?.id;
          const entityId = typeof entity?.id === 'string' ? entity.id : '';
          if (!entityId.startsWith('world-news:')) {
            clearSelection();
            return;
          }
          const key = entityId.slice('world-news:'.length);
          const point = _records.get(key);
          if (!point) {
            clearSelection();
            return;
          }
          publishSelection(point, entity.position?.getValue(Cesium.JulianDate.now()));
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      }
      const slider = globalThis.document?.getElementById('world-desk-year');
      slider?.addEventListener('input', () => {
        _year = Number(slider.value);
        syncTimelineDock();
        paint();
      });
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(WORLD_NEWS_OVERLAY_SOURCE_ID, true);
      overlayHost.setVisible(WORLD_NEWS_SELECTED_OVERLAY_SOURCE_ID, Boolean(_selectedId));
      syncTimelineDock();
    },

    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(WORLD_NEWS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(WORLD_NEWS_OVERLAY_SOURCE_ID, false);
      clearSelection();
      overlayHost.setVisible(WORLD_NEWS_SELECTED_OVERLAY_SOURCE_ID, false);
      syncTimelineDock();
    },

    async update() {
      try {
        const response = await fetchImpl('/api/world-news');
        if (response.ok) {
          const snapshot = normalizeWorldNewsSnapshot(await response.json());
          if (snapshot) {
            _liveSnapshot = snapshot;
            _geometry = snapshot.geometry;
            _source = snapshot.source;
            _lastError = snapshot.status === 'empty' ? null : null;
          } else _lastError = 'Malformed world-news response';
        } else _lastError = `GDELT HTTP ${response.status}`;
      } catch {
        _lastError = 'GDELT network error';
      }
      paint();
      _lastUpdate = Date.now();
      return _count > 0;
    },

    setParams(next = {}) {
      if (Number.isFinite(Number(next.year))) {
        _year = Math.min(WORLD_DESK_ERA_END, Math.max(WORLD_DESK_ERA_START, Number(next.year)));
      }
      if (Array.isArray(next.categories)) {
        _categories = new Set(next.categories);
      }
      if (typeof next.category === 'string') {
        if (_categories.has(next.category)) _categories.delete(next.category);
        else _categories.add(next.category);
        if (_categories.size === 0) _categories.add(next.category);
      }
      syncTimelineDock();
      paint();
      return true;
    },

    getParams() {
      return { year: _year, categories: [..._categories] };
    },

    destroy(viewer) {
      _enabled = false;
      overlayHost.clearSource(WORLD_NEWS_OVERLAY_SOURCE_ID);
      overlayHost.clearSource(WORLD_NEWS_SELECTED_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(WORLD_NEWS_OVERLAY_SOURCE_ID, false);
      overlayHost.setVisible(WORLD_NEWS_SELECTED_OVERLAY_SOURCE_ID, false);
      _handler?.destroy?.();
      _handler = null;
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _records = new Map();
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _selectedId = null;
    },

    getAnalystRecords(maxCount = 2000) {
      if (!_enabled) return [];
      const limit = Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 2000;
      return [..._records.values()].slice(0, limit).map((point, index) => mapAnalystRecord(point, index));
    },

    getRowControls() {
      if (!_enabled) return null;
      return {
        chips: WORLD_DESK_CATEGORIES.map((cat) => ({
          id: cat.id,
          label: cat.label,
          active: _categories.has(cat.id),
          title: `Toggle ${cat.label}`,
          params: { category: cat.id },
        })),
        legend: [{
          color: WORLD_NEWS_ACCENT,
          label: `${formatWorldDeskYear(_year)} · ${_count}`,
          count: _count,
          blurb: WORLD_NEWS_DISCLAIMER,
        }],
      };
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        source: _source,
        coverage: _geometry,
      };
    },
  };
  return layer;
}

const worldNewsLayer = createWorldNewsLayer();

export default worldNewsLayer;
