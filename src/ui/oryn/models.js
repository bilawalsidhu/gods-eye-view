// Typed ORYN prototype records and their validators. Every record that
// crosses the storage boundary passes through one of these so a corrupted or
// hand-edited localStorage entry can never reach the UI half-formed.
import {
  cleanText,
  isIsoTimestamp,
  isValidLatitude,
  isValidLongitude,
  isFiniteNumber,
  newId,
} from './store.js';

/**
 * Where a statement came from. The inspector renders each kind differently so
 * a measured value is never confused with a provider claim, a model output,
 * an analyst note, or an unverified hypothesis.
 */
export const PROVENANCE_KINDS = Object.freeze([
  'measured',
  'provider',
  'model',
  'analyst',
  'unverified',
]);

export const INVESTIGATION_STATUSES = Object.freeze([
  'open',
  'in-review',
  'closed',
]);

/** @typedef {{lon:number,lat:number,height?:number}} GeoPoint */

export function validateGeoPoint(value) {
  if (!value || typeof value !== 'object') return null;
  if (!isValidLongitude(value.lon) || !isValidLatitude(value.lat)) return null;
  const point = { lon: value.lon, lat: value.lat };
  if (isFiniteNumber(value.height)) point.height = value.height;
  return point;
}

export function cleanUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** A reference to something on the globe: an entity, an event, or a place. */
export function validateEntityRef(value) {
  if (!value || typeof value !== 'object') return null;
  const kind = cleanText(value.kind, 64);
  const id = cleanText(value.id, 256);
  if (!kind || !id) return null;
  const ref = { kind, id };
  const label = cleanText(value.label, 256);
  if (label) ref.label = label;
  const layerId = cleanText(value.layerId, 64);
  if (layerId) ref.layerId = layerId;
  const position = validateGeoPoint(value.position);
  if (position) ref.position = position;
  const source = cleanText(value.source, 256);
  if (source) ref.source = source;
  const sourceUrl = cleanUrl(value.sourceUrl);
  if (sourceUrl) ref.sourceUrl = sourceUrl;
  if (isIsoTimestamp(value.observedAt)) ref.observedAt = value.observedAt;
  if (isIsoTimestamp(value.retrievedAt)) ref.retrievedAt = value.retrievedAt;
  const provenance = cleanText(value.provenance, 32);
  ref.provenance = PROVENANCE_KINDS.includes(provenance)
    ? provenance
    : 'provider';
  if (value.fields && typeof value.fields === 'object') {
    const fields = {};
    for (const [key, raw] of Object.entries(value.fields).slice(0, 40)) {
      const name = cleanText(key, 64);
      if (!name) continue;
      if (isFiniteNumber(raw) || typeof raw === 'boolean') fields[name] = raw;
      else {
        const text = cleanText(raw, 512);
        if (text) fields[name] = text;
      }
    }
    ref.fields = fields;
  }
  return ref;
}

function timestampsOf(value, now = new Date().toISOString()) {
  const createdAt = isIsoTimestamp(value.createdAt) ? value.createdAt : now;
  const updatedAt = isIsoTimestamp(value.updatedAt) ? value.updatedAt : now;
  return { createdAt, updatedAt };
}

/**
 * A saved scene captures only what the engine can restore: the camera, the
 * enabled layers and their serialized options, the active mode, the
 * selection reference, the panel state and the investigation context.
 */
export function validateScene(value) {
  if (!value || typeof value !== 'object') return null;
  const name = cleanText(value.name, 160);
  if (!name) return null;
  const camera =
    value.camera && typeof value.camera === 'object' ? value.camera : null;
  if (!camera) return null;
  const position = validateGeoPoint(camera.position);
  if (!position || !isFiniteNumber(position.height)) return null;
  const orientation = {
    heading: isFiniteNumber(camera.heading) ? camera.heading : 0,
    pitch: isFiniteNumber(camera.pitch) ? camera.pitch : -Math.PI / 2,
    roll: isFiniteNumber(camera.roll) ? camera.roll : 0,
  };
  const enabledLayers = Array.isArray(value.enabledLayers)
    ? value.enabledLayers
        .map((id) => cleanText(id, 64))
        .filter(Boolean)
        .slice(0, 64)
    : [];
  return {
    id: cleanText(value.id, 128) || newId('scene'),
    name,
    organizationId: cleanText(value.organizationId, 128) || null,
    camera: { position, ...orientation },
    enabledLayers,
    layerState:
      typeof value.layerState === 'string'
        ? value.layerState.slice(0, 4096)
        : null,
    mode: cleanText(value.mode, 64) || 'globe',
    selection: validateEntityRef(value.selection),
    panels: {
      inspector: value.panels?.inspector === true,
      layers: value.panels?.layers === true,
      timeline: value.panels?.timeline === true,
    },
    investigationId: cleanText(value.investigationId, 128) || null,
    time: isIsoTimestamp(value.time) ? value.time : null,
    ...timestampsOf(value),
  };
}

export function validateNote(value) {
  if (!value || typeof value !== 'object') return null;
  const body = cleanText(value.body, 8000);
  if (!body) return null;
  return {
    id: cleanText(value.id, 128) || newId('note'),
    body,
    author: cleanText(value.author, 160) || 'analyst',
    provenance: 'analyst',
    position: validateGeoPoint(value.position),
    target: validateEntityRef(value.target),
    investigationId: cleanText(value.investigationId, 128) || null,
    ...timestampsOf(value),
  };
}

export function validateTimelineEntry(value) {
  if (!value || typeof value !== 'object') return null;
  const at = isIsoTimestamp(value.at) ? value.at : null;
  const text = cleanText(value.text, 2000);
  if (!at || !text) return null;
  const kind = cleanText(value.kind, 32) || 'note';
  const provenance = cleanText(value.provenance, 32);
  return {
    id: cleanText(value.id, 128) || newId('entry'),
    at,
    text,
    kind,
    provenance: PROVENANCE_KINDS.includes(provenance) ? provenance : 'analyst',
    ref: validateEntityRef(value.ref),
  };
}

export function validateInvestigation(value) {
  if (!value || typeof value !== 'object') return null;
  const title = cleanText(value.title, 200);
  if (!title) return null;
  const status = INVESTIGATION_STATUSES.includes(value.status)
    ? value.status
    : 'open';
  const entities = (Array.isArray(value.entities) ? value.entities : [])
    .map(validateEntityRef)
    .filter(Boolean)
    .slice(0, 200);
  const timeline = (Array.isArray(value.timeline) ? value.timeline : [])
    .map(validateTimelineEntry)
    .filter(Boolean)
    .slice(0, 500);
  const sceneIds = (Array.isArray(value.sceneIds) ? value.sceneIds : [])
    .map((id) => cleanText(id, 128))
    .filter(Boolean)
    .slice(0, 50);
  return {
    id: cleanText(value.id, 128) || newId('inv'),
    title,
    summary: cleanText(value.summary, 8000) || '',
    status,
    organizationId: cleanText(value.organizationId, 128) || null,
    owner: cleanText(value.owner, 160) || null,
    entities,
    timeline,
    sceneIds,
    ...timestampsOf(value),
  };
}

export function validateSession(value) {
  if (!value || typeof value !== 'object') return null;
  const user = cleanText(value.user, 160);
  const organization = cleanText(value.organization, 160);
  if (!user || !organization) return null;
  return {
    user,
    organization,
    organizationId: cleanText(value.organizationId, 128) || 'demo-org',
    role: cleanText(value.role, 64) || 'analyst',
    workspace: cleanText(value.workspace, 64) || 'default',
    startedAt: isIsoTimestamp(value.startedAt)
      ? value.startedAt
      : new Date().toISOString(),
    // The prototype has no identity provider: this flag is always true and
    // the UI prints it so a demo session is never mistaken for real auth.
    demo: true,
  };
}
