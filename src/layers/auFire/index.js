import * as Cesium from 'cesium';

const AU_FIRE_OVERLAY_SOURCE_ID = 'au-fire';
const AU_FIRE_OVERLAY_COHORT_LIMIT = 96;
const AU_FIRE_OVERLAY_COLLISION_CAPACITY = 48;

const ALERT_COLORS = {
  'Emergency Warning': Cesium.Color.fromCssColorString('#FF2200'),
  'Watch and Act': Cesium.Color.fromCssColorString('#FF7700'),
  Advice: Cesium.Color.fromCssColorString('#FFD700'),
};
const DEFAULT_COLOR = Cesium.Color.fromCssColorString('#88AABB');

function alertColor(level) {
  return ALERT_COLORS[level] || DEFAULT_COLOR;
}

/**
 * Pixel size encodes both severity (floor) and area (log scale bonus).
 * sizeHa may be null for incidents whose description lacks a SIZE field.
 */
function pointPixelSize(level, sizeHa) {
  const floor =
    level === 'Emergency Warning' ? 16 : level === 'Watch and Act' ? 12 : 8;
  if (!sizeHa || sizeHa <= 0) return floor;
  // log10 scale: +2px per order of magnitude (100 ha → +4, 10 000 ha → +8)
  const bonus = Math.log10(Math.max(1, sizeHa)) * 2;
  return Math.min(Math.round(floor + bonus), 52);
}

function overlayPriority(alertLevel) {
  if (alertLevel === 'Emergency Warning') return 3000;
  if (alertLevel === 'Watch and Act') return 2000;
  return 1000;
}

/** Average the exterior ring vertices of a Polygon or MultiPolygon. */
function computeCentroid(perimeter) {
  if (!perimeter) return null;
  let sumLon = 0,
    sumLat = 0,
    n = 0;
  const addRing = (ring) => {
    for (const [lo, la] of ring) {
      sumLon += lo;
      sumLat += la;
      n++;
    }
  };
  if (perimeter.type === 'Polygon') addRing(perimeter.coordinates?.[0] ?? []);
  else if (perimeter.type === 'MultiPolygon')
    for (const rings of perimeter.coordinates ?? []) addRing(rings?.[0] ?? []);
  return n > 0 ? { lon: sumLon / n, lat: sumLat / n } : null;
}

function createOverlayEntry(incident, selected = false) {
  const color = alertColor(incident.alertLevel);
  const position = Cesium.Cartesian3.fromDegrees(
    incident.displayLon ?? incident.lon,
    incident.displayLat ?? incident.lat,
  );

  let title;
  const stateTag = incident.state ? `[${incident.state}] ` : '';
  if (selected) {
    title = (stateTag + (incident.title || incident.alertLevel)).trim();
    if (incident.status) title += ` · ${incident.status}`;
    if (incident.sizeHa)
      title += ` · ${Math.round(incident.sizeHa).toLocaleString()} ha`;
  } else {
    // Show fire name as the label; fall back to alert level abbreviation
    const name = incident.title?.trim();
    title = name
      ? `${stateTag}${name}`
      : incident.alertLevel === 'Emergency Warning'
        ? `${stateTag}EMERGENCY`
        : incident.alertLevel === 'Watch and Act'
          ? `${stateTag}WATCH & ACT`
          : incident.alertLevel === 'Advice'
            ? `${stateTag}ADVICE`
            : `${stateTag}FIRE`;
  }

  return {
    id: String(incident.id),
    position,
    variant: 'label',
    title,
    accent: color.toCssColorString(),
    priority: overlayPriority(incident.alertLevel) + (selected ? 10000 : 0),
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

/** Build all Cesium entities for one incident. */
function buildEntities(incident) {
  const {
    id,
    title,
    alertLevel,
    status,
    type,
    fireActive,
    sizeHa,
    council,
    updated,
    location,
    agency,
    link,
    lon,
    lat,
    perimeter,
    displayLon,
    displayLat,
  } = incident;

  const color = alertColor(alertLevel);
  // Use perimeter centroid when available so the dot sits over the fire area
  const position = Cesium.Cartesian3.fromDegrees(
    displayLon ?? lon,
    displayLat ?? lat,
  );

  const props = {
    alertLevel,
    status,
    type,
    fireActive,
    sizeHa,
    council,
    updated,
    location,
    agency,
    link,
  };

  const entities = [];

  // Point only — labels are handled by the overlay system to avoid duplication
  entities.push(
    new Cesium.Entity({
      id: `au-fire:${id}`,
      position,
      point: new Cesium.PointGraphics({
        color,
        pixelSize: pointPixelSize(alertLevel, sizeHa),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      }),
      properties: props,
    }),
  );

  if (perimeter) {
    let hierarchy = null;
    try {
      if (perimeter.type === 'Polygon' && perimeter.coordinates?.length) {
        const outer = perimeter.coordinates[0];
        const positions = outer.map(([pLon, pLat]) =>
          Cesium.Cartesian3.fromDegrees(pLon, pLat),
        );
        const holes = perimeter.coordinates.slice(1).map((ring) => ({
          positions: ring.map(([pLon, pLat]) =>
            Cesium.Cartesian3.fromDegrees(pLon, pLat),
          ),
        }));
        hierarchy = new Cesium.PolygonHierarchy(positions, holes);
      } else if (
        perimeter.type === 'MultiPolygon' &&
        perimeter.coordinates?.length
      ) {
        for (let pi = 0; pi < perimeter.coordinates.length; pi++) {
          try {
            const rings = perimeter.coordinates[pi];
            if (!rings?.length) continue;
            const outer = rings[0];
            const positions = outer.map(([pLon, pLat]) =>
              Cesium.Cartesian3.fromDegrees(pLon, pLat),
            );
            const holes = rings.slice(1).map((ring) => ({
              positions: ring.map(([pLon, pLat]) =>
                Cesium.Cartesian3.fromDegrees(pLon, pLat),
              ),
            }));
            const h = new Cesium.PolygonHierarchy(positions, holes);
            entities.push(
              new Cesium.Entity({
                id: `au-fire-perimeter:${id}:${pi}`,
                polygon: new Cesium.PolygonGraphics({
                  hierarchy: h,
                  material: color.withAlpha(0.2),
                  outline: true,
                  outlineColor: color.withAlpha(0.85),
                  outlineWidth: 2,
                  heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                  // Globe is hidden — only 3D tiles provide the ground surface
                  classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
                }),
                properties: { incidentId: id },
              }),
            );
          } catch {
            /* skip malformed ring */
          }
        }
        hierarchy = null;
      }
    } catch {
      hierarchy = null;
    }

    if (hierarchy) {
      entities.push(
        new Cesium.Entity({
          id: `au-fire-perimeter:${id}`,
          polygon: new Cesium.PolygonGraphics({
            hierarchy,
            material: color.withAlpha(0.2),
            outline: true,
            outlineColor: color.withAlpha(0.85),
            outlineWidth: 2,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            // Globe is hidden — only 3D tiles provide the ground surface
            classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
          }),
          properties: { incidentId: id },
        }),
      );
    }
  }

  return entities;
}

/** Create the AU fire incidents layer (NSW RFS + VIC EMV). */
export function createAuFireLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('AU Fire layer requires a snapshot source');
  if (!overlayHost)
    throw new TypeError('AU Fire layer requires an overlay host');

  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _incidents = [];
  let _selectedId = null;
  let _onEntitySelected = null;

  function _rebuildOverlayEntries() {
    const entries = _incidents
      .map((inc) => createOverlayEntry(inc, inc.id === _selectedId))
      .sort((a, b) => b.priority - a.priority)
      .slice(0, AU_FIRE_OVERLAY_COHORT_LIMIT);
    overlayHost.setEntries(AU_FIRE_OVERLAY_SOURCE_ID, entries, {
      cohortLimit: AU_FIRE_OVERLAY_COHORT_LIMIT,
      collisionCapacity: AU_FIRE_OVERLAY_COLLISION_CAPACITY,
      moving: false,
    });
  }

  const layer = {
    id: 'au-fire',
    name: 'AU Fire Incidents',
    icon: '🔥',
    source: 'NSW RFS / VIC EMV',
    updateInterval: 120_000,

    init(viewer) {
      if (_viewer) throw new Error('AU Fire layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('au-fire');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(AU_FIRE_OVERLAY_SOURCE_ID, false);

      _onEntitySelected = (entity) => {
        if (!_enabled) return;
        const eid = entity?.id;
        if (typeof eid === 'string' && eid.startsWith('au-fire:')) {
          _selectedId = eid.slice('au-fire:'.length);
          _rebuildOverlayEntries();
        } else if (!entity) {
          if (_selectedId !== null) {
            _selectedId = null;
            _rebuildOverlayEntries();
          }
        }
        // entity from another layer — leave our selection unchanged
      };
      viewer.selectedEntityChanged.addEventListener(_onEntitySelected);
      console.log('[Data:AUFire] Initialized');
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(AU_FIRE_OVERLAY_SOURCE_ID, true);
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      _selectedId = null;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(AU_FIRE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AU_FIRE_OVERLAY_SOURCE_ID, false);
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const payload = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;

        const { incidents } = payload;
        // Enrich each incident: use perimeter centroid as display position
        _incidents = incidents.map((inc) => {
          const c = computeCentroid(inc.perimeter);
          return c ? { ...inc, displayLon: c.lon, displayLat: c.lat } : inc;
        });
        _dataSource.entities.removeAll();
        let count = 0;
        for (const incident of _incidents) {
          const entities = buildEntities(incident);
          for (const entity of entities) _dataSource.entities.add(entity);
          count++;
        }

        _count = count;
        _lastUpdate = Date.now();
        _lastError = null;
        if (_enabled) _rebuildOverlayEntries();
        console.log(`[Data:AUFire] Updated: ${_count} incidents`);
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:AUFire] Fetch error:', e);
        _lastError = e?.message || 'AU fire source unavailable';
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      if (_onEntitySelected && _viewer) {
        _viewer.selectedEntityChanged.removeEventListener(_onEntitySelected);
        _onEntitySelected = null;
      }
      _viewer = null;
      _enabled = false;
      _selectedId = null;
      _incidents = [];
      overlayHost.clearSource(AU_FIRE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AU_FIRE_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer?.dataSources?.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
      };
    },
  };

  return layer;
}

export { createAuFireSource } from './source.js';
