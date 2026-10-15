import * as Cesium from 'cesium';
import { isPointerFree as defaultIsPointerFree } from '../../data/inputOwnership.js';
import {
  registerPickOwner,
  unregisterPickOwner,
} from '../../data/pickRegistry.js';
import { createDriveBcEventPopup } from './popup.js';
import { DRIVEBC_SEVERITY_STYLES, driveBcSeverityStyle } from './severity.js';

const MAX_RENDER_LINE_POINTS = 200;
const LAYER_ID = 'drivebc-road-conditions';
const ownsDriveBcPick = (id) =>
  typeof id === 'string' && id.startsWith('drivebc:');

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function severityColor(severity) {
  return Cesium.Color.fromCssColorString(driveBcSeverityStyle(severity).color);
}

function eventName(event) {
  return event.headline || event.eventType || 'BC road event';
}

function eventDescription(event) {
  const parts = [
    `<strong>${escapeHtml(eventName(event))}</strong>`,
    event.eventType ? `Type: ${escapeHtml(event.eventType)}` : '',
    event.severity ? `Severity: ${escapeHtml(event.severity)}` : '',
    event.description ? escapeHtml(event.description) : '',
    event.updated ? `Updated: ${escapeHtml(event.updated)}` : '',
    event.url
      ? `<a href="${escapeHtml(event.url)}" target="_blank" rel="noopener noreferrer">DriveBC event details</a>`
      : '',
    '<small>DriveBC Open511 · British Columbia</small>',
  ].filter(Boolean);
  return `<div>${parts.join('<br>')}</div>`;
}

/** Keep endpoints and evenly spaced vertices, bounding per-feature GPU geometry. */
export function decimateDriveBcLine(
  coordinates,
  maxPoints = MAX_RENDER_LINE_POINTS,
) {
  if (!Array.isArray(coordinates)) return [];
  const valid = coordinates.filter(
    (point) =>
      Array.isArray(point) &&
      Number.isFinite(point[0]) &&
      Math.abs(point[0]) <= 180 &&
      Number.isFinite(point[1]) &&
      Math.abs(point[1]) <= 90,
  );
  if (valid.length <= maxPoints) return valid;
  const result = [];
  for (let index = 0; index < maxPoints; index += 1) {
    const sourceIndex = Math.round(
      (index * (valid.length - 1)) / (maxPoints - 1),
    );
    result.push(valid[sourceIndex]);
  }
  return result;
}

function eventEntities(event) {
  if (!event || typeof event.id !== 'string' || !event.geometry) return [];
  const color = severityColor(event.severity);
  const properties = {
    drivebcId: event.id,
    eventType: event.eventType || null,
    subtypes: Array.isArray(event.subtypes) ? event.subtypes.join(', ') : null,
    severity: event.severity || null,
    updated: event.updated || null,
    source: 'DriveBC Open511 (British Columbia)',
  };
  const common = {
    name: eventName(event),
    description: eventDescription(event),
    properties,
  };
  if (event.geometry.type === 'Point') {
    const [lon, lat] = event.geometry.coordinates || [];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return [];
    return [
      new Cesium.Entity({
        ...common,
        id: `drivebc:${event.id}:point`,
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        point: {
          pixelSize: 11,
          color,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }),
    ];
  }
  const lines =
    event.geometry.type === 'LineString'
      ? [event.geometry.coordinates]
      : event.geometry.type === 'MultiLineString'
        ? event.geometry.coordinates
        : [];
  const entities = [];
  for (const [index, rawLine] of lines.entries()) {
    const line = decimateDriveBcLine(rawLine);
    if (line.length < 2) continue;
    const positions = Cesium.Cartesian3.fromDegreesArray(line.flat());
    entities.push(
      new Cesium.Entity({
        ...common,
        id: `drivebc:${event.id}:line:${index}`,
        polyline: {
          positions,
          width: 5,
          material: color,
          clampToGround: true,
        },
      }),
    );
  }
  return entities;
}

/** Own the DriveBC road-event overlay and its bounded refresh lifecycle. */
export function createDriveBcLayer({
  source,
  createClickHandler = (canvas) => new Cesium.ScreenSpaceEventHandler(canvas),
  createEventPopup = (container) =>
    container?.ownerDocument ? createDriveBcEventPopup({ container }) : null,
  isPointerFree = defaultIsPointerFree,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('DriveBC road events require a snapshot source');

  let viewer = null;
  let dataSource = null;
  let request = null;
  let clickHandler = null;
  let eventPopup = null;
  let eventsById = new Map();
  let enabled = false;
  let loading = false;
  let count = 0;
  let lastUpdate = null;
  let lastError = null;
  let stale = false;
  let partial = false;

  function onClick(click) {
    if (!enabled || !viewer || !isPointerFree()) return;
    let picked = null;
    try {
      picked = viewer.scene.pick(click.position);
    } catch {
      eventPopup?.hide();
      return;
    }
    const pickedEntity =
      picked?.id && typeof picked.id === 'object' ? picked.id : null;
    const pickedId =
      typeof picked?.id === 'string'
        ? picked.id
        : typeof pickedEntity?.id === 'string'
          ? pickedEntity.id
          : typeof picked?.primitive?.id === 'string'
            ? picked.primitive.id
            : typeof picked?.primitive?.id?.id === 'string'
              ? picked.primitive.id.id
              : null;
    if (!pickedId?.startsWith('drivebc:')) {
      eventPopup?.hide();
      return;
    }
    const entity =
      pickedEntity || dataSource?.entities?.getById?.(pickedId) || null;
    const property = entity?.properties?.drivebcId;
    const eventId =
      typeof property?.getValue === 'function'
        ? property.getValue(viewer.clock?.currentTime)
        : property;
    const event = typeof eventId === 'string' ? eventsById.get(eventId) : null;
    if (event) eventPopup?.show(event, click.position);
    else eventPopup?.hide();
  }

  return {
    id: LAYER_ID,
    name: 'DriveBC Road Conditions',
    icon: '🚧',
    source: 'DriveBC Open511',
    updateInterval: 60_000,

    init(targetViewer) {
      if (viewer) throw new Error('DriveBC road layer is already initialized');
      viewer = targetViewer;
      dataSource = new Cesium.CustomDataSource('drivebc-road-conditions');
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      eventPopup = createEventPopup(viewer.container);
      if (viewer.scene?.canvas) {
        clickHandler = createClickHandler(viewer.scene.canvas);
        clickHandler?.setInputAction?.(
          onClick,
          Cesium.ScreenSpaceEventType.LEFT_CLICK,
        );
      }
      eventsById = new Map();
      enabled = false;
      count = 0;
      lastUpdate = null;
      lastError = null;
      stale = false;
      partial = false;
    },

    enable() {
      enabled = true;
      registerPickOwner(LAYER_ID, ownsDriveBcPick);
      if (dataSource) dataSource.show = true;
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      unregisterPickOwner(LAYER_ID);
      eventPopup?.hide();
      if (dataSource) dataSource.show = false;
    },

    async update() {
      if (!enabled || !dataSource) return false;
      request?.abort();
      const current = new AbortController();
      request = current;
      loading = true;
      try {
        const snapshot = await source.getSnapshot({ signal: current.signal });
        if (current.signal.aborted || request !== current || !enabled)
          return false;
        if (!Array.isArray(snapshot?.events))
          throw new Error('Malformed DriveBC snapshot');
        const entities = snapshot.events.flatMap(eventEntities);
        if (current.signal.aborted || request !== current || !enabled)
          return false;
        dataSource.entities.removeAll();
        for (const entity of entities) dataSource.entities.add(entity);
        eventsById = new Map(snapshot.events.map((event) => [event.id, event]));
        count = snapshot.events.length;
        lastUpdate = Number.isFinite(snapshot.fetchedAt)
          ? snapshot.fetchedAt
          : Date.now();
        stale = snapshot.stale === true;
        partial = snapshot.partial === true;
        lastError = stale ? 'Showing a recent cached DriveBC snapshot' : null;
        return true;
      } catch (error) {
        if (current.signal.aborted || request !== current || !enabled)
          return false;
        lastError = error?.message || 'DriveBC data unavailable';
        return false;
      } finally {
        if (request === current) {
          request = null;
          loading = false;
        }
      }
    },

    getRowControls() {
      return {
        legend: DRIVEBC_SEVERITY_STYLES.map(({ label, color, colorName }) => ({
          label,
          color,
          blurb: `${label} severity · ${colorName}`,
        })),
        info: 'Road color shows DriveBC event severity, not traffic speed.',
      };
    },

    getStats() {
      return {
        count,
        lastUpdate,
        error: lastError,
        loading,
        stale,
        partial,
      };
    },

    destroy(targetViewer = viewer) {
      request?.abort();
      request = null;
      enabled = false;
      loading = false;
      unregisterPickOwner(LAYER_ID);
      clickHandler?.destroy?.();
      clickHandler = null;
      eventPopup?.destroy?.();
      eventPopup = null;
      eventsById.clear();
      if (dataSource) {
        targetViewer?.dataSources?.remove(dataSource, true);
        dataSource = null;
      }
      viewer = null;
      count = 0;
      lastUpdate = null;
      lastError = null;
      stale = false;
      partial = false;
    },
  };
}
