import * as Cesium from 'cesium';
import {
  feedProvenanceEnvelope,
  layerSnapshots,
  viewStateLayerRow,
} from '../data/layerSnapshot.js';
import { contextModeWord } from '../contextModePolicy.js';

const TRACKABLE_FAMILIES = Object.freeze([
  { layerId: 'flights', kind: 'aircraft' },
  { layerId: 'military', kind: 'aircraft' },
  { layerId: 'ais-live-vessels', kind: 'vessel' },
  { layerId: 'satellites', kind: 'satellite' },
]);

const CONTEXT_MODE_RESULT_FIELDS = Object.freeze([
  { field: 'mode', emptyAs: 'off' },
  { field: 'entering', emptyAs: null },
  { field: 'priorMode', emptyAs: null },
]);

const NESTED_CONTEXT_RESULT_FIELDS = Object.freeze([
  'context',
  'contextRollback',
]);

const NON_SEMANTIC_PACKET_KEYS = new Set([
  'note',
  'ageLabel',
  'generatedAt',
]);

function semanticPacketValue(value) {
  if (Array.isArray(value)) return value.map(semanticPacketValue);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (NON_SEMANTIC_PACKET_KEYS.has(key)) continue;
    out[key] = semanticPacketValue(value[key]);
  }
  return out;
}

/**
 * Stable semantic fingerprint for change detection, not authentication.
 *
 * Presentation-only narration/age labels are excluded. Feed state, source,
 * lastUpdate, camera, context, tracked entities, and other semantic state stay
 * inside the digest.
 */
export function semanticWorldPacketFingerprint(packet) {
  const canonical = JSON.stringify(semanticPacketValue(packet));
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= BigInt(canonical.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

/**
 * Translate context-mode payloads into the public tool vocabulary while
 * retaining the internal id beside each translated field.
 */
export function withContextModeVocabulary(state) {
  if (!state || typeof state !== 'object') return state;
  let out = state;
  const mutable = () => {
    if (out === state) out = { ...state };
    return out;
  };
  for (const { field, emptyAs } of CONTEXT_MODE_RESULT_FIELDS) {
    if (!(field in state)) continue;
    const internal = state[field] ?? null;
    const target = mutable();
    target[field] = contextModeWord(internal, { emptyAs });
    target[`${field}Internal`] = internal;
  }
  for (const field of NESTED_CONTEXT_RESULT_FIELDS) {
    const nested = state[field];
    if (!nested || typeof nested !== 'object') continue;
    const translated = withContextModeVocabulary(nested);
    if (translated !== nested) mutable()[field] = translated;
  }
  return out;
}

/** Read tracked entities from their canonical layer owners. */
export function collectTrackedEntities(dataManager) {
  const tracked = [];
  for (const family of TRACKABLE_FAMILIES) {
    const module = dataManager?.layers?.get(family.layerId)?.module;
    if (!module) continue;
    try {
      const info =
        family.kind === 'vessel'
          ? module.getSelectedInfo?.()
          : module.getTrackedInfo?.();
      if (info)
        tracked.push({
          kind: family.kind,
          layerId: family.layerId,
          ...info,
        });
    } catch {
      // A not-yet-ready layer contributes no tracked observation.
    }
  }
  return tracked;
}

/** Read the active Contacts window from its owning awareness layer. */
export function activeContactsWindow(dataManager) {
  try {
    const layer = dataManager?.layers?.get('military-awareness')?.module;
    return (
      layer?.contactsWindowFromSnapshot?.(layer.getContextSnapshot?.()) ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Build the model-free fast World Packet from existing application owners.
 *
 * This performs no network requests and intentionally mirrors the historical
 * get_current_view_state payload so voice can delegate without behavior drift.
 */
export function getWorldPacket({
  viewer,
  styleManager,
  dataManager,
  sceneDirector = null,
  now = Date.now(),
} = {}) {
  if (!viewer?.camera?.positionWC)
    throw new TypeError('World Packet requires a viewer camera');
  if (!dataManager || typeof dataManager.getAll !== 'function')
    throw new TypeError('World Packet requires a data manager');

  const cartographic = Cesium.Cartographic.fromCartesian(
    viewer.camera.positionWC,
  );
  const rows = dataManager.getAll();
  const contactsWindow = activeContactsWindow(dataManager);
  const contextState =
    typeof styleManager?.getContextModeState === 'function'
      ? withContextModeVocabulary(styleManager.getContextModeState())
      : null;

  return {
    ok: true,
    action: 'get_current_view_state',
    camera: {
      latitude: Cesium.Math.toDegrees(cartographic.latitude),
      longitude: Cesium.Math.toDegrees(cartographic.longitude),
      heightM: cartographic.height,
    },
    style: styleManager?.activeStyle || 'normal',
    context: contextState
      ? {
          ...contextState,
          ...(contactsWindow ? { contactsWindow } : {}),
        }
      : null,
    cockpit:
      typeof styleManager?.getCockpitState === 'function'
        ? styleManager.getCockpitState()
        : null,
    controls:
      typeof styleManager?.getControlState === 'function'
        ? styleManager.getControlState()
        : null,
    scenePlayback: sceneDirector?.getPlaybackStatus?.() || null,
    tracked: collectTrackedEntities(dataManager),
    layers: rows.map((layer) => viewStateLayerRow(layer, { now })),
    feedProvenance: feedProvenanceEnvelope(
      layerSnapshots(rows, { now }).filter((layer) => layer.enabled),
      { now },
    ),
  };
}
