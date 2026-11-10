import { bindOverlayHost } from '../../overlays/bindOverlayHost.js';
import * as geo from '../../geo/index.js';
import { msg, t } from '../../i18n/index.js';
import { createDroneAirspaceDisplay } from './render/display.js';
import {
  DRONE_AIRSPACE_OVERLAY_SOURCE_ID,
  droneAirspaceAnchorDegrees,
  buildDroneAirspaceCard,
  droneAirspaceAccent,
} from './cards.js';
export { normalizeDroneAirspaceSnapshot } from './records.js';
export { createDroneAirspaceSource } from './source.js';
export * from './cards.js';

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

/** Own one drone-restriction display, its refresh lifecycle, and click selection. */
export function createDroneAirspaceLayer({
  source,
  overlayHost = null,
  picking = null,
  pointer = null,
  rendererFactory = ({ engine }) => createDroneAirspaceDisplay(engine),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Drone airspace requires a snapshot source');
  let initialized = false;
  let renderer = null;
  let sceneEngine = null;
  /** The rows drawn, kept for the next globe's renderer. */
  let _rows = [];
  let _request = null;
  let _snapshotSignature = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  let _enabled = false;
  let _clickHandler = null;
  let _selectedId = null;
  let _selectedCardId = null;
  /** @type {Map<string, {stableId: string, anchor: {lon: number, lat: number}}>} */
  const _rowById = new Map();

  overlayHost = bindOverlayHost(overlayHost, () => sceneEngine);
  const canSelect = () => overlayHost && picking;

  function publishSelectedCard() {
    if (!canSelect() || !renderer) return;
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
      position: geo.cartesian3.fromDegrees(row.anchor.lon, row.anchor.lat),
    };
    _selectedCardId = card.id;
    overlayHost.setEntries(
      DRONE_AIRSPACE_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  /** Resolve a scene pick to one of this layer's zone ids, or null. */
  function pickedZoneId(picked) {
    const pickId = picking.resolvePickId(picked);
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const zoneId = pickId.slice(PICK_PREFIX.length).split(':')[0];
    return _rowById.has(zoneId) ? zoneId : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !renderer) return;
    // Deliberately NOT registered in the pick-ownership registry: sibling
    // layers yield to owned picks before their own overlay-card hit-tests,
    // so claiming these large ground polygons would make FIRMS/vessel/CCTV
    // cards inert anywhere over a zone. Unowned, our picks read as
    // "empty space" to siblings — the same contract as fire perimeters.
    _clickHandler = renderer.onClick((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const cardHit = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
        { sourceId: DRONE_AIRSPACE_OVERLAY_SOURCE_ID },
      );
      if (cardHit && cardHit.entryId === _selectedCardId) return;
      const picked = click?.picked ?? null;
      const zoneId = picked ? pickedZoneId(picked) : null;
      if (zoneId) {
        _selectedId = zoneId;
        publishSelectedCard();
        return;
      }
      if (picked) {
        const pickId = picking.resolvePickId(picked);
        if (
          pickId &&
          picking.isOwnedByOtherLayer(layer.id, pickId, sceneEngine)
        )
          return;
      }
      if (_selectedId) {
        _selectedId = null;
        publishSelectedCard();
      }
    });
  }

  function removeClickHandler() {
    if (_clickHandler) {
      _clickHandler();
      _clickHandler = null;
    }
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

    init(viewer, { engine = null } = {}) {
      if (initialized)
        throw new Error('Drone airspace layer is already initialized');
      initialized = true;
      try {
        if (engine) this.attachRenderer({ engine });
      } catch (error) {
        this.destroy();
        throw error;
      }
      console.log('[Data:DroneAirspace] Initialized');
    },

    /** Draw on a globe: the rows already fetched, and the selection. */
    show(enabled) {
      renderer?.setVisible(enabled);
      overlayHost?.setVisible?.(DRONE_AIRSPACE_OVERLAY_SOURCE_ID, enabled);
    },
    attachRenderer({ engine = null } = {}) {
      if (!initialized || renderer)
        throw new Error('Invalid drone airspace scene attachment');
      sceneEngine = engine;
      renderer = rendererFactory({ engine });
      this.show(_enabled);
      if (_rows.length) renderer.replace(_rows);
      if (_enabled) {
        overlayHost?.setVisible?.(DRONE_AIRSPACE_OVERLAY_SOURCE_ID, true);
        installClickHandler();
        if (_selectedId) publishSelectedCard();
      }
    },

    /** Leave the globe; the rows and selection stay for the next one. */
    detachRenderer() {
      removeClickHandler();
      overlayHost?.clearSource(DRONE_AIRSPACE_OVERLAY_SOURCE_ID);
      overlayHost?.setVisible?.(DRONE_AIRSPACE_OVERLAY_SOURCE_ID, false);
      renderer?.destroy();
      renderer = null;
      sceneEngine = null;
    },

    enable() {
      _enabled = true;
      renderer?.setVisible(true);
      overlayHost?.setVisible?.(DRONE_AIRSPACE_OVERLAY_SOURCE_ID, true);
      installClickHandler();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      renderer?.setVisible(false);
      removeClickHandler();
      clearSelection();
    },

    async update() {
      if (!_enabled) return false;
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
        _rowById.clear();
        let polygonCount = 0;
        for (const row of rows) {
          polygonCount += row.polygons.length;
          const { polygons, ...facts } = row;
          _rowById.set(row.stableId, {
            ...facts,
            anchor: droneAirspaceAnchorDegrees(polygons),
          });
        }
        _rows = rows;
        renderer?.replace(rows);
        _snapshotSignature = signature;
        if (_selectedId) publishSelectedCard();
        _count = rows.length;
        _lastUpdate = updatedAt;
        _lastError = null;
        console.log(
          `[Data:DroneAirspace] Updated: ${_count} zones, ${polygonCount} polygons`,
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
      _rows = [];
      _snapshotSignature = null;
      initialized = false;
      _enabled = false;
      this.detachRenderer();
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
    },

    getAnalystRecords(maxCount = 2000) {
      if (!_enabled) return [];
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
