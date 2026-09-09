/**
 * WarScope — global conflict events (GDELT-backed, proxied same-origin).
 * Data: https://warscope.net/api-docs
 *
 * Zoomed out: colored event dots.
 * Zoomed in: collapsible text cards with title + outbound source link
 * (no article-preview scrape or image proxy).
 */

import * as Cesium from 'cesium';
import {
  clearOverlaySource,
  hitTestWorldOverlay,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import { governorRequestRender } from '../renderGovernor.js';
import {
  WARSCOPE_OVERLAY_COLLISION_CAPACITY,
  WARSCOPE_OVERLAY_COHORT_LIMIT,
  WARSCOPE_OVERLAY_SOURCE_ID,
  createWarscopeOverlayEntry,
  eventAccentColor,
  selectWarscopeOverlayCohort,
} from './warscopeCards.js';

const API_URL = '/api/warscope/events';
const UPDATE_MS = 600000;

const EVENT_COLORS = Object.freeze({
  battles: '#ff3344',
  'explosions/remote violence': '#ff7722',
  protests: '#ffcc33',
  riots: '#ff9933',
  'strategic developments': '#66aaff',
});

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
  hitTest: hitTestWorldOverlay,
});

function eventColor(eventType) {
  return Cesium.Color.fromCssColorString(eventAccentColor(eventType));
}

function normalizeEvent(raw) {
  const lat = Number(raw?.latitude);
  const lon = Number(raw?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  const fatalities = Number(raw?.fatalities);
  const quality = Number(raw?.quality?.overall);
  return {
    id: String(raw?.id || ''),
    title: String(raw?.title || raw?.event_type || 'Conflict event').trim(),
    eventType: String(raw?.event_type || '').trim(),
    subEventType: String(raw?.sub_event_type || '').trim(),
    country: String(raw?.country || '').trim(),
    region: String(raw?.region || '').trim(),
    date: String(raw?.event_date || raw?.date || '').trim(),
    notes: String(raw?.notes || '').trim(),
    source: String(raw?.source || 'WarScope').trim(),
    sourceUrl: String(raw?.source_url || '').trim(),
    lat,
    lon,
    fatalities: Number.isFinite(fatalities) ? fatalities : 0,
    quality: Number.isFinite(quality) ? quality : 0,
  };
}

export function createWarscopeEventsLayer({
  overlayHost = DEFAULT_OVERLAY_HOST,
  screenSpaceEventHandlerFactory = (viewer) => (
    new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
  ),
} = {}) {
  let _viewer = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  let _enabled = false;
  let _theater = 'global';
  /** @type {Map<string, object>} */
  let _eventsById = new Map();
  /** @type {Map<string, Cesium.Cartesian3>} */
  let _positionsById = new Map();
  /** @type {Set<string>} */
  let _expandedIds = new Set();
  let _clickHandler = null;

  function syncOverlayEntries() {
    if (!_enabled) return;
    const entries = [];
    for (const [id, event] of _eventsById) {
      const position = _positionsById.get(id);
      if (!position) continue;
      const entry = createWarscopeOverlayEntry({
        event,
        position,
        expanded: _expandedIds.has(id),
      });
      if (entry) entries.push(entry);
    }
    overlayHost.setEntries(
      WARSCOPE_OVERLAY_SOURCE_ID,
      selectWarscopeOverlayCohort(entries, _expandedIds),
      {
        cohortLimit: WARSCOPE_OVERLAY_COHORT_LIMIT,
        collisionCapacity: WARSCOPE_OVERLAY_COLLISION_CAPACITY,
        moving: false,
      },
    );
  }

  function toggleExpanded(eventId) {
    if (!eventId || !_eventsById.has(eventId)) return false;
    if (_expandedIds.has(eventId)) _expandedIds.delete(eventId);
    else _expandedIds.add(eventId);
    syncOverlayEntries();
    if (_enabled) governorRequestRender('warscope-expand');
    return true;
  }

  function installClickHandler() {
    if (_clickHandler || !_viewer) return;
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      const hit = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
        { sourceId: WARSCOPE_OVERLAY_SOURCE_ID },
      );
      if (!hit?.entryId) return;
      toggleExpanded(hit.entryId);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
  }

  const layer = {
    id: 'warscope-events',
    name: 'Global Conflict Events',
    icon: '⚔️',
    source: 'WarScope / GDELT',
    updateInterval: UPDATE_MS,

    init(viewer) {
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('warscope-events');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
      _enabled = false;
      _theater = 'global';
      _eventsById = new Map();
      _positionsById = new Map();
      _expandedIds = new Set();
      overlayHost.setVisible(WARSCOPE_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(WARSCOPE_OVERLAY_SOURCE_ID, true);
      syncOverlayEntries();
      installClickHandler();
    },

    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(WARSCOPE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(WARSCOPE_OVERLAY_SOURCE_ID, false);
      removeClickHandler();
    },

    async update() {
      if (!_dataSource) return false;
      try {
        const response = await fetch(API_URL, { cache: 'no-store' });
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload) {
          _lastError = payload?.error || `WarScope HTTP ${response.status}`;
          return false;
        }
        _stale = Boolean(payload.stale);
        _theater = String(payload.theater || 'global');
        const events = Array.isArray(payload.events) ? payload.events : [];

        _dataSource.entities.removeAll();
        _eventsById = new Map();
        _positionsById = new Map();
        const liveIds = new Set();
        let rendered = 0;

        for (const raw of events) {
          const event = normalizeEvent(raw);
          if (!event || !event.id) continue;

          liveIds.add(event.id);
          _eventsById.set(event.id, event);
          const position = Cesium.Cartesian3.fromDegrees(event.lon, event.lat);
          _positionsById.set(event.id, position);

          const color = eventColor(event.eventType);
          const magScale = Math.min(14, 6 + Math.sqrt(Math.max(0, event.fatalities)) * 2);

          _dataSource.entities.add({
            id: `warscope:${event.id}`,
            position,
            point: {
              pixelSize: magScale,
              color: color.withAlpha(0.88),
              outlineColor: Cesium.Color.BLACK.withAlpha(0.45),
              outlineWidth: 1,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            properties: {
              title: event.title,
              eventType: event.eventType,
              subEventType: event.subEventType,
              country: event.country,
              region: event.region,
              date: event.date,
              notes: event.notes,
              source: event.source,
              sourceUrl: event.sourceUrl,
              fatalities: event.fatalities,
            },
          });
          rendered += 1;
        }

        for (const id of [..._expandedIds]) {
          if (!liveIds.has(id)) _expandedIds.delete(id);
        }

        _count = rendered;
        _lastUpdate = Number(payload.fetchedAt) || Date.now();
        _lastError = null;
        syncOverlayEntries();
        if (_enabled) governorRequestRender('warscope-events-update');
        return true;
      } catch (error) {
        _lastError = 'WarScope network error';
        console.warn('[Data:WarScope]', error);
        return false;
      }
    },

    destroy(viewer) {
      _enabled = false;
      removeClickHandler();
      overlayHost.clearSource(WARSCOPE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(WARSCOPE_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
      _theater = 'global';
      _eventsById = new Map();
      _positionsById = new Map();
      _expandedIds = new Set();
    },

    getRowControls() {
      return {
        legend: [
          { color: EVENT_COLORS.battles, label: 'Battles' },
          { color: EVENT_COLORS['explosions/remote violence'], label: 'Explosions / remote violence' },
          { color: EVENT_COLORS.protests, label: 'Protests' },
          { color: '#c8d0dc', label: 'Other reported events' },
          { color: '#9eb6d4', label: 'Zoom in for cards · click to expand' },
        ],
      };
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
        loadingLabel: _theater !== 'global' ? _theater : '7d global',
      };
    },
  };

  return layer;
}

const warscopeEventsLayer = createWarscopeEventsLayer();

export default warscopeEventsLayer;
