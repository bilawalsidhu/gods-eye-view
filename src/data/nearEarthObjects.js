import * as Cesium from 'cesium';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';

/**
 * NASA NeoWs near-Earth asteroids — close approaches within a rolling 7-day
 * window.
 *
 * Entities are static points on a high equatorial display ring (no per-frame
 * animators, no CallbackProperty — the earthquakes static-axes lesson
 * applies). Hazardous approaches read amber and larger. Data flows through
 * the key-gated same-origin /api/neo proxy (NEO_API_KEY stays server-side;
 * keyless installs get a KEY REQUIRED chip, never a silent empty layer).
 */

const API_URL = '/api/neo';

export const NEO_OVERLAY_SOURCE_ID = 'near-earth-objects';
export const NEO_OVERLAY_COHORT_LIMIT = 40;
export const NEO_OVERLAY_COLLISION_CAPACITY = 20;

/** Altitude of the display ring: high enough to read as space, on-screen at globe scale. */
const NEO_RING_ALTITUDE_M = 20_000_000;
const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

/** Marker + accent color for one approach: hazardous reads amber. */
function neoAccent(hazardous) {
  return hazardous ? '#ffb347' : '#7ec8ff';
}

/** Cesium color from a css hex string (kept off the hot path). */
function cesiumColor(hex, alpha) {
  return Cesium.Color.fromCssColorString(hex).withAlpha(alpha);
}

/** Title for one overlay label: name + distance in lunar distances. */
export function neoLabel(row) {
  const lunar = Number.isFinite(row?.missLunar) ? row.missLunar.toFixed(1) : '—';
  const haz = row?.hazardous ? ' ☢' : '';
  return `${row?.name ?? 'Asteroid'} · ${lunar} LD${haz}`;
}

/** Overlay label entry (ambient label variant, the earthquake pattern). */
export function createNeoOverlayEntry({ row, position }) {
  return {
    id: String(row.id),
    position,
    variant: 'label',
    title: neoLabel(row),
    accent: neoAccent(row.hazardous),
    priority: Math.round(Math.max(0, 2 - (row.missLunar ?? 2)) * 1000),
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

/** Largest cohort first: closest approaches win, stable id tie-break. */
export function selectNeoOverlayCohort(entries, limit = NEO_OVERLAY_COHORT_LIMIT) {
  const cap = Math.max(0, Math.min(NEO_OVERLAY_COHORT_LIMIT, Math.floor(Number(limit) || 0)));
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries.slice().sort((a, b) => (
    b.priority - a.priority || String(a.id).localeCompare(String(b.id))
  )).slice(0, cap);
}

/** JSON-safe analyst record for one row (analyst query engine seam). */
export function mapNeoAnalystRecord(row, index = 0) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  return {
    id: String(row?.id ?? `NEO-${String(index).padStart(4, '0')}`),
    name: typeof row?.name === 'string' ? row.name : null,
    sizeM: num(row?.sizeM),
    missKm: num(row?.missKm),
    missLunar: num(row?.missLunar),
    velocityKph: num(row?.velocityKph),
    approachMs: num(row?.approachMs),
    hazardous: row?.hazardous === true,
    absMag: num(row?.absMag),
    lat: null,
    lon: null,
  };
}

export function createNearEarthObjectsLayer({ overlayHost = DEFAULT_OVERLAY_HOST } = {}) {
  let _dataSource = null;
  let _rows = [];
  let _count = 0;
  let _hazardCount = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _keyRequired = false;
  let _stale = false;
  let _loading = false;
  let _enabled = false;

  const layer = {
    id: 'near-earth-objects',
    name: 'Near-Earth Asteroids (7d)',
    icon: '☄',
    source: 'NASA NeoWs',
    updateInterval: 0, // manual refresh only — the 2 h proxy TTL governs polling
    statsRefreshInterval: 1000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource('near-earth-objects');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _resetState();
      overlayHost.setVisible(NEO_OVERLAY_SOURCE_ID, false);
      console.log('[Data:NEO] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(NEO_OVERLAY_SOURCE_ID, true);
    },

    disable(viewer) {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(NEO_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(NEO_OVERLAY_SOURCE_ID, false);
    },

    async update(viewer) {
      if (!_dataSource) return false;
      _loading = true;
      try {
        const response = await fetch(API_URL, { cache: 'no-store' });
        if (!response.ok) {
          let payload = null;
          try {
            payload = await response.json();
          } catch { /* non-JSON error body — fall through to the generic error */ }
          if (response.status === 503 && payload?.error === 'no_key') {
            _keyRequired = true;
            _lastError = null;
            _stale = false;
            return false;
          }
          _keyRequired = false;
          _lastError = `NeoWs HTTP ${response.status}`;
          return false;
        }
        const payload = await response.json();
        // The proxy already normalized the feed (src/data/neoFeed.js on the
        // server side); rows arrive flat. Defensive shape check only.
        const proxied = Array.isArray(payload?.rows) ? payload.rows : null;
        if (!proxied) {
          _keyRequired = false;
          _lastError = 'Malformed NeoWs response';
          return false;
        }
        _keyRequired = false;
        _lastError = null;
        _stale = Boolean(payload?.stale);
        _rows = proxied;
        _count = _rows.length;
        _hazardCount = _rows.filter((r) => r.hazardous).length;
        _lastUpdate = Number.isFinite(payload?.fetchedAt) ? payload.fetchedAt : Date.now();

        const nextEntities = [];
        const overlayEntries = [];
        // Spread the approaches around a high equatorial ring: asteroids are
        // space objects, so they render at ~20,000 km altitude, not on the
        // ground. Bearing is keyed by a stable id hash so each refresh places
        // the same asteroid at the same longitude (no visible reshuffle).
        for (const row of _rows) {
          const lonDeg = (hashId(row.id) * 137.508) % 360 - 180;
          const position = Cesium.Cartesian3.fromDegrees(lonDeg, 0, NEO_RING_ALTITUDE_M);
          nextEntities.push(new Cesium.Entity({
            id: `neo:${row.id}`,
            position,
            point: {
              pixelSize: row.hazardous ? 12 : 8,
              color: cesiumColor(neoAccent(row.hazardous), 0.9),
              outlineColor: cesiumColor(neoAccent(row.hazardous), 0.5),
              outlineWidth: 1,
            },
            properties: {
              name: row.name,
              sizeM: row.sizeM,
              missKm: row.missKm,
              missLunar: row.missLunar,
              velocityKph: row.velocityKph,
              approachMs: row.approachMs,
              hazardous: row.hazardous,
              absMag: row.absMag,
            },
          }));
          overlayEntries.push(createNeoOverlayEntry({ row, position }));
        }
        _dataSource.entities.removeAll();
        for (const entity of nextEntities) _dataSource.entities.add(entity);
        if (_enabled) {
          overlayHost.setEntries(
            NEO_OVERLAY_SOURCE_ID,
            selectNeoOverlayCohort(overlayEntries),
            {
              cohortLimit: NEO_OVERLAY_COHORT_LIMIT,
              collisionCapacity: NEO_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }
        console.log(`[Data:NEO] Updated: ${_count} approaches (${_hazardCount} hazardous)`);
        return true;
      } catch (e) {
        console.warn('[Data:NEO] Fetch error:', e);
        _lastError = 'NeoWs network error';
        return false;
      } finally {
        _loading = false;
      }
    },

    destroy(viewer) {
      _enabled = false;
      overlayHost.clearSource(NEO_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(NEO_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _resetState();
    },

    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const limit = Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 2000;
      return _rows.slice(0, limit).map(mapNeoAnalystRecord);
    },

    getStats() {
      const now = Date.now();
      const staleText = _lastUpdate ? `STALE · cached ${formatAge(now - _lastUpdate) || '<1h'}` : 'STALE';
      let loadingLabel = '';
      if (_loading) {
        loadingLabel = _rows.length ? 'refreshing...' : 'loading...';
      } else if (_keyRequired) {
        loadingLabel = 'KEY REQUIRED';
      } else if (_stale) {
        loadingLabel = staleText;
      } else if (_lastError) {
        loadingLabel = _lastError;
      } else if (_lastUpdate) {
        loadingLabel = `LIVE · updated ${formatAgoMinutes(now - _lastUpdate)}`;
      }
      return {
        count: _count,
        hazardous: _hazardCount,
        lastUpdate: _lastUpdate,
        loading: _loading,
        stale: _stale,
        error: _keyRequired ? 'KEY REQUIRED' : (_stale ? staleText : _lastError),
        loadingLabel,
      };
    },
  };
  return layer;

  function _resetState() {
    _rows = [];
    _count = 0;
    _hazardCount = 0;
    _lastUpdate = null;
    _lastError = null;
    _keyRequired = false;
    _stale = false;
    _loading = false;
  }
}

/** Deterministic 32-bit hash of an id string (stable ecliptic bearing). */
function hashId(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function formatAge(ms) {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return '';
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatAgoMinutes(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

const nearEarthObjectsLayer = createNearEarthObjectsLayer();

export default nearEarthObjectsLayer;
