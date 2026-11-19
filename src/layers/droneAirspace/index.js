import { fromDegrees } from '../../geo/ellipsoid.js';
import { drawOf } from '../../render/rendererOf.js';
import { cssColor } from '../../render/color.js';
import { inputFor as defaultInputFor } from '../../input/dispatcher.js';
import { msg, t } from '../../i18n/index.js';
import {
  DRONE_AIRSPACE_OVERLAY_SOURCE_ID,
  droneAirspaceAnchorDegrees,
  buildDroneAirspaceCard,
  droneAirspaceAccent,
} from './cards.js';
export { normalizeDroneAirspaceSnapshot } from './records.js';
export { createDroneAirspaceSource } from './source.js';
export * from './cards.js';

/** Fill/line colour for a zone by TYPE_CODE, as a renderer colour `[r, g, b, a]`. */
export function droneAirspaceColor(typeCode) {
  return cssColor(droneAirspaceAccent(typeCode));
}

const withAlpha = ([r, g, b], alpha) => [r, g, b, alpha];
const ringDegrees = (ring) => ring.map(([lon, lat]) => ({ lon, lat }));

/**
 * The draw sets the zones are drawn in start with this; each layer has its
 * own (`drone-airspace:1:fills`, …), so several can share a renderer. Picks
 * name them as `Hit.set`.
 */
export const DRONE_AIRSPACE_SET_PREFIX = 'drone-airspace';
let instances = 0;

/**
 * FNV-1a over a zone's rings: a short, deterministic fingerprint so a
 * boundary change with unchanged attributes still alters the refresh signature.
 */
function geometryHash(polygons) {
  const text = JSON.stringify(polygons);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

const PICK_PREFIX = 'drone-airspace:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});

/**
 * Own one drone-restriction display, its refresh lifecycle, and click selection.
 *
 * Each zone polygon is a ground-clamped fill in one renderer draw set and
 * its boundary a draped line in another (`drawOf(viewer)`), made at `init`.
 * Given a Cesium viewer with no renderer bound, the
 * caller loads the package's `./render/cesium/unbound` export first.
 */
export function createDroneAirspaceLayer({
  source,
  overlayHost = null,
  inputFor = defaultInputFor,
  picking = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Drone airspace requires a snapshot source');
  let _viewer = null;
  let _request = null;
  let _snapshotSignature = null;
  let _fills = null;
  let _lines = null;
  let _setIds = new Set();
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  let _enabled = false;
  let _clickSubscription = null;
  let _selectedId = null;
  let _selectedCardId = null;
  /** @type {Map<string, {stableId: string, anchor: {lon: number, lat: number}}>} */
  const _rowById = new Map();

  const canSelect = () => overlayHost && inputFor && picking;

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _rowById.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      _selectedCardId = null;
      overlayHost.setEntries(
        DRONE_AIRSPACE_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = {
      ...buildDroneAirspaceCard(row),
      position: fromDegrees(row.anchor.lon, row.anchor.lat),
    };
    _selectedCardId = card.id;
    overlayHost.setEntries(
      DRONE_AIRSPACE_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  /**
   * The zone a click's draw hit (`Hit`, query.d.ts) belongs to: an item of
   * this layer's own sets, for a zone drawn now; else null.
   */
  function pickedZoneId(hit) {
    if (!hit || hit.surface || !_setIds.has(hit.set)) return null;
    if (typeof hit.id !== 'string' || !hit.id.startsWith(PICK_PREFIX))
      return null;
    const zoneId = hit.id.slice(PICK_PREFIX.length).split(':')[0];
    return _rowById.has(zoneId) ? zoneId : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickSubscription || !_viewer) return;
    // Deliberately NOT registered in the pick-ownership registry: sibling
    // layers yield to owned picks before their own overlay-card hit-tests,
    // so claiming these large ground polygons would make FIRMS/vessel/CCTV
    // cards inert anywhere over a zone. Unowned, our picks read as
    // "empty space" to siblings — the same contract as fire perimeters.
    _clickSubscription = inputFor(_viewer).onClick((event) => {
      // The card or label painted on top takes the click, read once per
      // click so every layer agrees: this area's shapes are background to
      // another layer's card or label painted over them, and a click on our
      // own card leaves the selection as it is.
      if (picking.clickCard?.(event)) return;
      const picked = event.topHit;
      const zoneId = picked ? pickedZoneId(event.drawHit) : null;
      if (zoneId) {
        _selectedId = zoneId;
        publishSelectedCard();
        return;
      }
      if (picked) {
        const pickId = picking.resolvePickId(picked);
        if (pickId && picking.isOwnedByOtherLayer(layer.id, pickId)) return;
      }
      if (_selectedId) {
        _selectedId = null;
        publishSelectedCard();
      }
    });
  }

  function removeClickHandler() {
    _clickSubscription?.();
    _clickSubscription = null;
  }

  function clearSelection() {
    _selectedId = null;
    _selectedCardId = null;
    if (overlayHost) {
      overlayHost.clearSource(DRONE_AIRSPACE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible?.(DRONE_AIRSPACE_OVERLAY_SOURCE_ID, false);
    }
  }

  const layer = {
    id: 'drone-airspace',
    name: 'Prohibited & Restricted Airspace',
    icon: '🚫',
    source: 'FAA SUA',
    updateInterval: 3600000,

    init(viewer) {
      if (_viewer)
        throw new Error('Drone airspace layer is already initialized');
      const draw = drawOf(viewer);
      const prefix = `${DRONE_AIRSPACE_SET_PREFIX}:${++instances}`;
      _fills = draw.shapes({
        id: `${prefix}:fills`,
        clampTo: 'both',
        show: false,
      });
      _lines = draw.lines({
        id: `${prefix}:lines`,
        clampTo: 'both',
        show: false,
      });
      _setIds = new Set([_fills.id, _lines.id]);
      _viewer = viewer;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
      _enabled = false;
      console.log('[Data:DroneAirspace] Initialized');
    },

    enable() {
      _enabled = true;
      if (_fills) _fills.show = _lines.show = true;
      overlayHost?.setVisible?.(DRONE_AIRSPACE_OVERLAY_SOURCE_ID, true);
      installClickHandler();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_fills) _fills.show = _lines.show = false;
      removeClickHandler();
      clearSelection();
    },

    async update() {
      if (!_enabled || !_fills) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        // The source contract is getSnapshot; a source that can also say how
        // fresh its rows are (the FAA proxy) offers getSnapshotDetail.
        const snapshot =
          typeof source.getSnapshotDetail === 'function'
            ? await source.getSnapshotDetail({ signal: request.signal })
            : { rows: await source.getSnapshot({ signal: request.signal }) };
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        const { rows } = snapshot;
        _stale = snapshot.stale === true;
        // A stale snapshot is as old as its fetch, not this poll.
        const updatedAt =
          _stale && Number.isFinite(snapshot.fetchedAt)
            ? snapshot.fetchedAt
            : Date.now();

        // FAA amends boundaries in its 8-week cycle without any attribute
        // changing, so the geometry is part of the signature.
        const signature = JSON.stringify(
          rows
            .map(({ polygons, ...facts }) => ({
              ...facts,
              geometry: geometryHash(polygons),
            }))
            .sort((a, b) => a.stableId.localeCompare(b.stableId)),
        );
        if (signature === _snapshotSignature) {
          if (_selectedId) publishSelectedCard();
          _lastUpdate = updatedAt;
          _lastError = null;
          return true;
        }
        const nextFills = [];
        const nextLines = [];
        _rowById.clear();
        for (const row of rows) {
          const color = droneAirspaceColor(row.typeCode);
          for (const [index, rings] of row.polygons.entries()) {
            const id = `${PICK_PREFIX}${row.stableId}:${index}`;
            // Each exterior keeps its own holes.
            nextFills.push({
              id,
              geometry: { kind: 'polygon', rings: rings.map(ringDegrees) },
              fill: withAlpha(color, 0.25),
              height: 'clampGround',
            });
            // The boundary: the exterior ring draped on the ground (lines
            // take ECEF, draw.d.ts `LineItem`).
            nextLines.push({
              id,
              positions: rings[0].map(([lon, lat]) => fromDegrees(lon, lat)),
              widthPx: 2,
              mode: 'draped',
              style: { kind: 'solid', color: withAlpha(color, 0.9) },
            });
          }
          const { polygons, ...facts } = row;
          _rowById.set(row.stableId, {
            ...facts,
            anchor: droneAirspaceAnchorDegrees(polygons),
          });
        }

        _fills.set(nextFills);
        _lines.set(nextLines);
        _snapshotSignature = signature;
        if (_selectedId) publishSelectedCard();
        _count = rows.length;
        _lastUpdate = updatedAt;
        _lastError = null;
        console.log(
          `[Data:DroneAirspace] Updated: ${_count} zones, ${nextFills.length} polygons`,
        );
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:DroneAirspace] Fetch error:', e);
        _lastError =
          e?.message || msg('Restricted airspace source unavailable');
        // A failure now outranks the stale snapshot still drawn.
        _stale = false;
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy() {
      _request?.abort();
      _request = null;
      removeClickHandler();
      clearSelection();
      _rowById.clear();
      _snapshotSignature = null;
      _viewer = null;
      _enabled = false;
      _fills?.dispose();
      _lines?.dispose();
      _fills = _lines = null;
      _setIds = new Set();
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
    },

    getAnalystRecords(maxCount = 2000) {
      if (!_fills || !_fills.show) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const result = [];
      for (const row of _rowById.values()) {
        if (result.length >= limit) break;
        const { anchor, stableId, ...facts } = row;
        result.push({
          id: stableId,
          ...facts,
          lat: anchor.lat,
          lon: anchor.lon,
        });
      }
      return result;
    },

    getRowControls() {
      const bands = [
        { label: t('Prohibited (P)'), color: droneAirspaceAccent('P') },
        { label: t('Restricted (R)'), color: droneAirspaceAccent('R') },
      ];
      return {
        chips: [],
        legend: bands.map((band, index) => ({
          ...band,
          count: [..._rowById.values()].filter(
            (row) => droneAirspaceAccent(row.typeCode) === band.color,
          ).length,
          ...(index === 0
            ? {
                blurb: t(
                  'FAA prohibited and restricted special-use airspace only, not the UAS Facility Map or UAS flight restrictions. Informational only — not a substitute for official UAS flight-planning tools (B4UFLY / LAANC).',
                ),
              }
            : {}),
        })),
      };
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
      };
    },
  };
  return layer;
}
