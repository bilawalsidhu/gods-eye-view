import * as Cesium from 'cesium';
import { requestWorldFocus } from '../worldFocus.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';

const HAZARDS_API_URL = '/api/noaa/hazards';
const MAX_EVENTS = 250;
const ACTIVE_TORNADO_EVENTS = new Set(['Tornado Warning', 'Tornado Watch']);
const ACTIVE_TSUNAMI_EVENTS = new Set([
  'Tsunami Warning',
  'Tsunami Advisory',
  'Tsunami Watch',
]);
const ALERT_EVENT_SETS = Object.freeze({
  tornado: ACTIVE_TORNADO_EVENTS,
  tsunami: ACTIVE_TSUNAMI_EVENTS,
  severeThunderstorms: new Set(['Severe Thunderstorm Warning']),
  floods: new Set([
    'Flood Warning',
    'Flash Flood Warning',
    'Coastal Flood Warning',
    'Lakeshore Flood Warning',
  ]),
  winterWeather: new Set([
    'Winter Weather Advisory',
    'Winter Storm Warning',
    'Ice Storm Warning',
    'Blizzard Warning',
    'Snow Squall Warning',
  ]),
  excessiveHeat: new Set([
    'Excessive Heat Warning',
    'Excessive Heat Watch',
    'Heat Advisory',
  ]),
  highWind: new Set(['High Wind Warning', 'Wind Advisory']),
  fireWeather: new Set(['Red Flag Warning', 'Fire Weather Watch']),
});
const HAZARD_OVERLAY_COHORT_LIMIT = 96;
const HAZARD_OVERLAY_COLLISION_CAPACITY = 48;
const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function text(value) {
  const result = String(value ?? '').trim();
  return result || null;
}

function pointFromGeometry(geometry) {
  if (!geometry || !Array.isArray(geometry.coordinates)) return null;
  const points = [];
  const visit = (value) => {
    if (Array.isArray(value) && value.length >= 2
      && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
      points.push([Number(value[0]), Number(value[1])]);
      return;
    }
    if (Array.isArray(value)) for (const child of value) visit(child);
  };
  visit(geometry.coordinates);
  if (!points.length) return null;
  const lon = points.reduce((sum, point) => sum + point[0], 0) / points.length;
  const lat = points.reduce((sum, point) => sum + point[1], 0) / points.length;
  return Math.abs(lon) <= 180 && Math.abs(lat) <= 90 ? { lon, lat } : null;
}

function severityColor(event) {
  if (event === 'Tornado Warning' || event === 'Tsunami Warning') return Cesium.Color.RED;
  if (event === 'Tornado Watch' || event === 'Tsunami Watch') return Cesium.Color.ORANGE;
  return Cesium.Color.YELLOW;
}

function hazardRadius(event, preliminary) {
  // This is a presentation halo around the source coordinate, not the
  // warning footprint. Keep it aligned with the click-focus sphere so the
  // circle remains visible after a point is selected.
  return 1_200;
}

function hazardDisplayLabel(row) {
  if (row.preliminary) return 'TORNADO';
  if (row.event.startsWith('Tornado ')) return row.event.toUpperCase();
  if (row.event.startsWith('Tsunami ')) return row.event.toUpperCase();
  return row.event.toUpperCase();
}

export function createHazardOverlayEntry({ id, position, title, accent, priority }) {
  return {
    id: String(id),
    position,
    variant: 'label',
    title,
    accent,
    priority,
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

/** Normalize NWS GeoJSON features for one hazard family. */
export function normalizeNwsHazards(geojson, events) {
  if (!Array.isArray(geojson?.features)) return null;
  const rows = [];
  const ids = new Set();
  for (const feature of geojson.features) {
    const properties = feature?.properties;
    const event = text(properties?.event);
    if (!properties || !events.has(event)) continue;
    const position = pointFromGeometry(feature.geometry);
    const id = text(feature.id || properties.id);
    if (!position || !id || ids.has(id)) continue;
    ids.add(id);
    rows.push({
      id: `nws:${id}`,
      event,
      title: text(properties.headline) || event,
      description: text(properties.description),
      source: 'NOAA NWS',
      lon: position.lon,
      lat: position.lat,
      sent: text(properties.sent),
      effective: text(properties.effective),
      expires: text(properties.expires),
      severity: text(properties.severity),
      status: text(properties.status),
      certainty: text(properties.certainty),
      preliminary: false,
    });
  }
  return rows;
}

/** Parse the SPC daily CSV without treating report text as executable input. */
export function normalizeSpcTornadoReports(csv) {
  if (csv === '') return [];
  if (typeof csv !== 'string'
    || !/^Time,F_Scale,Location,County,State,Lat,Lon,Comments/m.test(csv)) return null;
  const section = csv.split(/\r?\nTime,(?:Speed|Size),Location/)[0];
  const rows = [];
  for (const [index, line] of section.split(/\r?\n/).entries()) {
    const fields = line.split(',').map((field) => field.trim());
    if (index === 0 || fields.length < 7 || !/^\d{3,4}$/.test(fields[0])) continue;
    const compactFormat = fields[4] && /^-?\d{3,4}$/.test(fields[4])
      && /^-?\d{3,5}$/.test(fields[5]);
    const lat = compactFormat ? finite(fields[4]) / 100 : finite(fields[5]);
    const rawLon = compactFormat ? finite(fields[5]) / 100 : finite(fields[6]);
    const lon = compactFormat ? -Math.abs(rawLon) : rawLon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)
      || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    rows.push({
      id: `spc:${fields[0]}:${fields[4]}:${fields[5]}:${rows.length}`,
      event: 'Preliminary Tornado Report',
      title: 'Preliminary tornado report',
      description: text(fields.slice(compactFormat ? 1 : 7).join(', '))
        || text(fields.slice(1).join(', ')),
      source: 'NOAA SPC',
      lon,
      lat,
      sent: null,
      effective: null,
      expires: null,
      severity: 'Unknown',
      status: 'Preliminary',
      certainty: 'Unknown',
      preliminary: true,
    });
  }
  return rows;
}

export function normalizeHazardPayload(payload, kind) {
  const events = ALERT_EVENT_SETS[kind];
  if (!events) return null;
  const alerts = normalizeNwsHazards(payload?.alerts, events);
  const reports = kind === 'tornado' ? normalizeSpcTornadoReports(payload?.reportsCsv) : [];
  if (!alerts || reports === null) return null;
  return [...alerts, ...reports].slice(0, MAX_EVENTS);
}

function createHazardLayer({ id, name, kind, icon, overlayHost = DEFAULT_OVERLAY_HOST }) {
  let viewer = null;
  let dataSource = null;
  let clickHandler = null;
  let rowsByEntityId = new Map();
  let enabled = false;
  let count = 0;
  let lastUpdate = null;
  let error = null;
  let stale = false;

  return {
    id,
    name,
    icon,
    source: 'NOAA NWS / SPC',
    updateInterval: 60_000,

    init(viewerInstance) {
      viewer = viewerInstance;
      dataSource = new Cesium.CustomDataSource(id);
      dataSource.show = false;
      viewerInstance.dataSources.add(dataSource);
      overlayHost.setVisible(id, false);
      count = 0;
      lastUpdate = null;
      error = null;
      stale = false;
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      overlayHost.setVisible(id, true);
      if (!clickHandler && viewer?.scene?.canvas) {
        clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        clickHandler.setInputAction((click) => {
          const picked = viewer.scene.pick(click.position);
          const entity = picked?.id;
          const row = entity?.id ? rowsByEntityId.get(entity.id) : null;
          if (!row) return;
          requestWorldFocus({
            kind: 'hazard',
            id: row.id,
            label: hazardDisplayLabel(row),
            position: Cesium.Cartesian3.fromDegrees(row.lon, row.lat),
          });
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      }
    },

    disable() {
      enabled = false;
      if (dataSource) dataSource.show = false;
      overlayHost.clearSource(id);
      overlayHost.setVisible(id, false);
      if (clickHandler) {
        clickHandler.destroy();
        clickHandler = null;
      }
    },

    async update() {
      try {
        const response = await fetch(HAZARDS_API_URL);
        if (!response.ok) {
          error = `NOAA HTTP ${response.status}`;
          return false;
        }
        const payload = await response.json();
        const rows = normalizeHazardPayload(payload, kind);
        if (!rows) {
          error = 'Malformed NOAA hazards response';
          return false;
        }
        const overlayEntries = [];
        const nextEntities = rows.map((row) => {
          const color = severityColor(row.event);
          const entityId = `${id}:${row.id}`;
          const radius = hazardRadius(row.event, row.preliminary);
          const displayLabel = hazardDisplayLabel(row);
          const position = Cesium.Cartesian3.fromDegrees(row.lon, row.lat);
          overlayEntries.push(createHazardOverlayEntry({
            id: row.id,
            position,
            title: displayLabel,
            accent: color.toCssColorString(),
            priority: row.preliminary ? 1000 : row.event.includes('Warning') ? 3000 : 2000,
          }));
          return new Cesium.Entity({
            id: entityId,
            position,
            ellipse: {
              semiMajorAxis: radius,
              semiMinorAxis: radius,
              fill: true,
              show: true,
              material: new Cesium.ColorMaterialProperty(color.withAlpha(0.35)),
              outline: true,
              outlineColor: color.withAlpha(1),
              outlineWidth: 3,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            },
            point: {
              pixelSize: row.preliminary ? 8 : 12,
              color: color.withAlpha(row.preliminary ? 0.75 : 0.95),
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 1,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            },
            label: {
              text: displayLabel,
              font: '11px sans-serif',
              fillColor: color,
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 3,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
              pixelOffset: new Cesium.Cartesian2(0, -10),
              show: false,
            },
            properties: row,
          });
        });
        rowsByEntityId = new Map(nextEntities.map((entity, index) => [entity.id, rows[index]]));
        dataSource.entities.removeAll();
        for (const entity of nextEntities) dataSource.entities.add(entity);
        if (enabled) {
          overlayHost.setEntries(id, overlayEntries, {
            cohortLimit: HAZARD_OVERLAY_COHORT_LIMIT,
            collisionCapacity: HAZARD_OVERLAY_COLLISION_CAPACITY,
            moving: false,
          });
        }
        count = rows.length;
        lastUpdate = Number.isFinite(payload.fetchedAt) ? payload.fetchedAt : Date.now();
        stale = payload.stale === true;
        error = null;
        return true;
      } catch {
        error = 'NOAA network error';
        return false;
      }
    },

    destroy(viewerInstance) {
      enabled = false;
      if (clickHandler) {
        clickHandler.destroy();
        clickHandler = null;
      }
      overlayHost.clearSource(id);
      overlayHost.setVisible(id, false);
      if (dataSource) viewerInstance.dataSources.remove(dataSource, true);
      viewer = null;
      dataSource = null;
      rowsByEntityId = new Map();
      count = 0;
      lastUpdate = null;
      error = null;
      stale = false;
    },

    getStats() {
      return { count, lastUpdate, error, stale, enabled };
    },
  };
}

export const tornadoesLayer = createHazardLayer({
  id: 'tornadoes',
  name: 'Tornadoes & Alerts',
  kind: 'tornado',
  icon: '!',
});

export const tsunamisLayer = createHazardLayer({
  id: 'tsunamis',
  name: 'Tsunami Alerts',
  kind: 'tsunami',
  icon: '!',
});

export const severeThunderstormsLayer = createHazardLayer({
  id: 'severe-thunderstorms',
  name: 'Severe Thunderstorms',
  kind: 'severeThunderstorms',
  icon: '!',
});

export const floodsLayer = createHazardLayer({
  id: 'floods',
  name: 'Flood Warnings',
  kind: 'floods',
  icon: '!',
});

export const winterWeatherLayer = createHazardLayer({
  id: 'winter-weather',
  name: 'Winter Weather',
  kind: 'winterWeather',
  icon: '!',
});

export const excessiveHeatLayer = createHazardLayer({
  id: 'excessive-heat',
  name: 'Excessive Heat',
  kind: 'excessiveHeat',
  icon: '!',
});

export const highWindLayer = createHazardLayer({
  id: 'high-wind',
  name: 'High Wind Alerts',
  kind: 'highWind',
  icon: '!',
});

export const fireWeatherLayer = createHazardLayer({
  id: 'fire-weather',
  name: 'Fire Weather',
  kind: 'fireWeather',
  icon: '!',
});
