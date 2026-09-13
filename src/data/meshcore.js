/**
 * @module meshcore
 * @description MeshCore public node-map overlay — the same open data that
 * powers map.meshcore.io and community deployments like cascadiamesh.org/map.
 *
 * MeshCore is a LoRa mesh radio protocol used by hobbyist and community
 * networks (Cascadia's spans BC/WA/OR, but the public feed is worldwide).
 * Each node is a Client, Repeater, Room Server, or Sensor that has
 * self-reported its position to the public map. Renders every node as a
 * color-coded point primitive — color tracks how recently the node was last
 * heard from (the same freshness convention the official map uses), and
 * click-to-inspect surfaces its type, radio parameters, and public key.
 *
 * Fetched once via the /api/meshcore/nodes proxy (server-side cache, single
 * upstream fetch shared by every client) and refreshed on updateInterval.
 * Points render at a small fixed height above the ellipsoid rather than
 * terrain-sampled — at tens of thousands of nodes, per-point sampleHeight()
 * calls would stall the main thread for seconds; the same trade-off
 * satellites.js and other bulk-point layers make.
 */

import * as Cesium from 'cesium';
import { registerPickOwner, unregisterPickOwner } from './pickRegistry.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import { MESHCORE_NODE_TYPE_LABELS } from './meshcoreNodes.js';

export { MESHCORE_NODE_TYPE_LABELS };

export const MESHCORE_SELECTED_OVERLAY_SOURCE_ID = 'meshcore-selected';
export const MESHCORE_SELECTED_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  moving: false,
});

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});
let _overlayHost = DEFAULT_OVERLAY_HOST;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Polling interval — matches the server proxy's own cache TTL. */
const UPDATE_INTERVAL_MS = 10 * 60_000;
/** Vertical offset (m) above the ellipsoid — see module doc re: no terrain sampling. */
const POINT_HEIGHT_OFFSET_M = 15;
/** Hard cap on rendered points, as a safety valve against upstream growth. */
const MAX_TOTAL_POINTS = 70_000;

/** Pixel size by node type — infrastructure (repeaters/room servers) reads slightly larger. */
const SIZE_BY_TYPE = Object.freeze({ 1: 4, 2: 6, 3: 6, 4: 4 });
const SIZE_DEFAULT = 4;

/** Freshness palette. Extinct/none use dark, desaturated tones — a true black
 * dot would vanish against the globe's night side. */
const COLOR_RECENT = Cesium.Color.fromCssColorString('#00ff88').withAlpha(0.95);
const COLOR_STALE = Cesium.Color.fromCssColorString('#ffaa00').withAlpha(0.92);
const COLOR_OLD = Cesium.Color.fromCssColorString('#ff5544').withAlpha(0.88);
const COLOR_EXTINCT =
  Cesium.Color.fromCssColorString('#5b5568').withAlpha(0.55);
const COLOR_NONE = Cesium.Color.fromCssColorString('#91a4b4').withAlpha(0.6);
const COLOR_OUTLINE = Cesium.Color.BLACK.withAlpha(0.25);

const STATUS_LABELS = Object.freeze({
  recent: 'Recent (<5d)',
  stale: 'Stale (5-10d)',
  old: 'Old (10-20d)',
  extinct: 'Extinct (>20d)',
  none: 'Manually added',
});

/**
 * Determine a node's freshness bucket using the same convention as the
 * official MeshCore map: only `source: "uploader"` records (automated
 * repeater/room-server adverts) get a freshness color at all — records
 * added manually through the app (`source: "app"`) are timeless ("none").
 * @param {{source?: string, updatedAt?: number|null}} node
 * @param {number} [now=Date.now()]
 * @returns {'recent'|'stale'|'old'|'extinct'|'none'}
 */
export function getNodeUpdateStatus(node, now = Date.now()) {
  if (String(node?.source || '')[0] !== 'u') return 'none';
  if (!Number.isFinite(node?.updatedAt)) return 'none';
  if (node.updatedAt < now - 20 * DAY_MS) return 'extinct';
  if (node.updatedAt < now - 10 * DAY_MS) return 'old';
  if (node.updatedAt < now - 5 * DAY_MS) return 'stale';
  return 'recent';
}

/** @param {string} status @returns {Cesium.Color} */
export function statusToColor(status) {
  switch (status) {
    case 'recent':
      return COLOR_RECENT;
    case 'stale':
      return COLOR_STALE;
    case 'old':
      return COLOR_OLD;
    case 'extinct':
      return COLOR_EXTINCT;
    default:
      return COLOR_NONE;
  }
}

/** @param {number} type @returns {number} pixel size */
export function typeToPixelSize(type) {
  return SIZE_BY_TYPE[type] || SIZE_DEFAULT;
}

/**
 * Build the multi-line source text for a selected node's overlay card.
 * @param {object} record - Render record (raw node fields + computed status).
 * @returns {string} Newline-delimited card text.
 */
export function buildMeshcoreSelectionLabel(record) {
  const label =
    record?.name ||
    `${MESHCORE_NODE_TYPE_LABELS[record?.type] || 'Node'} ${String(record?.id || '').slice(0, 8)}`;
  const typeLabel = MESHCORE_NODE_TYPE_LABELS[record?.type] || 'Unknown';
  const statusLabel = STATUS_LABELS[record?.status] || STATUS_LABELS.none;

  const lines = [label, `📡 ${typeLabel} · ${statusLabel}`];

  const radio = [];
  if (Number.isFinite(record?.freq)) radio.push(`${record.freq} MHz`);
  if (Number.isFinite(record?.bandwidth))
    radio.push(`${record.bandwidth} kHz BW`);
  if (Number.isFinite(record?.spreadingFactor))
    radio.push(`SF${record.spreadingFactor}`);
  if (Number.isFinite(record?.codingRate)) radio.push(`CR${record.codingRate}`);
  if (radio.length) lines.push(radio.join(' · '));

  if (record?.updatedAt) {
    lines.push(`Last seen ${new Date(record.updatedAt).toLocaleString()}`);
  }
  if (record?.id) {
    lines.push(`Key ${String(record.id).slice(0, 16)}…`);
  }

  return lines.join('\n');
}

/**
 * Build the protected selected-node overlay entry from a source-owned record.
 * @param {string} key - Node public key (used as the render/pick id).
 * @param {object} record - Render record with a live `point.position`.
 * @returns {Object|null}
 */
export function createMeshcoreSelectedOverlayEntry(key, record) {
  const position = record?.point?.position;
  if (!key || !position) return null;
  const [title, ...details] = buildMeshcoreSelectionLabel(record).split('\n');
  return {
    id: String(key),
    position,
    variant: 'selected',
    selected: true,
    protected: true,
    paintLane: 'selected',
    collisionGroup: 'ambient-card',
    priority: Number.MAX_SAFE_INTEGER,
    title,
    details,
    accent: '#00ffff',
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

// ---------------------------------------------------------------------------
// Module-level mutable state
// ---------------------------------------------------------------------------

/** @type {Cesium.Viewer|null} */
let _viewer = null;
/** @type {Cesium.PointPrimitiveCollection|null} */
let _pointCollection = null;
let _enabled = false;
/** @type {Map<string, Object>} public_key -> render record */
let _nodesById = new Map();
let _count = 0;
let _lastUpdate = null;
let _loading = false;
let _error = null;
let _limitWarned = false;
/** @type {AbortController|null} */
let _inFlightController = null;

/** @type {Cesium.ScreenSpaceEventHandler|null} */
let _clickHandler = null;
let _selectedKey = null;
/** @type {Cesium.Entity|null} */
let _selectedEntity = null;

function toProxyUrl() {
  return '/api/meshcore/nodes';
}

/**
 * Fetch the current node set from the local proxy.
 * @param {AbortSignal} [signal]
 * @returns {Promise<{fetchedAt: number, stale: boolean, count: number, nodes: Object[]}>}
 */
async function fetchMeshcoreNodes({ signal } = {}) {
  const response = await fetch(toProxyUrl(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) throw new Error(`MeshCore HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.nodes)) {
    throw new Error('Malformed MeshCore payload');
  }
  return payload;
}

/** Build a ground-adjacent Cartesian3 for a node (no terrain sampling; see module doc). */
function createNodePosition(node) {
  const lon = Number(node?.lon);
  const lat = Number(node?.lat);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return Cesium.Cartesian3.fromDegrees(lon, lat, POINT_HEIGHT_OFFSET_M);
}

/** Add or update the point primitive + render record for one node. */
function upsertNodePoint(node, now) {
  const status = getNodeUpdateStatus(node, now);
  const existing = _nodesById.get(node.id);

  if (existing) {
    existing.status = status;
    existing.name = node.name;
    existing.updatedAt = node.updatedAt;
    existing.source = node.source;
    existing.freq = node.freq;
    existing.bandwidth = node.bandwidth;
    existing.spreadingFactor = node.spreadingFactor;
    existing.codingRate = node.codingRate;
    existing.point.color = statusToColor(status);
    return;
  }

  if (_nodesById.size >= MAX_TOTAL_POINTS) {
    if (!_limitWarned) {
      _limitWarned = true;
      console.warn(`[Data:MeshCore] Point cap reached (${MAX_TOTAL_POINTS}).`);
    }
    return;
  }

  const position = createNodePosition(node);
  if (!position) return;

  const point = _pointCollection.add({
    position,
    pixelSize: typeToPixelSize(node.type),
    color: statusToColor(status),
    outlineColor: COLOR_OUTLINE,
    outlineWidth: 1,
    scaleByDistance: new Cesium.NearFarScalar(500, 1.3, 400000, 0.45),
    translucencyByDistance: new Cesium.NearFarScalar(500, 1.0, 600000, 0.2),
    disableDepthTestDistance: 2500,
    id: node.id,
  });

  _nodesById.set(node.id, {
    key: node.id,
    id: node.id,
    type: node.type,
    name: node.name,
    status,
    updatedAt: node.updatedAt,
    source: node.source,
    freq: node.freq,
    bandwidth: node.bandwidth,
    spreadingFactor: node.spreadingFactor,
    codingRate: node.codingRate,
    point,
  });
}

/** Remove a rendered node that no longer appears upstream. */
function removeNode(key) {
  const record = _nodesById.get(key);
  if (!record) return;
  if (key === _selectedKey) _clearSelection();
  _pointCollection.remove(record.point);
  _nodesById.delete(key);
}

/**
 * Reconcile the rendered set against a freshly fetched node array: update
 * existing points in place, add new ones, and drop any that vanished
 * upstream (e.g. purged after prolonged inactivity).
 */
function reconcileNodes(nodes) {
  const now = Date.now();
  const seen = new Set();
  for (const node of nodes) {
    seen.add(node.id);
    upsertNodePoint(node, now);
  }
  for (const key of Array.from(_nodesById.keys())) {
    if (!seen.has(key)) removeNode(key);
  }
  _count = _nodesById.size;
}

/** Clear the current node selection: re-show its base point, drop the highlight entity. */
function _clearSelection() {
  if (_selectedKey) {
    const record = _nodesById.get(_selectedKey);
    if (record?.point) record.point.show = true;
  }
  if (_selectedEntity && _viewer) {
    _viewer.entities.remove(_selectedEntity);
  }
  _selectedKey = null;
  _selectedEntity = null;
  _overlayHost.clearSource(MESHCORE_SELECTED_OVERLAY_SOURCE_ID);
}

/**
 * Select a node by key: hides its base point primitive and replaces it with
 * a highlighted cyan entity plus a protected overlay detail card — same
 * pattern as bikeshare's station selection.
 */
function _selectNode(key) {
  _clearSelection();
  const record = _nodesById.get(key);
  if (!record?.point?.position || !_viewer) return;

  _selectedKey = key;
  record.point.show = false;

  _selectedEntity = _viewer.entities.add({
    position: record.point.position,
    point: {
      pixelSize: 14,
      color: Cesium.Color.CYAN,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });

  const entry = createMeshcoreSelectedOverlayEntry(key, record);
  if (entry) {
    _overlayHost.setEntries(
      MESHCORE_SELECTED_OVERLAY_SOURCE_ID,
      [entry],
      MESHCORE_SELECTED_OVERLAY_SOURCE_OPTIONS,
    );
  }
}

function _installClickHandler(viewer) {
  if (_clickHandler) return;
  _clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  _clickHandler.setInputAction((click) => {
    const picked = viewer.scene.pick(click.position);
    if (picked) {
      const primitive = picked.primitive;
      if (
        primitive &&
        typeof primitive.id === 'string' &&
        _nodesById.has(primitive.id)
      ) {
        _selectNode(primitive.id);
        return;
      }
      if (typeof picked.id === 'string' && _nodesById.has(picked.id)) {
        _selectNode(picked.id);
        return;
      }
    }
    if (_selectedKey) _clearSelection();
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  document.addEventListener('keydown', _onKeyDown);
}

function _onKeyDown(e) {
  if (e.key === 'Escape' && _selectedKey) _clearSelection();
}

/** Compute a status-tally legend for the toggle-panel row. */
function buildLegend() {
  const tally = { recent: 0, stale: 0, old: 0, extinct: 0, none: 0 };
  for (const record of _nodesById.values()) {
    tally[record.status] = (tally[record.status] || 0) + 1;
  }
  return [
    {
      color: '#00ff88',
      label: 'Recent',
      count: tally.recent,
      blurb: 'Heard from in the last 5 days',
    },
    {
      color: '#ffaa00',
      label: 'Stale',
      count: tally.stale,
      blurb: 'Last heard 5-10 days ago',
    },
    {
      color: '#ff5544',
      label: 'Old',
      count: tally.old,
      blurb: 'Last heard 10-20 days ago',
    },
    {
      color: '#5b5568',
      label: 'Extinct',
      count: tally.extinct,
      blurb: 'Not heard from in over 20 days',
    },
    {
      color: '#91a4b4',
      label: 'Manual',
      count: tally.none,
      blurb: 'Manually added, no freshness tracking',
    },
  ].filter((item) => item.count > 0);
}

async function refresh() {
  _inFlightController?.abort();
  const controller = new AbortController();
  _inFlightController = controller;
  _loading = true;
  try {
    const payload = await fetchMeshcoreNodes({ signal: controller.signal });
    if (controller.signal.aborted) return;
    reconcileNodes(payload.nodes);
    _lastUpdate = Date.now();
    _error = payload.stale
      ? 'Upstream unavailable — showing cached nodes'
      : null;
  } catch (error) {
    if (error?.name === 'AbortError') return;
    console.warn('[Data:MeshCore] refresh error:', error);
    _error = 'MeshCore fetch error';
  } finally {
    if (_inFlightController === controller) _inFlightController = null;
    _loading = false;
  }
}

/**
 * MeshCore data layer object, conforming to the God's Eye View layer interface.
 * @type {Object}
 */
const meshcoreLayer = {
  id: 'meshcore',
  name: 'Mesh Network',
  icon: '📡',
  source: 'MeshCore',
  updateInterval: UPDATE_INTERVAL_MS,

  init(viewer) {
    _viewer = viewer;
    _pointCollection = new Cesium.PointPrimitiveCollection({
      blendOption: Cesium.BlendOption.TRANSLUCENT,
    });
    viewer.scene.primitives.add(_pointCollection);
    _pointCollection.show = false;

    _enabled = false;
    _nodesById = new Map();
    _count = 0;
    _lastUpdate = null;
    _loading = false;
    _error = null;
    _limitWarned = false;
    _clickHandler = null;
    _selectedKey = null;
    _selectedEntity = null;

    _overlayHost.setVisible(MESHCORE_SELECTED_OVERLAY_SOURCE_ID, false);
    _installClickHandler(viewer);

    console.log('[Data:MeshCore] Initialized');
  },

  enable(viewer) {
    _enabled = true;
    _error = null;
    _pointCollection.show = true;
    _overlayHost.setVisible(MESHCORE_SELECTED_OVERLAY_SOURCE_ID, true);
    _installClickHandler(viewer);
    registerPickOwner('meshcore', (pickedId) => _nodesById.has(pickedId));
    void refresh();
  },

  disable() {
    _enabled = false;
    _clearSelection();
    _overlayHost.setVisible(MESHCORE_SELECTED_OVERLAY_SOURCE_ID, false);
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
    document.removeEventListener('keydown', _onKeyDown);
    unregisterPickOwner('meshcore');
    _inFlightController?.abort();
    _inFlightController = null;
    _pointCollection.show = false;
    _loading = false;
  },

  async update() {
    if (!_enabled) return;
    await refresh();
  },

  getStats() {
    const stats = { count: _count, lastUpdate: _lastUpdate, loading: _loading };
    if (_loading && _count === 0)
      stats.loadingLabel = 'loading MeshCore nodes...';
    if (_error) stats.error = _error;
    return stats;
  },

  getRowControls() {
    return { chips: [], legend: buildLegend() };
  },

  destroy(viewer) {
    if (_enabled) this.disable(viewer);
    else {
      _clearSelection();
      _overlayHost.setVisible(MESHCORE_SELECTED_OVERLAY_SOURCE_ID, false);
      if (_clickHandler) {
        _clickHandler.destroy();
        _clickHandler = null;
      }
      document.removeEventListener('keydown', _onKeyDown);
      unregisterPickOwner('meshcore');
    }
    _inFlightController?.abort();
    _inFlightController = null;
    if (_pointCollection) {
      viewer.scene.primitives.remove(_pointCollection);
      _pointCollection = null;
    }
    _nodesById = new Map();
    _viewer = null;
  },
};

/** Seed a selected-node runtime record for focused overlay tests. */
export function _setMeshcoreSelectionStateForTest({
  viewer,
  key,
  record,
  overlayHost,
}) {
  _viewer = viewer;
  _nodesById = new Map([[key, record]]);
  _selectedKey = null;
  _selectedEntity = null;
  _overlayHost = overlayHost || DEFAULT_OVERLAY_HOST;
}

/** Exercise the production selection path in focused runtime tests. */
export function _selectMeshcoreNodeForTest(key) {
  _selectNode(key);
}

/** Exercise the production clear path and restore the production host seam. */
export function _clearMeshcoreSelectionForTest() {
  _clearSelection();
  _overlayHost = DEFAULT_OVERLAY_HOST;
}

export default meshcoreLayer;
