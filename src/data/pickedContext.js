import { getContextStore, isContextRecordActive } from './contextStore.js';
import { findPickOwner, resolvePickId } from './pickRegistry.js';

/**
 * Resolve a `scene.pick()` result to the identity a person would name: which
 * layer, which record, and its display label.
 *
 * Two lanes, in order:
 *  1. Context-store carriers. Entity-backed layers (infrastructure GeoJSON,
 *     selected vessels, fires, installations) stamp `__gevContextId` on the
 *     picked object, and the store record already carries the label and
 *     position voice uses everywhere else.
 *  2. Pick owners. Primitive-backed layers (aircraft, satellites, vessels)
 *     register an ownership predicate in `pickRegistry`; the owning layer's
 *     `findByQuery` turns the pick id into a live descriptor.
 *
 * Trails claim their pick ids only to make clicks inert, so they never
 * resolve. Disabled layers never resolve: what the user cannot see is not
 * what they are pointing at.
 */

const KIND_BY_LAYER = Object.freeze({
  flights: 'aircraft',
  military: 'aircraft',
  'local-adsb': 'aircraft',
  'ais-live-vessels': 'vessel',
  satellites: 'satellite',
  'local-firms': 'fire',
});

const IGNORED_OWNERS = new Set(['trails']);

function text(value) {
  return String(value ?? '').trim();
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Kind of thing a layer holds, for deixis ("this aircraft", "this place"). */
export function pickedKindForLayer(layerId) {
  return KIND_BY_LAYER[layerId] || 'feature';
}

function contextCarrierRecord(picked, dataManager) {
  const store = getContextStore();
  for (const carrier of [
    picked?.id,
    picked?.primitive?.id,
    picked?.primitive,
  ]) {
    const contextId =
      carrier && typeof carrier === 'object' ? carrier.__gevContextId : null;
    if (!contextId) continue;
    const record = store.entities.get(contextId);
    if (record && isContextRecordActive(record, dataManager)) return record;
  }
  return null;
}

function fromRecord(record) {
  const layerId = record.layerId || null;
  const id =
    layerId === 'ais-live-vessels' && record.properties?.mmsi
      ? String(record.properties.mmsi)
      : String(record.id);
  return {
    layerId,
    id,
    label:
      text(record.label) ||
      text(record.properties?.name) ||
      text(record.layerName) ||
      id,
    kind: pickedKindForLayer(layerId),
    lat: finite(record.latitude),
    lon: finite(record.longitude),
  };
}

function descriptorLabel(found, fallback) {
  return (
    text(found?.callsign) ||
    text(found?.registration) ||
    text(found?.name) ||
    text(found?.icao24) ||
    text(found?.mmsi) ||
    text(found?.noradId) ||
    fallback
  );
}

/**
 * @param {object|null} picked Result of `scene.pick()`.
 * @param {object} [options]
 * @param {object} [options.dataManager] Layer lifecycle (enabled state, modules).
 * @returns {{layerId: string, id: string, label: string, kind: string, lat: number|null, lon: number|null, altitudeM?: number|null}|null}
 */
export function resolvePickedContext(picked, { dataManager = null } = {}) {
  if (!picked) return null;
  const record = contextCarrierRecord(picked, dataManager);
  if (record) return fromRecord(record);

  const pickId = resolvePickId(picked);
  if (!pickId) return null;
  const layerId = findPickOwner(pickId);
  if (!layerId || IGNORED_OWNERS.has(layerId)) return null;
  if (dataManager?.isEnabled && !dataManager.isEnabled(layerId)) return null;
  const layer = dataManager?.layers?.get?.(layerId);
  let found = null;
  try {
    found = layer?.module?.findByQuery?.(pickId) || null;
  } catch {
    found = null;
  }
  return {
    layerId,
    id: pickId,
    label: descriptorLabel(found, text(layer?.name) || pickId),
    kind: pickedKindForLayer(layerId),
    lat: finite(found?.latitude),
    lon: finite(found?.longitude),
    altitudeM: finite(found?.altitudeM),
  };
}
