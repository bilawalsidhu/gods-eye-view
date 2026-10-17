// Adapter between the ORYN shell and the running God's Eye View engine.
//
// The engine is composed once by src/main.js; this module never creates a
// viewer or a layer. It reads the application components after startup and
// exposes the handful of operations the enterprise shell needs: feed status,
// layer toggles, camera moves, selection events and record collection for
// the event queue. Everything here is a thin, typed facade over APIs that
// already exist in the engine.
import { t } from '../../i18n/index.js';
import { describeFeed } from './provenance.js';
import { flyToGlobeView, flyToLandmark } from '../../locations.js';
import { getSelectedEntityContext } from '../../data/contextStore.js';
import { validateEntityRef } from './models.js';

/** Layers whose records are events an analyst may triage. */
export const EVENT_LAYERS = Object.freeze({
  earthquakes: {
    kind: 'earthquake',
    label: (r) => `M${r.magnitude ?? '?'} ${r.place ?? t('Unknown location')}`,
    observedAt: (r) => r.timeMs,
    sourceUrl: (r) =>
      r.id && !/^QUAKE-/.test(r.id)
        ? `https://earthquake.usgs.gov/earthquakes/eventpage/${encodeURIComponent(r.id)}`
        : null,
    fields: (r) => ({
      magnitude: r.magnitude,
      depthKm: r.depthKm,
    }),
  },
  'local-firms': {
    kind: 'fire-detection',
    label: (r) =>
      r.label || t('Fire detection {frp} MW', { frp: r.frp ?? r.frpMw ?? '?' }),
    observedAt: (r) => r.acqMs ?? r.observedAtMs ?? r.observedAt ?? null,
    sourceUrl: () => 'https://firms.modaps.eosdis.nasa.gov/',
    fields: (r) => ({
      frp: r.frp ?? r.frpMw ?? null,
      confidence: r.confidence ?? r.confidencePct ?? null,
      sensor: r.sensor ?? r.instrument ?? null,
    }),
  },
  'fire-perimeters': {
    kind: 'fire-perimeter',
    label: (r) => r.name || r.id,
    observedAt: (r) => r.updatedTime ?? r.discoveredTime ?? null,
    sourceUrl: () => 'https://data-nifc.opendata.arcgis.com/',
    fields: (r) => ({
      acres: r.acres ?? null,
      containedPct: r.containedPct ?? null,
      state: r.state ?? null,
      cause: r.cause ?? null,
    }),
  },
  'weather-cyclones': {
    kind: 'cyclone',
    label: (r) => r.name || r.id,
    observedAt: () => null,
    sourceUrl: () => 'https://www.nhc.noaa.gov/',
    fields: (r) => ({
      classification: r.classification ?? null,
      basin: r.basin ?? null,
      windKt: r.windKt ?? null,
      pressureHpa: r.pressureHpa ?? null,
    }),
  },
  'gnss-integrity': {
    kind: 'gnss-anomaly',
    label: (r) => r.label || r.name || r.id,
    observedAt: (r) => r.observedAt ?? r.timeMs ?? null,
    sourceUrl: () => null,
    fields: (r) => ({ level: r.level ?? r.severity ?? null }),
  },
  'air-quality': {
    kind: 'air-quality',
    label: (r) => r.name || r.label || r.id,
    observedAt: (r) => r.observedAt ?? r.timeMs ?? null,
    sourceUrl: () => null,
    fields: (r) => ({ aqi: r.aqi ?? null, pollutant: r.pollutant ?? null }),
  },
});

/** Layers rendered as entities that the inspector can describe. */
export const ENTITY_KINDS = Object.freeze({
  flights: 'aircraft',
  military: 'aircraft',
  'local-adsb': 'aircraft',
  'ais-live-vessels': 'vessel',
  satellites: 'satellite',
  cctv: 'camera',
  'alpr-cameras': 'camera',
  'local-firms': 'fire-detection',
  'fire-perimeters': 'fire-perimeter',
  'military-installations': 'installation',
});

function toIso(value) {
  if (value === null || value === undefined) return null;
  const millis = typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

/** Turn a layer record into an ORYN entity reference with provenance. */
export function eventToEntityRef(layerId, record, { source, retrievedAt }) {
  const spec = EVENT_LAYERS[layerId];
  if (!spec || !record) return null;
  const lat = Number(record.lat);
  const lon = Number(record.lon);
  const fields = {};
  for (const [key, value] of Object.entries(spec.fields(record)))
    if (value !== null && value !== undefined && value !== '')
      fields[key] = value;
  return validateEntityRef({
    kind: spec.kind,
    id: `${layerId}:${record.id}`,
    label: spec.label(record),
    layerId,
    position:
      Number.isFinite(lat) && Number.isFinite(lon) ? { lon, lat } : undefined,
    source: source || layerId,
    sourceUrl: spec.sourceUrl(record) || undefined,
    observedAt: toIso(spec.observedAt(record)) || undefined,
    retrievedAt: toIso(retrievedAt) || undefined,
    provenance: 'provider',
    fields,
  });
}

/** Normalize a context-store selection record into an entity reference. */
export function selectionToEntityRef(record, feedsById = new Map()) {
  if (!record) return null;
  const layerId = record.layerId || null;
  const feed = layerId ? feedsById.get(layerId) : null;
  const fields = {};
  const properties = record.properties || {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'object') continue;
    fields[key] = value;
  }
  const lat = Number(record.latitude ?? record.lat);
  const lon = Number(record.longitude ?? record.lon);
  return validateEntityRef({
    kind: ENTITY_KINDS[layerId] || record.kind || 'entity',
    id: String(record.id ?? record.label ?? 'selection'),
    label: record.label || record.id || t('Selected entity'),
    layerId: layerId || undefined,
    position:
      Number.isFinite(lat) && Number.isFinite(lon)
        ? {
            lon,
            lat,
            height: Number.isFinite(record.altitudeM)
              ? record.altitudeM
              : undefined,
          }
        : undefined,
    source: record.source || record.dataSource || feed?.source || undefined,
    observedAt:
      toIso(
        properties.observedAt ??
          properties.lastPositionEpoch ??
          properties.lastContactAtMs ??
          properties.timeMs ??
          null,
      ) || undefined,
    retrievedAt: toIso(record.updatedAt ?? feed?.lastUpdate) || undefined,
    provenance: 'provider',
    fields,
  });
}

/**
 * Create the engine facade once the application is ready.
 * @param {{scene:object,controls:object,data:object,tools?:object}} components
 */
export function createEngineFacade(components, { windowRef = window } = {}) {
  const viewer = components.scene?.viewer;
  const dataManager = components.data?.dataManager;
  const styleManager = components.controls?.styleManager;
  const operations = components.scene?.operations;
  const weatherClock = components.data?.catalog?.weatherClock ?? null;
  if (!viewer || !dataManager || !styleManager)
    throw new TypeError('Engine components are incomplete');

  const selectionListeners = new Set();
  let lastSelection = null;

  function feeds() {
    const now = Date.now();
    return dataManager.getAll().map((row) => describeFeed(row, { now }));
  }

  function feedsById() {
    return new Map(feeds().map((feed) => [feed.id, feed]));
  }

  function publishSelection(ref) {
    lastSelection = ref;
    for (const listener of [...selectionListeners]) {
      try {
        listener(ref);
      } catch (error) {
        console.warn('[ORYN] selection listener failed', error);
      }
    }
  }

  const onSelected = () => {
    const record = getSelectedEntityContext({ dataManager });
    publishSelection(selectionToEntityRef(record, feedsById()));
  };
  const onAwareness = (event) => {
    const detail = event?.detail || {};
    const record = getSelectedEntityContext({ dataManager });
    const ref =
      selectionToEntityRef(record, feedsById()) ||
      selectionToEntityRef(
        {
          id: detail.id,
          label: detail.label,
          layerId: detail.layerId,
          latitude: detail.position?.lat ?? detail.position?.latitude,
          longitude: detail.position?.lon ?? detail.position?.longitude,
        },
        feedsById(),
      );
    publishSelection(ref);
  };
  const onCleared = () => publishSelection(null);

  windowRef.addEventListener('gev:entity-selected', onSelected);
  windowRef.addEventListener('gev:awareness-subject-selected', onAwareness);
  windowRef.addEventListener('gev:entity-selection-cleared', onCleared);
  windowRef.addEventListener('gev:awareness-subject-cleared', onCleared);

  return Object.freeze({
    viewer,
    dataManager,
    styleManager,
    operations,
    weatherClock,
    feeds,
    feedsById,
    isEnabled: (id) => dataManager.isEnabled(id),
    async setLayerEnabled(id, enabled) {
      return dataManager.setEnabled(id, enabled, { origin: 'user' });
    },
    subscribeActivity: (callback) => dataManager.subscribeActivity(callback),
    subscribeLayers: (callback) => dataManager.subscribe(callback),
    getCameraState: () => styleManager.getCameraState(),
    applyCameraState: (state, duration) =>
      styleManager.applyCameraState(state, duration),
    flyTo({ lat, lon, range = 2500, pitch = -35, duration = 2.4 }) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      flyToLandmark(viewer, lat, lon, { range, pitch, duration });
    },
    resetView() {
      flyToGlobeView(viewer);
    },
    async searchAndFlyTo(query, { signal } = {}) {
      if (typeof operations?.searchAndFlyTo !== 'function')
        throw new Error(t('Place search is not available'));
      return operations.searchAndFlyTo(viewer, query, {
        signal,
        placeSearch: styleManager.placeSearch,
      });
    },
    /** Records for every enabled event layer, as entity references. */
    collectEvents({ limit = 400 } = {}) {
      const result = [];
      const byId = feedsById();
      for (const [layerId] of Object.entries(EVENT_LAYERS)) {
        const entry = dataManager.layers.get(layerId);
        const module = entry?.module;
        if (!entry?.enabled || typeof module?.getAnalystRecords !== 'function')
          continue;
        const feed = byId.get(layerId);
        let records = [];
        try {
          records = module.getAnalystRecords(limit) || [];
        } catch (error) {
          console.warn(`[ORYN] ${layerId}: records unavailable`, error);
        }
        for (const record of records) {
          const ref = eventToEntityRef(layerId, record, {
            source: feed?.source,
            retrievedAt: feed?.lastUpdate,
          });
          if (ref) result.push(ref);
        }
      }
      result.sort((a, b) => {
        const ta = a.observedAt ? Date.parse(a.observedAt) : 0;
        const tb = b.observedAt ? Date.parse(b.observedAt) : 0;
        return tb - ta;
      });
      return result;
    },
    /** Entities whose label matches a query, across enabled record layers. */
    searchEntities(query, { limit = 12 } = {}) {
      const needle = String(query || '')
        .trim()
        .toLowerCase();
      if (needle.length < 2) return [];
      const matches = [];
      const byId = feedsById();
      for (const [layerId, entry] of dataManager.layers) {
        const module = entry?.module;
        if (!entry?.enabled || typeof module?.getAnalystRecords !== 'function')
          continue;
        let records = [];
        try {
          records = module.getAnalystRecords(2000) || [];
        } catch {
          continue;
        }
        const feed = byId.get(layerId);
        for (const record of records) {
          const haystack = [
            record.label,
            record.name,
            record.callsign,
            record.place,
            record.registration,
            record.id,
            record.mmsi,
            record.icao24,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          if (!haystack.includes(needle)) continue;
          const lat = Number(record.lat ?? record.latitude);
          const lon = Number(record.lon ?? record.longitude);
          matches.push(
            validateEntityRef({
              kind:
                ENTITY_KINDS[layerId] ||
                EVENT_LAYERS[layerId]?.kind ||
                'entity',
              id: `${layerId}:${record.id ?? record.name ?? matches.length}`,
              label:
                record.label ||
                record.name ||
                record.callsign ||
                record.place ||
                String(record.id),
              layerId,
              position:
                Number.isFinite(lat) && Number.isFinite(lon)
                  ? { lon, lat }
                  : undefined,
              source: feed?.source || undefined,
              retrievedAt: toIso(feed?.lastUpdate) || undefined,
              provenance: 'provider',
            }),
          );
          if (matches.length >= limit) return matches.filter(Boolean);
        }
      }
      return matches.filter(Boolean);
    },
    get selection() {
      return lastSelection;
    },
    subscribeSelection(listener) {
      if (typeof listener !== 'function') return () => {};
      selectionListeners.add(listener);
      return () => selectionListeners.delete(listener);
    },
    selectRef: (ref) => publishSelection(ref),
    destroy() {
      windowRef.removeEventListener('gev:entity-selected', onSelected);
      windowRef.removeEventListener(
        'gev:awareness-subject-selected',
        onAwareness,
      );
      windowRef.removeEventListener('gev:entity-selection-cleared', onCleared);
      windowRef.removeEventListener('gev:awareness-subject-cleared', onCleared);
      selectionListeners.clear();
    },
  });
}
