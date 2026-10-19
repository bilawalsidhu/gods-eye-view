import * as Cesium from 'cesium';
import { msg, t, tn, translateKnown } from '../../i18n/index.js';
import {
  INCIDENT_STATUS_BANDS,
  SA_FIRE_OVERLAY_SOURCE_ID,
  buildIncidentCard,
  buildWarningCard,
  formatAdelaideTime,
  incidentLevelRank,
  incidentStatusBand,
  incidentStatusColor,
  warningCategoryColor,
} from './cards.js';
import { linkWarningsToIncidents } from './records.js';
export {
  MAX_INCIDENTS,
  MAX_WARNINGS,
  linkWarningsToIncidents,
  normalizeSaIncidents,
  normalizeSaWarnings,
  parseReportedTime,
  safeWarningLink,
  validateSaFireSnapshot,
} from './records.js';
export { createSaFireSource } from './source.js';
export * from './cards.js';

const INCIDENT_PICK_PREFIX = 'sa-fire-incident:';
const WARNING_PICK_PREFIX = 'sa-fire-warning:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
// Marker diameter in pixels by incident level (L1 small → L3 large).
const LEVEL_PIXEL_SIZE = Object.freeze({ 1: 9, 2: 12, 3: 16 });
const AGENCY_CHIPS = Object.freeze([
  {
    agency: 'CFS',
    label: 'CFS', // i18n-ignore: agency acronym, shown as it is
    title: msg('Country Fire Service incidents'),
  },
  {
    agency: 'MFS',
    label: 'MFS', // i18n-ignore: agency acronym, shown as it is
    title: msg('Metropolitan Fire Service incidents'),
  },
]);

const ringPositions = (ring) =>
  ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));

/** Own the SA CFS/MFS incident and warning display, its refresh lifecycle and click selection. */
export function createSaFireIncidentsLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  openExternal = null,
  now = () => Date.now(),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('SA fire incidents require a snapshot source');
  let _viewer = null;
  let _request = null;
  let _signature = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _clickHandler = null;
  let _selected = null; // { kind: 'incident' | 'warning', id }
  let _selectedCardId = null;
  let _selectedLink = null;
  let _listener = null;
  let _meta = null; // feed-level facts from the last good snapshot
  /** @type {Map<string, Object>} */
  const _incidentById = new Map();
  /** @type {Map<string, Object>} */
  const _warningById = new Map();
  /** @type {Map<string, Object>} incident id → entity, for agency filtering. */
  const _incidentEntities = new Map();
  /** @type {Map<string, string>} warning id → linked incident id. */
  let _links = new Map();
  const _agencyOn = new Map(AGENCY_CHIPS.map(({ agency }) => [agency, true]));

  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;
  const notify = () => _listener?.();
  const feedTime = () => _meta?.upstreamModified ?? _meta?.incidentsFetchedAt;
  // Unknown agencies have no chip and are always shown.
  const agencyVisible = (row) => _agencyOn.get(row.agency) !== false;

  function clearCard() {
    _selected = null;
    _selectedLink = null;
    _selectedCardId = null;
    overlayHost?.setEntries(SA_FIRE_OVERLAY_SOURCE_ID, [], CARD_HOST_OPTIONS);
  }

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row =
      _selected?.kind === 'incident'
        ? _incidentById.get(_selected.id)
        : _selected?.kind === 'warning'
          ? _warningById.get(_selected.id)
          : null;
    if (!row || (_selected.kind === 'incident' && !agencyVisible(row))) {
      clearCard();
      return;
    }
    let card;
    let anchor = row;
    if (_selected.kind === 'incident') {
      const warning = [..._links]
        .filter(([, incidentId]) => incidentId === row.id)
        .map(([warningId]) => _warningById.get(warningId))
        .find(Boolean);
      card = buildIncidentCard(row, { feedTime: feedTime(), warning });
      _selectedLink = null;
    } else {
      card = buildWarningCard(row, {
        feedTime: feedTime(),
        incident: _incidentById.get(_links.get(row.id)) || null,
      });
      _selectedLink = row.link;
    }
    card = {
      ...card,
      position: Cesium.Cartesian3.fromDegrees(anchor.lon, anchor.lat),
    };
    if (!openExternal) card.interactive = false;
    if (_selectedLink && openExternal) {
      const link = _selectedLink;
      // Keyboard/assistive activation mirrors the pointer click-through.
      card.activate = () => {
        openExternal(link);
        return true;
      };
    }
    _selectedCardId = card.id;
    overlayHost.setEntries(
      SA_FIRE_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  /** Resolve a scene pick to one of this layer's rows, or null. */
  function pickedSelection(picked) {
    const pickId = picking.resolvePickId(picked);
    if (typeof pickId !== 'string') return null;
    if (pickId.startsWith(INCIDENT_PICK_PREFIX)) {
      const id = pickId.slice(INCIDENT_PICK_PREFIX.length);
      return _incidentById.has(id) ? { kind: 'incident', id } : null;
    }
    if (pickId.startsWith(WARNING_PICK_PREFIX)) {
      // Multi-polygon warnings suffix later parts with #n.
      const id = pickId.slice(WARNING_PICK_PREFIX.length).replace(/#\d+$/, '');
      return _warningById.has(id) ? { kind: 'warning', id } : null;
    }
    return null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    // Deliberately NOT registered in the pick-ownership registry: the warning
    // polygons are large ground areas, and owning them would make sibling
    // layers' overlay cards inert wherever a warning covers the globe.
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      // A click on the selected card itself opens its link (when it has one)
      // and never disturbs the selection.
      const cardHit = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
        { sourceId: SA_FIRE_OVERLAY_SOURCE_ID },
      );
      if (cardHit && cardHit.entryId === _selectedCardId) {
        if (_selectedLink && openExternal) openExternal(_selectedLink);
        return;
      }
      const picked = _viewer.scene.pick(click.position);
      const selection = picked ? pickedSelection(picked) : null;
      if (selection) {
        _selected = selection;
        publishSelectedCard();
        return;
      }
      // A pick that belongs to a sibling layer is not "empty space".
      if (picked) {
        const pickId = picking.resolvePickId(picked);
        if (pickId && picking.isOwnedByOtherLayer(layer.id, pickId)) return;
      }
      if (_selected) clearCard();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
  }

  function clearSelection() {
    _selected = null;
    _selectedLink = null;
    _selectedCardId = null;
    if (overlayHost) {
      overlayHost.clearSource(SA_FIRE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible?.(SA_FIRE_OVERLAY_SOURCE_ID, false);
    }
  }

  function incidentEntity(row) {
    const color = Cesium.Color.fromCssColorString(
      incidentStatusColor(row.status),
    );
    return new Cesium.Entity({
      id: `${INCIDENT_PICK_PREFIX}${row.id}`,
      show: agencyVisible(row),
      position: Cesium.Cartesian3.fromDegrees(row.lon, row.lat),
      point: {
        pixelSize: LEVEL_PIXEL_SIZE[incidentLevelRank(row.level)],
        color,
        outlineColor: Cesium.Color.BLACK.withAlpha(0.85),
        outlineWidth: 1.5,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  function warningEntities(row) {
    const color = Cesium.Color.fromCssColorString(
      warningCategoryColor(row.category),
    );
    if (row.kind === 'point')
      return [
        new Cesium.Entity({
          id: `${WARNING_PICK_PREFIX}${row.id}`,
          position: Cesium.Cartesian3.fromDegrees(row.lon, row.lat),
          point: {
            pixelSize: 14,
            color,
            outlineColor: Cesium.Color.WHITE.withAlpha(0.9),
            outlineWidth: 3,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }),
      ];
    return row.polygons.map((rings, index) => {
      const [outer, ...holes] = rings;
      const outerPositions = ringPositions(outer);
      return new Cesium.Entity({
        id: `${WARNING_PICK_PREFIX}${row.id}${index ? `#${index}` : ''}`,
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(
            outerPositions,
            holes.map(
              (hole) => new Cesium.PolygonHierarchy(ringPositions(hole)),
            ),
          ),
          material: new Cesium.ColorMaterialProperty(color.withAlpha(0.28)),
          // Draw on the globe AND on 3D tiles (maintainer requirement).
          classificationType: Cesium.ClassificationType.BOTH,
        },
        // Ground-clamped outline: entity polygons cannot outline clamped geometry.
        polyline: {
          positions: outerPositions,
          clampToGround: true,
          width: 2,
          material: new Cesium.ColorMaterialProperty(color.withAlpha(0.9)),
          classificationType: Cesium.ClassificationType.BOTH,
        },
      });
    });
  }

  const layer = {
    id: 'sa-fire-incidents',
    name: 'SA Fire Incidents',
    icon: '🔥',
    source: 'SA CFS · MFS',
    updateInterval: 60000,

    init(viewer) {
      if (_viewer)
        throw new Error('SA fire incidents layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('sa-fire-incidents');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      console.log('[Data:SaFire] Initialized');
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(SA_FIRE_OVERLAY_SOURCE_ID, true);
      installClickHandler();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      removeClickHandler();
      clearSelection();
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
        _meta = {
          warningsAvailable: snapshot.warningsAvailable,
          stale: snapshot.stale === true,
          upstreamModified: snapshot.upstreamModified ?? null,
          incidentsFetchedAt: snapshot.incidentsFetchedAt ?? null,
        };
        // A warning can expire between server refreshes; drop it here too.
        const nowMs = now();
        const warnings = snapshot.warnings.filter(
          (row) => row.expiryTime == null || row.expiryTime >= nowMs,
        );
        const signature = JSON.stringify([
          [...snapshot.incidents].sort((a, b) => a.id.localeCompare(b.id)),
          [...warnings].sort((a, b) => a.id.localeCompare(b.id)),
        ]);
        if (signature !== _signature) {
          _incidentById.clear();
          _warningById.clear();
          _incidentEntities.clear();
          const nextEntities = [];
          for (const row of warnings) {
            _warningById.set(row.id, row);
            nextEntities.push(...warningEntities(row));
          }
          // Incidents last so their markers draw above warning outlines.
          for (const row of snapshot.incidents) {
            _incidentById.set(row.id, row);
            const entity = incidentEntity(row);
            _incidentEntities.set(row.id, entity);
            nextEntities.push(entity);
          }
          _links = linkWarningsToIncidents(snapshot.incidents, warnings);
          _dataSource.entities.removeAll();
          for (const entity of nextEntities) _dataSource.entities.add(entity);
          _signature = signature;
          _count = snapshot.incidents.length;
          console.log(
            `[Data:SaFire] Updated: ${_count} incidents, ${warnings.length} warnings`,
          );
        }
        if (_selected) publishSelectedCard();
        _lastUpdate = Date.now();
        _lastError = null;
        notify();
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:SaFire] Fetch error:', e);
        _lastError = e?.message || msg('SA fire source unavailable');
        notify();
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      removeClickHandler();
      clearSelection();
      _incidentById.clear();
      _warningById.clear();
      _incidentEntities.clear();
      _links = new Map();
      _signature = null;
      _meta = null;
      _listener = null;
      _viewer = null;
      _enabled = false;
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    /** Snapshot displayed incident facts for the analyst query engine. */
    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const result = [];
      for (const row of _incidentById.values()) {
        if (result.length >= limit) break;
        if (!agencyVisible(row)) continue;
        result.push({ ...row });
      }
      return result;
    },

    getRowControls() {
      const shown = [..._incidentById.values()].filter(agencyVisible);
      const counts = new Map(INCIDENT_STATUS_BANDS.map((b) => [b.label, 0]));
      for (const row of shown) {
        const label = incidentStatusBand(row.status);
        counts.set(label, counts.get(label) + 1);
      }
      const feed = formatAdelaideTime(feedTime());
      const lines = [
        feed
          ? t('Feed updated {time}', { time: feed })
          : t('Feed time unavailable'),
      ];
      if (_meta) {
        if (!_meta.warningsAvailable) lines.push(t('Warnings unavailable'));
        else
          lines.push(
            _warningById.size
              ? tn(
                  _warningById.size,
                  '{count} public warning',
                  '{count} public warnings',
                )
              : t('No active public warnings'),
          );
        if (_meta.stale)
          lines.push(t('Showing last good data · SA feed not responding'));
      }
      if (_lastError) lines.push(translateKnown(_lastError));
      return {
        chips: AGENCY_CHIPS.map(({ agency, label, title }) => ({
          id: `agency-${agency.toLowerCase()}`,
          label,
          title: t(title),
          active: _agencyOn.get(agency) !== false,
          onClick: () => {
            _agencyOn.set(agency, _agencyOn.get(agency) === false);
            for (const [id, entity] of _incidentEntities)
              entity.show = agencyVisible(_incidentById.get(id));
            if (_selected?.kind === 'incident') publishSelectedCard();
            notify();
          },
        })),
        legend: INCIDENT_STATUS_BANDS.map((band, index) => ({
          label: t(band.label),
          color: incidentStatusColor(band.status),
          count: counts.get(band.label),
          ...(index === 0
            ? {
                blurb: t(
                  'Marker colour shows reported status; size shows incident level (L1 to L3). Warning areas are tinted red, orange or yellow by category.',
                ),
              }
            : {}),
        })),
        // The row's info node collapses newlines, so the facts are joined inline.
        info: lines.join(' · '),
        infoTitle: t(
          'South Australian CFS and MFS current incidents with public warnings. Times are Adelaide local time. Consult the official CFS and MFS channels for emergency decisions.',
        ),
      };
    },

    setRowControlsListener(listener) {
      _listener = typeof listener === 'function' ? listener : null;
    },

    getStats() {
      return {
        count: _count,
        warnings: _warningById.size,
        stale: _meta?.stale === true,
        lastUpdate: _lastUpdate,
        error: _lastError,
      };
    },
  };
  return layer;
}
